#include "chartbay/table.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace chartbay {
namespace {

// Bytes buffered before the dialect is sniffed and parsing starts.
constexpr std::size_t kSniffBytes = 128 * 1024;
// Ceiling on the distinct-value set kept while profiling a text column.
constexpr std::size_t kUniqueCap = 10000;
// A column needs at least this many observations before quartile-based outlier
// bounds mean anything.
constexpr std::size_t kMinOutlierObs = 8;
// Hard stop on dictionary growth for a categorical column whose tail turns out
// to be far more varied than its sample suggested.
constexpr std::size_t kMaxLevels = 100000;
// "No hay tal columna", para la busqueda del indice temporal.
constexpr std::size_t kNoColumn = static_cast<std::size_t>(-1);

std::uint64_t fnv1a(std::uint64_t h, std::string_view s) {
  for (char c : s) {
    h ^= static_cast<unsigned char>(c);
    h *= 1099511628211ULL;
  }
  return h;
}

bool has_non_digit(std::string_view s) {
  for (char c : s) {
    if (c < '0' || c > '9') return true;
  }
  return false;
}

double quantile(const std::vector<double>& sorted, double q) {
  if (sorted.empty()) return 0.0;
  if (sorted.size() == 1) return sorted[0];
  const double pos = q * static_cast<double>(sorted.size() - 1);
  const auto lo = static_cast<std::size_t>(pos);
  const std::size_t hi = std::min(lo + 1, sorted.size() - 1);
  const double frac = pos - static_cast<double>(lo);
  return sorted[lo] * (1.0 - frac) + sorted[hi] * frac;
}

std::string plural(std::size_t n, const std::string& one, const std::string& many) {
  return std::to_string(n) + " " + (n == 1 ? one : many);
}

// Cuantas filas del final se miran buscando un pie de tabla. Tres alcanzan para
// el caso habitual — total, o total y una nota debajo — y acotan el riesgo: una
// fila legitima que se parezca a un subtotal solo puede confundirse si esta
// pegada al final del archivo.
constexpr std::size_t kFooterWindow = 3;
// Terminos que la suma tiene que tener encima para que la coincidencia
// signifique algo. Con dos valores, que el tercero sea la suma es casualidad
// barata; con "0" en todos, es aritmetica trivial.
constexpr std::size_t kMinFooterTerms = 3;

bool iequals_ascii(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) return false;
  for (std::size_t i = 0; i < a.size(); ++i) {
    char ca = a[i], cb = b[i];
    if (ca >= 'A' && ca <= 'Z') ca = static_cast<char>(ca - 'A' + 'a');
    if (cb >= 'A' && cb <= 'Z') cb = static_cast<char>(cb - 'A' + 'a');
    if (ca != cb) return false;
  }
  return true;
}

// La etiqueta con la que una planilla cierra una tabla. Se compara sin
// distinguir mayusculas y sin la puntuacion que suele colgar del final
// ("TOTAL:", "Total."), que es como aparece la mitad de las veces.
bool is_total_label(std::string_view raw) {
  static constexpr std::string_view kLabels[] = {
      "total",     "totales",  "totals",    "total general", "gran total", "grand total",
      "subtotal",  "sub total", "subtotales", "suma",        "suma total", "sumatoria",
      "sum",       "promedio", "average",   "media",         "totale",     "somme",
  };
  std::string_view s = trim(raw);
  while (!s.empty() && (s.back() == ':' || s.back() == '.' || s.back() == '=')) {
    s.remove_suffix(1);
    s = trim(s);
  }
  if (s.empty()) return false;
  for (std::string_view label : kLabels) {
    if (iequals_ascii(s, label)) return true;
  }
  return false;
}

// Open-addressed set of 64-bit row hashes, used only for duplicate detection.
// std::unordered_set does one heap allocation per element, which on a
// multi-million-row file is both the single hottest call in ingestion and tens
// of megabytes of node overhead. This is one flat array.
//
// Being a hash-only set, two different rows sharing a hash would look like
// duplicates. At 64 bits that is ~3e-6 for ten million rows; the alternative is
// keeping every row in memory, which is the thing this library exists to avoid.
class RowHashSet {
 public:
  RowHashSet() : slots_(1024, 0) {}

  void reserve(std::size_t expected) {
    std::size_t want = 16;
    while (want * 3 < expected * 4) want *= 2;
    if (want <= slots_.size()) return;
    std::vector<std::uint64_t> bigger(want, 0);
    for (std::uint64_t key : slots_) {
      if (key == 0) continue;
      std::size_t i = key & (bigger.size() - 1);
      while (bigger[i] != 0) i = (i + 1) & (bigger.size() - 1);
      bigger[i] = key;
    }
    slots_.swap(bigger);
  }

  bool insert(std::uint64_t key) {
    if (key == 0) key = 0x9E3779B97F4A7C15ULL;  // 0 marks an empty slot
    if ((size_ + 1) * 4 >= slots_.size() * 3) grow();
    std::size_t i = key & (slots_.size() - 1);
    while (slots_[i] != 0) {
      if (slots_[i] == key) return false;
      i = (i + 1) & (slots_.size() - 1);
    }
    slots_[i] = key;
    ++size_;
    return true;
  }

 private:
  void grow() {
    std::vector<std::uint64_t> bigger(slots_.size() * 2, 0);
    for (std::uint64_t key : slots_) {
      if (key == 0) continue;
      std::size_t i = key & (bigger.size() - 1);
      while (bigger[i] != 0) i = (i + 1) & (bigger.size() - 1);
      bigger[i] = key;
    }
    slots_.swap(bigger);
  }

  std::vector<std::uint64_t> slots_;
  std::size_t size_ = 0;
};

}  // namespace

const char* type_name(ColumnType t) {
  switch (t) {
    case ColumnType::Empty: return "empty";
    case ColumnType::Numeric: return "numeric";
    case ColumnType::Date: return "date";
    case ColumnType::Categorical: return "categorical";
    case ColumnType::Text: return "text";
  }
  return "text";
}

const char* frequency_code(TimeFrequency f) {
  switch (f) {
    case TimeFrequency::Daily: return "daily";
    case TimeFrequency::BusinessDaily: return "business_daily";
    case TimeFrequency::Weekly: return "weekly";
    case TimeFrequency::Fortnightly: return "fortnightly";
    case TimeFrequency::Monthly: return "monthly";
    case TimeFrequency::Quarterly: return "quarterly";
    case TimeFrequency::Semiannual: return "semiannual";
    case TimeFrequency::Annual: return "annual";
    case TimeFrequency::Unknown: break;
  }
  return "unknown";
}

const char* frequency_label(TimeFrequency f) {
  switch (f) {
    case TimeFrequency::Daily: return "diaria";
    case TimeFrequency::BusinessDaily: return "de días hábiles";
    case TimeFrequency::Weekly: return "semanal";
    case TimeFrequency::Fortnightly: return "quincenal";
    case TimeFrequency::Monthly: return "mensual";
    case TimeFrequency::Quarterly: return "trimestral";
    case TimeFrequency::Semiannual: return "semestral";
    case TimeFrequency::Annual: return "anual";
    case TimeFrequency::Unknown: break;
  }
  return "irregular";
}

const char* action_code(ActionKind k) {
  switch (k) {
    case ActionKind::InferredDialect: return "inferred_dialect";
    case ActionKind::InferredDecimal: return "inferred_decimal";
    case ActionKind::InferredDateOrder: return "inferred_date_order";
    case ActionKind::AmbiguousDecimal: return "ambiguous_decimal";
    case ActionKind::AmbiguousDateOrder: return "ambiguous_date_order";
    case ActionKind::PaddedRaggedRow: return "padded_ragged_row";
    case ActionKind::TruncatedRaggedRow: return "truncated_ragged_row";
    case ActionKind::SkippedPreambleRows: return "skipped_preamble_rows";
    case ActionKind::DroppedFooterRows: return "dropped_footer_rows";
    case ActionKind::ConvertedEncoding: return "converted_encoding";
    case ActionKind::UnifiedLevels: return "unified_levels";
    case ActionKind::SortedByTime: return "sorted_by_time";
    case ActionKind::UnsupportedEncoding: return "unsupported_encoding";
    case ActionKind::DroppedEmptyRows: return "dropped_empty_rows";
    case ActionKind::DroppedDuplicateRows: return "dropped_duplicate_rows";
    case ActionKind::DroppedEmptyColumn: return "dropped_empty_column";
    case ActionKind::DroppedConstantColumn: return "dropped_constant_column";
    case ActionKind::DroppedDuplicateColumn: return "dropped_duplicate_column";
    case ActionKind::RenamedColumn: return "renamed_column";
    case ActionKind::CoercedInvalid: return "coerced_invalid";
    case ActionKind::ImputedMissing: return "imputed_missing";
    case ActionKind::DroppedMissingRows: return "dropped_missing_rows";
    case ActionKind::FlaggedOutliers: return "flagged_outliers";
    case ActionKind::WinsorizedOutliers: return "winsorized_outliers";
    case ActionKind::OutliersToMissing: return "outliers_to_missing";
    case ActionKind::DroppedOutlierRows: return "dropped_outlier_rows";
    case ActionKind::MalformedQuotes: return "malformed_quotes";
    case ActionKind::UnterminatedQuote: return "unterminated_quote";
  }
  return "unknown";
}

std::size_t Column::size() const { return mask.size(); }

std::string format_number(double v) {
  if (!std::isfinite(v)) return "";
  if (v == static_cast<double>(static_cast<long long>(v)) && std::fabs(v) < 1e15) {
    char buf[32];
    std::snprintf(buf, sizeof buf, "%lld", static_cast<long long>(v));
    return buf;
  }
  // Shortest of the three that still round-trips exactly.
  char buf[40];
  for (int precision = 15; precision <= 17; ++precision) {
    std::snprintf(buf, sizeof buf, "%.*g", precision, v);
    if (std::strtod(buf, nullptr) == v) break;
  }
  return buf;
}

// ── Cleaner ───────────────────────────────────────────────────────────────────

class Cleaner::Sink : public RowSink {
 public:
  explicit Sink(CleanOptions options) : opts_(std::move(options)) {}

  void feed(const char* data, std::size_t len) {
    if (!opts_.fix_encoding) {
      feed_bytes(data, len);
      return;
    }
    // Todo pasa primero por el arreglo de encoding, incluida la ventana que
    // usa el sniffer: si el archivo esta en Windows-1252, lo que tiene que ver
    // el resto del pipeline ya es UTF-8. Un archivo correcto sale de aca sin
    // que se le copie un byte.
    const std::string_view fixed = encoding_.feed(data, len);
    if (!fixed.empty()) feed_bytes(fixed.data(), fixed.size());
  }

  void feed_bytes(const char* data, std::size_t len) {
    if (!started_) {
      pre_.append(data, len);
      if (pre_.size() < kSniffBytes) return;
      start();
      return;
    }
    scanner_->feed(data, len);
  }

  CleanResult finish() {
    if (opts_.fix_encoding) {
      const std::string_view tail = encoding_.finish();
      if (!tail.empty()) feed_bytes(tail.data(), tail.size());
    }
    if (!started_) start();
    scanner_->finish();
    if (sampling_) {
      // Antes de votar los tipos, no después: una fila "TOTAL" adentro de la
      // muestra no solo mueve la media, baja la proporción de celdas que
      // parsean. En un archivo de seis filas eso deja la columna de fechas en
      // 5/6 = 0,83, por debajo del umbral de 0,9, y la columna entera termina
      // tipada como texto por culpa del pie.
      if (opts_.drop_footer_rows) drop_footer_in_sample();
      resolve_types();
      flush_sample();
      sampling_ = false;
    }

    // Antes de cualquier estadístico: el conteo de únicos de una categórica es
    // la cantidad de niveles, y esta es la que decide cuántos hay.
    unify_levels();

    if (opts_.scan_only) {
      // Nothing was materialised, so there is nothing to sort, compact,
      // impute or compare. The moments were accumulated as the rows went by.
      finalize_scan_stats();
      rows_out_ = rows_kept_;
      drop_columns();
    } else {
      // Y acá otra vez, ahora con los números parseados: el pie tiene que irse
      // antes de que se calcule un solo estadístico, porque los cuantiles que
      // salgan de él son los que después deciden qué es un atípico.
      if (opts_.drop_footer_rows) drop_footer_in_columns();
      // Ordenar va antes de imputar: el arrastre copia el último valor
      // anterior, y sobre filas desordenadas "anterior" no quiere decir nada.
      if (opts_.sort_by_time) sort_by_time();
      compute_stats();
      std::vector<std::uint8_t> keep(rows_kept_, 1);
      apply_outliers(keep);
      apply_missing(keep);
      compact(keep);
      // Profiling every numeric column means sorting it. On the default path
      // (flag outliers, keep missing) nothing above touches a value, so the
      // second pass would sort millions of doubles to reproduce what we have.
      if (values_changed_) compute_stats();
      // Y analizar va al final, sobre las filas que efectivamente quedaron: si
      // una política de faltantes eliminó filas, los huecos que hay que
      // reportar son los del archivo que se lleva el usuario.
      if (opts_.analyze_time_index) analyze_time_index();
      drop_columns();
    }
    emit_actions();

    CleanResult result;
    result.dialect = dialect_;
    result.time_index = std::move(time_index_);
    result.rows_in = rows_in_;
    result.rows_out = rows_out_;
    result.quote_anomalies = scanner_->quote_anomalies();
    result.unterminated_quote = scanner_->unterminated_quote();
    result.columns = std::move(cols_);
    result.actions = std::move(actions_);
    return result;
  }

 private:
  // Una escritura vista en el archivo: a qué nivel fue a parar, cuántas veces
  // apareció y en qué orden se la vio. Lo segundo elige el nivel que se muestra
  // y lo tercero desempata, para que el resultado no dependa del orden en que
  // el unordered_map decida iterar.
  struct LevelEntry {
    std::int32_t code = -1;
    std::size_t count = 0;
    std::size_t seq = 0;
  };

  // Evidence collected over the sample for one column, before its type is set.
  struct ColumnVotes {
    NumberFormatVotes numbers;
    DateOrderVotes dates;
    std::unordered_set<std::string> uniq;
    bool uniq_capped = false;
    std::size_t non_missing = 0;
  };

  // ── Startup ────────────────────────────────────────────────────────────────

  void start() {
    started_ = true;
    const std::string_view body = strip_bom(pre_);
    if (opts_.sniff) {
      dialect_ = sniff_dialect(body.substr(0, std::min(body.size(), kSniffBytes)));
      // Un preambulo puesto a mano gana sobre el detectado: quien ya abrio el
      // archivo y conto las lineas sabe mas que la heuristica. El interruptor
      // solo apaga la deteccion, no pisa lo que el usuario escribio.
      if (opts_.dialect.preamble_rows > 0) {
        dialect_.preamble_rows = opts_.dialect.preamble_rows;
      } else if (!opts_.detect_preamble) {
        dialect_.preamble_rows = 0;
      }
    } else {
      dialect_ = opts_.dialect;
    }
    scanner_ = std::make_unique<CsvScanner>(dialect_, *this);
    scanner_->feed(body.data(), body.size());
    pre_.clear();
    pre_.shrink_to_fit();
  }

  void on_row(const std::string_view* fields, std::size_t n) override {
    // El preambulo se va antes que nada. No es encabezado ni dato: si entrara
    // al conteo aparecería como una fila rota más, y sus celdas votarían el
    // tipo de columnas a las que no pertenece.
    if (preamble_skipped_ < dialect_.preamble_rows) {
      ++preamble_skipped_;
      return;
    }
    if (dialect_.has_header && !header_taken_) {
      header_taken_ = true;
      raw_names_.reserve(n);
      for (std::size_t i = 0; i < n; ++i) raw_names_.emplace_back(fields[i]);
      width_ = std::max(width_, n);
      return;
    }
    ++rows_in_;

    if (sampling_) {
      std::vector<std::string> row;
      row.reserve(n);
      for (std::size_t i = 0; i < n; ++i) row.emplace_back(fields[i]);
      width_ = std::max(width_, n);
      sample_cells_ += n;
      for (std::size_t i = 0; i < n; ++i) sample_bytes_ += fields[i].size() + 1;
      sample_.push_back(std::move(row));
      if (sample_.size() >= opts_.sample_rows || sample_cells_ >= opts_.sample_cells) {
        resolve_types();
        flush_sample();
        sampling_ = false;
      }
      return;
    }
    append_row(fields, n);
  }

  // ── Names ──────────────────────────────────────────────────────────────────

  void finalize_names() {
    std::unordered_set<std::string> used;
    names_.resize(ncols_);
    raw_names_.resize(ncols_);
    for (std::size_t j = 0; j < ncols_; ++j) {
      std::string name(trim(strip_bom(raw_names_[j])));
      if (name.empty()) name = "col_" + std::to_string(j + 1);
      const std::string base = name;
      for (int suffix = 2; !used.insert(name).second; ++suffix) {
        name = base + "_" + std::to_string(suffix);
      }
      names_[j] = name;
    }
  }

  // ── Type inference ─────────────────────────────────────────────────────────

  void resolve_types() {
    if (dialect_.has_header) {
      // Rows wider than the header keep their extra columns; they just get
      // invented names rather than being silently thrown away.
      ncols_ = std::max(raw_names_.size(), modal_width());
    } else {
      raw_names_.clear();
      ncols_ = modal_width();
    }
    if (ncols_ == 0) return;

    finalize_names();
    cols_.resize(ncols_);
    level_index_.resize(ncols_);
    key_index_.resize(ncols_);
    scan_m2_.assign(ncols_, 0.0);

    // Phase 1 — gather evidence, per column and for the file as a whole.
    std::vector<ColumnVotes> votes(ncols_);
    NumberFormatVotes file_numbers;
    DateOrderVotes file_dates;
    for (const auto& row : sample_) {
      for (std::size_t j = 0; j < ncols_ && j < row.size(); ++j) {
        const std::string_view cell = trim(row[j]);
        if (is_missing_token(cell)) continue;
        ColumnVotes& v = votes[j];
        ++v.non_missing;
        v.numbers.observe(cell);
        v.dates.observe(cell);
        if (!v.uniq_capped) {
          if (v.uniq.size() >= kUniqueCap) {
            v.uniq_capped = true;
          } else if (opts_.unify_categories) {
            // Contar únicos por la clave normalizada y no por la escritura es
            // lo que decide el tipo: con "Buenos Aires" y "buenos aires" como
            // dos valores distintos, una columna de provincias sucia supera el
            // umbral de cardinalidad y se tipa como texto libre — con lo cual
            // no entra a ningún modelo y nadie se entera de por qué.
            v.uniq.emplace(category_key(cell));
          } else {
            v.uniq.emplace(cell);
          }
        }
      }
    }
    for (const ColumnVotes& v : votes) {
      file_numbers.decimal_comma += v.numbers.decimal_comma;
      file_numbers.decimal_dot += v.numbers.decimal_dot;
      file_dates.dmy += v.dates.dmy;
      file_dates.mdy += v.dates.mdy;
      file_dates.iso += v.dates.iso;
    }
    // A column of "45.000", "1.500", "2.000" cannot tell on its own whether the
    // dot groups thousands or opens the decimals — every value is consistent
    // with both. But a file almost never mixes conventions, so a column that
    // cannot decide inherits what the rest of the file already settled.
    file_decimal_ = file_numbers.resolve(opts_.fallback_decimal).decimal;
    file_date_order_ = file_dates.resolve(opts_.fallback_date_order);

    // Phase 2 — settle each column's format, then its type.
    for (std::size_t j = 0; j < ncols_; ++j) {
      cols_[j].name = names_[j];
      cols_[j].original_name = raw_names_[j];
      infer_column(j, votes[j]);
    }

    reserve_columns();
  }

  // Pre-sizes the output buffers from the caller's size hint. The sample gives
  // an accurate bytes-per-row figure because we hold the actual cells, so the
  // estimate lands within a few percent on any file that is not wildly
  // heterogeneous. Without this the column vectors grow by doubling, and every
  // doubling holds the old and new buffer at once.
  void reserve_columns() {
    if (opts_.total_bytes == 0 || sample_.empty() || sample_bytes_ == 0) return;
    const double bytes_per_row =
        static_cast<double>(sample_bytes_) / static_cast<double>(sample_.size());
    const double estimate = static_cast<double>(opts_.total_bytes) / bytes_per_row;
    if (!(estimate > 0.0)) return;
    // Cap it: a bad hint must not turn into a huge speculative allocation.
    const std::size_t rows = static_cast<std::size_t>(std::min(estimate, 2e9));

    if (opts_.drop_duplicate_rows) row_hashes_.reserve(rows);
    // Scan mode never fills a column, so reserving for one would allocate
    // hundreds of megabytes that stay untouched — exactly the cost the mode
    // exists to avoid.
    if (opts_.scan_only) return;
    for (Column& col : cols_) {
      col.mask.reserve(rows);
      switch (col.type) {
        case ColumnType::Numeric:
        case ColumnType::Date:
        case ColumnType::Empty:
          col.values.reserve(rows);
          break;
        case ColumnType::Categorical:
          col.codes.reserve(rows);
          break;
        case ColumnType::Text:
          col.text.reserve(rows);
          break;
      }
    }
  }

  std::size_t modal_width() const {
    if (sample_.empty()) return width_;
    std::vector<std::size_t> widths;
    widths.reserve(sample_.size());
    for (const auto& row : sample_) widths.push_back(row.size());
    std::sort(widths.begin(), widths.end());
    std::size_t mode = widths[0], best = 0, run = 0, prev = widths[0];
    for (std::size_t w : widths) {
      run = (w == prev) ? run + 1 : 1;
      prev = w;
      if (run > best) {
        best = run;
        mode = w;
      }
    }
    return mode;
  }

  void infer_column(std::size_t j, const ColumnVotes& v) {
    Column& col = cols_[j];
    const std::size_t non_missing = v.non_missing;

    col.number_format = opts_.force_decimal != '\0' ? NumberFormat{opts_.force_decimal}
                                                     : v.numbers.resolve(file_decimal_);
    col.date_order = opts_.force_date_order != DateOrder::Unknown
                         ? opts_.force_date_order
                         : v.dates.resolve(file_date_order_);
    col.stats.ambiguous_decimal = v.numbers.undecided() && v.numbers.ambiguous > 0;
    col.stats.ambiguous_date_order = v.dates.undecided() && v.dates.parseable > 0;

    if (non_missing == 0) {
      col.type = ColumnType::Empty;
      return;
    }

    std::size_t numeric_ok = 0, date_ok = 0, date_shaped = 0, bool_ok = 0;
    std::size_t grain_count[4] = {0, 0, 0, 0};
    for (const auto& row : sample_) {
      if (j >= row.size()) continue;
      const std::string_view cell = trim(row[j]);
      if (is_missing_token(cell)) continue;
      if (parse_number(cell, col.number_format).ok) ++numeric_ok;
      if (const DateParse d = parse_date(cell, col.date_order); d.ok) {
        ++date_ok;
        // "2020" parses as a date but is almost always a number. Only cells
        // carrying a separator or a month name count as genuinely date-shaped.
        if (has_non_digit(cell)) {
          ++date_shaped;
          ++grain_count[static_cast<int>(d.grain)];
        }
      }
      if (bool b; parse_bool(cell, &b)) ++bool_ok;
    }

    const double n = static_cast<double>(non_missing);
    if (static_cast<double>(date_shaped) >= n * opts_.date_threshold) {
      col.type = ColumnType::Date;
      int best = 0;
      for (int g = 1; g < 4; ++g) {
        if (grain_count[g] > grain_count[best]) best = g;
      }
      col.date_grain = static_cast<DateGrain>(best);
      // Una columna "2024-03" o "2024Q2" no tiene día, así que no hay ninguna
      // ambigüedad DD/MM que resolver. La bandera se calcula arriba, antes de
      // que se sepa el grano, y sin esto una serie mensual perfectamente sana
      // abría el diagnóstico con una advertencia sobre un componente que sus
      // fechas no tienen, y ofrecía releerlas al revés.
      if (col.date_grain != DateGrain::Day) col.stats.ambiguous_date_order = false;
      return;
    }
    if (static_cast<double>(numeric_ok) >= n * opts_.numeric_threshold) {
      col.type = ColumnType::Numeric;
      return;
    }
    if (bool_ok == non_missing) {
      col.type = ColumnType::Numeric;  // si/no and true/false become 1/0
      return;
    }
    if (static_cast<double>(date_ok) >= n * opts_.date_threshold) {
      col.type = ColumnType::Date;
      return;
    }
    // Categories have to actually repeat. A column of nine distinct free-text
    // notes has "few" levels only because the file is small; treating it as a
    // factor would invent nine dummy variables out of nine observations.
    const std::size_t levels = v.uniq.size();
    const bool mostly_values =
        numeric_ok * 2 >= non_missing || date_ok * 2 >= non_missing;
    const bool repeats = levels * 2 <= non_missing;
    const bool few_levels =
        !v.uniq_capped && repeats && levels <= opts_.max_categorical_levels &&
        (static_cast<double>(levels) <= n * opts_.categorical_ratio || levels <= 12);
    col.type = (!mostly_values && few_levels) ? ColumnType::Categorical : ColumnType::Text;
  }

  void flush_sample() {
    std::vector<std::string_view> views;
    for (const auto& row : sample_) {
      views.clear();
      views.reserve(row.size());
      for (const std::string& cell : row) views.emplace_back(cell);
      append_row(views.data(), views.size());
    }
    sample_.clear();
    sample_.shrink_to_fit();
  }

  // ── Row ingestion ──────────────────────────────────────────────────────────

  void append_row(const std::string_view* fields, std::size_t n) {
    if (ncols_ == 0) return;

    if (n > ncols_) {
      // Only worth reporting when the surplus actually carried something.
      for (std::size_t j = ncols_; j < n; ++j) {
        if (!is_missing_token(fields[j])) {
          ++truncated_;
          break;
        }
      }
      n = ncols_;
    } else if (n < ncols_) {
      ++padded_;
    }

    if (opts_.drop_empty_rows) {
      bool all_missing = true;
      for (std::size_t j = 0; j < n && all_missing; ++j) {
        if (!is_missing_token(fields[j])) all_missing = false;
      }
      if (all_missing) {
        ++empty_rows_;
        return;
      }
    }

    if (opts_.drop_duplicate_rows) {
      std::uint64_t h = 1469598103934665603ULL;
      for (std::size_t j = 0; j < n; ++j) {
        h = fnv1a(h, trim(fields[j]));
        h = fnv1a(h, "\x1f");
      }
      if (!row_hashes_.insert(h)) {
        ++dup_rows_;
        return;
      }
    }

    for (std::size_t j = 0; j < ncols_; ++j) {
      push_cell(j, j < n ? trim(fields[j]) : std::string_view{});
    }
    ++rows_kept_;
  }

  // Records one value in scan mode: counters and Welford moments only, so a
  // column costs a fixed number of bytes no matter how many rows go past.
  void scan_value(std::size_t j, bool present, bool invalid, double value) {
    ColumnStats& s = cols_[j].stats;
    if (invalid) ++s.invalid;
    if (!present) {
      ++s.missing;
      return;
    }
    ++s.present;
    if (s.present == 1) {
      s.min = s.max = s.mean = value;
      scan_m2_[j] = 0.0;
      return;
    }
    if (value < s.min) s.min = value;
    if (value > s.max) s.max = value;
    // Welford: one pass, and numerically stable where sum-of-squares is not.
    const double delta = value - s.mean;
    s.mean += delta / static_cast<double>(s.present);
    scan_m2_[j] += delta * (value - s.mean);
  }

  void finalize_scan_stats() {
    for (std::size_t j = 0; j < cols_.size(); ++j) {
      ColumnStats& s = cols_[j].stats;
      if (s.present == 0) continue;
      const bool numeric = cols_[j].type == ColumnType::Numeric ||
                           cols_[j].type == ColumnType::Date;
      if (!numeric) continue;
      s.has_moments = true;
      s.sd = s.present > 1
                 ? std::sqrt(scan_m2_[j] / static_cast<double>(s.present - 1))
                 : 0.0;
    }
    for (Column& col : cols_) {
      // The dictionary survives scan mode, so this count is exact. Text
      // columns have no such structure and their unique count stays unknown.
      if (col.type == ColumnType::Categorical) col.stats.unique = col.levels.size();
      else if (col.type == ColumnType::Text) col.stats.unique_capped = true;
    }
  }

  void push_cell(std::size_t j, std::string_view cell) {
    Column& col = cols_[j];
    const bool missing = is_missing_token(cell);

    if (opts_.scan_only) {
      switch (col.type) {
        case ColumnType::Empty:
          scan_value(j, false, false, 0.0);
          break;
        case ColumnType::Numeric: {
          if (missing) {
            scan_value(j, false, false, 0.0);
            break;
          }
          NumberParse p = parse_number(cell, col.number_format);
          if (!p.ok) {
            if (bool b; parse_bool(cell, &b)) {
              p.ok = true;
              p.value = b ? 1.0 : 0.0;
            }
          }
          if (!p.ok) {
            scan_value(j, false, true, 0.0);
            break;
          }
          if (p.percent) {
            col.stats.saw_percent = true;
            if (opts_.percent_as_fraction) p.value /= 100.0;
          }
          if (p.currency) col.stats.saw_currency = true;
          scan_value(j, true, false, p.value);
          break;
        }
        case ColumnType::Date: {
          if (missing) {
            scan_value(j, false, false, 0.0);
            break;
          }
          const DateParse d = parse_date(cell, col.date_order);
          scan_value(j, d.ok, !d.ok, d.ok ? static_cast<double>(d.serial()) : 0.0);
          break;
        }
        case ColumnType::Categorical: {
          if (missing) {
            scan_value(j, false, false, 0.0);
            break;
          }
          // The dictionary is bounded by max_categorical_levels, so keeping it
          // does not make memory grow with the row count.
          level_code(j, cell);
          scan_value(j, true, false, 0.0);
          break;
        }
        case ColumnType::Text:
          scan_value(j, !missing, false, 0.0);
          break;
      }
      return;
    }

    switch (col.type) {
      case ColumnType::Empty:
        col.values.push_back(0.0);
        col.mask.push_back(0);
        ++col.stats.missing;
        break;

      case ColumnType::Numeric: {
        if (missing) {
          col.values.push_back(0.0);
          col.mask.push_back(0);
          ++col.stats.missing;
          break;
        }
        NumberParse p = parse_number(cell, col.number_format);
        if (!p.ok) {
          if (bool b; parse_bool(cell, &b)) {
            p.ok = true;
            p.value = b ? 1.0 : 0.0;
          }
        }
        if (!p.ok) {
          col.values.push_back(0.0);
          col.mask.push_back(0);
          ++col.stats.missing;
          ++col.stats.invalid;
          break;
        }
        if (p.percent) {
          col.stats.saw_percent = true;
          if (opts_.percent_as_fraction) p.value /= 100.0;
        }
        if (p.currency) col.stats.saw_currency = true;
        col.values.push_back(p.value);
        col.mask.push_back(1);
        break;
      }

      case ColumnType::Date: {
        if (missing) {
          col.values.push_back(0.0);
          col.mask.push_back(0);
          ++col.stats.missing;
          break;
        }
        const DateParse d = parse_date(cell, col.date_order);
        if (!d.ok) {
          col.values.push_back(0.0);
          col.mask.push_back(0);
          ++col.stats.missing;
          ++col.stats.invalid;
          break;
        }
        col.values.push_back(static_cast<double>(d.serial()));
        col.mask.push_back(1);
        break;
      }

      case ColumnType::Categorical: {
        if (missing) {
          col.codes.push_back(-1);
          col.mask.push_back(0);
          ++col.stats.missing;
          break;
        }
        const std::int32_t code = level_code(j, cell);
        if (code < 0) {
          col.codes.push_back(-1);
          col.mask.push_back(0);
          ++col.stats.missing;
          ++col.stats.invalid;
          break;
        }
        col.codes.push_back(code);
        col.mask.push_back(1);
        break;
      }

      case ColumnType::Text:
        if (missing) {
          col.text.emplace_back();
          col.mask.push_back(0);
          ++col.stats.missing;
        } else {
          col.text.emplace_back(cell);
          col.mask.push_back(1);
        }
        break;
    }
  }

  // ── Pie de tabla ───────────────────────────────────────────────────────────

  /**
   * ¿La fila cruda es un pie de tabla?
   *
   * Sobre el texto, sin números parseados: es lo único que hay cuando el
   * archivo entero entra en la muestra y todavía no se votaron los tipos.
   */
  bool footer_in_text(const std::vector<std::string>& row, std::string* why) const {
    std::size_t filled = 0, last = 0;
    for (std::size_t j = 0; j < row.size(); ++j) {
      if (is_missing_token(row[j])) continue;
      ++filled;
      last = j;
      if (is_total_label(row[j])) {
        *why = "una celda dice \"" + std::string(trim(row[j])) + "\"";
        return true;
      }
    }
    // Una nota al pie ("Fuente: INDEC", "Elaboración propia") deja una sola
    // celda con texto y el resto vacío. No es una observación con faltantes:
    // una observación no llena la columna de etiquetas y deja en blanco todas
    // las de números.
    if (filled == 1 && row.size() > 1 && !looks_numeric(row[last])) {
      *why = "la única celda con contenido es un texto suelto (\"" +
             std::string(trim(row[last])) + "\")";
      return true;
    }
    return false;
  }

  static bool looks_numeric(std::string_view cell) {
    return parse_number(cell, NumberFormat{'.'}).ok || parse_number(cell, NumberFormat{','}).ok ||
           parse_date(cell, DateOrder::DMY).ok;
  }

  // Se comen las últimas filas de la muestra mientras sigan pareciendo pie.
  // Hacia arriba y frenando en la primera que no lo parece: un pie es un bloque
  // pegado al final, y con esa regla una fila legítima que se llame "Total"
  // solo se pierde si además es la última del archivo.
  void drop_footer_in_sample() {
    while (!sample_.empty() && footer_rows_ < kFooterWindow) {
      std::string why;
      if (!footer_in_text(sample_.back(), &why)) break;
      footer_why_.push_back(std::move(why));
      ++footer_rows_;
      sample_cells_ -= std::min(sample_cells_, sample_.back().size());
      sample_.pop_back();
    }
  }

  /**
   * Lo mismo sobre las columnas materializadas, que es donde aparece la prueba
   * dura: que el valor de una columna numérica sea exactamente la suma de lo
   * que tiene encima no depende del idioma de la etiqueta ni de que haya
   * etiqueta. Un archivo en portugués o sin columna de texto queda cubierto
   * igual.
   */
  bool footer_in_columns(std::size_t row, std::size_t slot,
                         const std::vector<std::vector<double>>& prefix,
                         const std::vector<std::vector<std::size_t>>& terms,
                         std::string* why) const {
    std::size_t filled = 0;
    const Column* lone = nullptr;
    std::string lone_text;

    for (const Column& col : cols_) {
      if (row >= col.mask.size() || !col.mask[row]) continue;
      ++filled;
      std::string label;
      if (col.type == ColumnType::Text) {
        label = col.text[row];
      } else if (col.type == ColumnType::Categorical) {
        const std::int32_t code = col.codes[row];
        if (code >= 0 && static_cast<std::size_t>(code) < col.levels.size()) {
          label = col.levels[static_cast<std::size_t>(code)];
        }
      }
      if (!label.empty()) {
        if (is_total_label(label)) {
          *why = "la celda de \"" + col.name + "\" dice \"" + label + "\"";
          return true;
        }
        lone = &col;
        lone_text = label;
      }
    }

    for (std::size_t j = 0; j < cols_.size(); ++j) {
      const Column& col = cols_[j];
      if (col.type != ColumnType::Numeric) continue;
      if (row >= col.mask.size() || !col.mask[row]) continue;
      if (slot >= terms[j].size() || terms[j][slot] < kMinFooterTerms) continue;
      const double sum = prefix[j][slot];
      const double v = col.values[row];
      // Una columna de ceros cumple la igualdad sin decir nada.
      if (std::fabs(v) < 1e-12) continue;
      if (std::fabs(v - sum) > 1e-6 * std::max(1.0, std::fabs(sum))) continue;
      *why = "el valor de \"" + col.name + "\" (" + format_number(v) +
             ") es exactamente la suma de las " + std::to_string(terms[j][slot]) +
             " filas de arriba";
      return true;
    }

    if (filled == 1 && lone != nullptr && cols_.size() > 1) {
      *why = "la única celda con contenido es un texto suelto en \"" + lone->name + "\" (\"" +
             lone_text + "\")";
      return true;
    }
    return false;
  }

  void drop_footer_in_columns() {
    if (cols_.empty() || rows_kept_ == 0) return;
    const std::size_t budget = kFooterWindow > footer_rows_ ? kFooterWindow - footer_rows_ : 0;
    if (budget == 0) return;
    const std::size_t first = rows_kept_ > budget ? rows_kept_ - budget : 0;

    // Suma de cada columna numérica *antes* de cada fila de la ventana, en una
    // sola pasada. Recalcularla por fila candidata serían tres recorridas más
    // sobre millones de valores para mirar tres filas.
    std::vector<std::vector<double>> prefix(cols_.size());
    std::vector<std::vector<std::size_t>> terms(cols_.size());
    for (std::size_t j = 0; j < cols_.size(); ++j) {
      const Column& col = cols_[j];
      if (col.type != ColumnType::Numeric) continue;
      double sum = 0.0;
      std::size_t seen = 0;
      const std::size_t n = std::min(first, col.mask.size());
      for (std::size_t i = 0; i < n; ++i) {
        if (col.mask[i]) {
          sum += col.values[i];
          ++seen;
        }
      }
      prefix[j].reserve(budget);
      terms[j].reserve(budget);
      for (std::size_t i = first; i < rows_kept_ && i < col.mask.size(); ++i) {
        prefix[j].push_back(sum);
        terms[j].push_back(seen);
        if (col.mask[i]) {
          sum += col.values[i];
          ++seen;
        }
      }
    }

    std::vector<std::uint8_t> keep(rows_kept_, 1);
    std::size_t dropped = 0;
    for (std::size_t i = rows_kept_; i-- > first;) {
      std::string why;
      if (!footer_in_columns(i, i - first, prefix, terms, &why)) break;
      keep[i] = 0;
      ++dropped;
      footer_why_.push_back(std::move(why));
    }
    if (dropped == 0) return;

    compact(keep);
    rows_kept_ = rows_out_;
    footer_rows_ += dropped;
    // compact() lo prendió para que el perfil se recalcule sobre lo que quedó,
    // pero acá todavía no se calculó ninguno: el compute_stats() que sigue ya
    // ve las columnas compactadas.
    values_changed_ = false;
  }

  // ── Categorías ─────────────────────────────────────────────────────────────

  /**
   * Nivel al que pertenece una escritura, creándolo si es nueva. -1 cuando el
   * diccionario ya llegó al tope.
   */
  std::int32_t level_code(std::size_t j, std::string_view cell) {
    Column& col = cols_[j];
    auto& exact = level_index_[j];
    std::string raw(cell);
    if (const auto it = exact.find(raw); it != exact.end()) {
      ++it->second.count;
      return it->second.code;
    }

    std::int32_t code = -1;
    if (opts_.unify_categories) {
      auto& keys = key_index_[j];
      const std::string key = category_key(cell);
      if (const auto it = keys.find(key); it != keys.end()) {
        code = it->second;  // otra forma de escribir una categoría que ya existe
      } else if (col.levels.size() < kMaxLevels) {
        code = static_cast<std::int32_t>(col.levels.size());
        col.levels.emplace_back(cell);
        keys.emplace(key, code);
      }
    } else if (col.levels.size() < kMaxLevels) {
      code = static_cast<std::int32_t>(col.levels.size());
      col.levels.emplace_back(cell);
    }
    if (code < 0) return -1;
    exact.emplace(std::move(raw), LevelEntry{code, 1, level_seq_++});
    return code;
  }

  /**
   * Elige qué escritura se muestra en cada nivel y anota las fusiones.
   *
   * Gana la más frecuente del archivo, no la primera que apareció: si noventa
   * filas dicen "Buenos Aires" y una dice "buenos aires", el nivel tiene que
   * leerse como lo escribe el archivo casi siempre. Los empates los rompe el
   * orden de aparición, que es lo que hace que el resultado no dependa del
   * orden de iteración de un unordered_map — y por lo tanto que el WASM y el
   * binario nativo den lo mismo.
   */
  void unify_levels() {
    if (!opts_.unify_categories) return;
    for (std::size_t j = 0; j < cols_.size(); ++j) {
      Column& col = cols_[j];
      if (col.type != ColumnType::Categorical || col.levels.empty()) continue;

      // Escrituras agrupadas por nivel. Se guardan punteros a las entradas del
      // índice, que sobreviven a cualquier reordenamiento de este vector.
      using Entry = std::pair<const std::string, LevelEntry>;
      std::vector<std::vector<const Entry*>> by_code(col.levels.size());
      for (const Entry& entry : level_index_[j]) {
        const std::int32_t code = entry.second.code;
        if (code < 0 || static_cast<std::size_t>(code) >= by_code.size()) continue;
        by_code[static_cast<std::size_t>(code)].push_back(&entry);
      }

      std::size_t absorbed = 0;
      std::vector<std::string> examples;
      for (std::size_t code = 0; code < by_code.size(); ++code) {
        auto& group = by_code[code];
        if (group.size() < 2) continue;
        std::sort(group.begin(), group.end(), [](const Entry* a, const Entry* b) {
          if (a->second.count != b->second.count) return a->second.count > b->second.count;
          return a->second.seq < b->second.seq;
        });
        const std::string& winner = group[0]->first;
        absorbed += group.size() - 1;
        if (examples.size() < 3) {
          std::string listed;
          for (std::size_t i = 1; i < group.size() && i <= 3; ++i) {
            listed += (i == 1 ? "" : ", ");
            listed += "\"" + group[i]->first + "\"";
          }
          examples.push_back(listed + " → \"" + winner + "\"");
        }
        col.levels[code] = winner;
      }
      if (absorbed == 0) continue;

      std::string detail = "En \"" + col.name + "\" se " +
                           (absorbed == 1 ? "unificó " : "unificaron ") +
                           plural(absorbed, "escritura", "escrituras") +
                           " con las que ya estaban: ";
      for (std::size_t i = 0; i < examples.size(); ++i) {
        detail += (i == 0 ? "" : "; ");
        detail += examples[i];
      }
      detail +=
          ". Difieren solo en mayúsculas, acentos o espacios, así que son la misma categoría; "
          "cada escritura de más sería una variable dummy de más. Se conservó la forma más "
          "frecuente del archivo.";
      add(ActionKind::UnifiedLevels, col.name, absorbed, std::move(detail));
    }
  }

  // ── Índice temporal ────────────────────────────────────────────────────────

  // 1970-01-01 fue jueves, así que el serial 0 cae en el día 4 contando desde
  // el domingo.
  static bool is_weekend(std::int64_t serial) {
    const std::int64_t dow = ((serial % 7) + 7 + 4) % 7;  // 0 domingo … 6 sábado
    return dow == 0 || dow == 6;
  }

  static bool is_calendar(TimeFrequency f) {
    return f == TimeFrequency::Monthly || f == TimeFrequency::Quarterly ||
           f == TimeFrequency::Semiannual || f == TimeFrequency::Annual;
  }

  // Meses por período, para las frecuencias que se cuentan por calendario. Un
  // trimestre no son 90 días ni un año 365: contarlos así deja huecos falsos en
  // febrero y en los bisiestos.
  static int months_per_period(TimeFrequency f) {
    switch (f) {
      case TimeFrequency::Monthly: return 1;
      case TimeFrequency::Quarterly: return 3;
      case TimeFrequency::Semiannual: return 6;
      case TimeFrequency::Annual: return 12;
      default: return 0;
    }
  }

  /**
   * Frecuencia de la serie, del espacio más frecuente entre observaciones
   * consecutivas.
   *
   * El grano del parseo manda cuando existe: si las celdas decían "2024Q2" o
   * "2024-03", la frecuencia ya está escrita en el archivo y no hay nada que
   * inferir.
   */
  static TimeFrequency infer_frequency(const std::vector<std::int64_t>& days, DateGrain grain) {
    if (grain == DateGrain::Year) return TimeFrequency::Annual;
    if (grain == DateGrain::Quarter) return TimeFrequency::Quarterly;
    if (grain == DateGrain::Month) return TimeFrequency::Monthly;
    if (days.size() < 3) return TimeFrequency::Unknown;

    std::vector<std::int64_t> gaps;
    gaps.reserve(days.size() - 1);
    for (std::size_t i = 1; i < days.size(); ++i) gaps.push_back(days[i] - days[i - 1]);
    std::vector<std::int64_t> sorted = gaps;
    std::sort(sorted.begin(), sorted.end());
    std::int64_t mode = sorted[0], best = 0, run = 0, prev = sorted[0];
    for (std::int64_t g : sorted) {
      run = (g == prev) ? run + 1 : 1;
      prev = g;
      if (run > best) {
        best = run;
        mode = g;
      }
    }

    if (mode == 1) {
      // Diaria o de días hábiles. Lo que las separa no es el salto de tres días
      // sino dónde cae: una serie financiera no tiene sábados ni domingos.
      bool weekend_seen = false;
      for (std::int64_t d : days) {
        if (is_weekend(d)) {
          weekend_seen = true;
          break;
        }
      }
      if (!weekend_seen && days.size() >= 5) return TimeFrequency::BusinessDaily;
      return TimeFrequency::Daily;
    }
    if (mode == 7) return TimeFrequency::Weekly;
    if (mode == 14) return TimeFrequency::Fortnightly;
    if (mode >= 28 && mode <= 31) return TimeFrequency::Monthly;
    if (mode >= 89 && mode <= 92) return TimeFrequency::Quarterly;
    if (mode >= 180 && mode <= 184) return TimeFrequency::Semiannual;
    if (mode >= 365 && mode <= 366) return TimeFrequency::Annual;
    return TimeFrequency::Unknown;
  }

  /**
   * La única columna de fechas de la tabla, o kNoColumn.
   *
   * Con más de una no se elige: "fecha_alta" y "fecha_baja" son las dos fechas
   * y ninguna es el índice, y ordenar por la que no es desordena el archivo
   * entero sin que nadie lo pida.
   */
  std::size_t pick_time_column() {
    std::size_t found = kNoColumn;
    std::size_t seen = 0;
    for (std::size_t j = 0; j < cols_.size(); ++j) {
      if (cols_[j].type != ColumnType::Date) continue;
      ++seen;
      found = j;
    }
    if (seen > 1) {
      time_index_.ambiguous = true;
      return kNoColumn;
    }
    return seen == 1 ? found : kNoColumn;
  }

  /**
   * Ordena las filas por fecha, cuando la columna de fechas es inequívocamente
   * el índice. Tiene que correr antes de imputar: el arrastre de faltantes
   * copia el último valor *anterior*, y sobre filas desordenadas "anterior"
   * quiere decir cualquier cosa.
   */
  void sort_by_time() {
    const std::size_t j = pick_time_column();
    if (j == kNoColumn) return;
    const Column& key = cols_[j];
    const std::size_t n = key.size();
    if (n < 2) return;

    // Primero lo barato, que es lo que paga todo archivo con fechas: una
    // pasada sin asignar nada. La mayoría de las series vienen ordenadas y se
    // van por acá.
    bool ordered = true;
    for (std::size_t i = 0; i < n; ++i) {
      if (!key.mask[i]) return;  // un faltante en el índice: no se ordena nada
      if (i > 0 && key.values[i] < key.values[i - 1]) ordered = false;
    }
    if (ordered) return;

    std::vector<std::uint32_t> order(n);
    for (std::size_t i = 0; i < n; ++i) order[i] = static_cast<std::uint32_t>(i);
    const std::vector<double>& v = key.values;
    std::sort(order.begin(), order.end(),
              [&v](std::uint32_t a, std::uint32_t b) { return v[a] < v[b]; });

    // Las fechas repetidas se buscan acá y no antes: ya ordenadas quedan
    // pegadas, así que sale de la misma pasada que hacía falta igual, sin un
    // hash de millones de entradas. Si hay alguna se descarta todo el trabajo:
    // con fechas repetidas lo que suele haber es un panel, y ordenar solo por
    // fecha mezclaría las unidades y arruinaría cualquier rezago.
    for (std::size_t i = 1; i < n; ++i) {
      if (v[order[i]] == v[order[i - 1]]) return;
    }

    for (Column& col : cols_) {
      permute(col, order);
    }
    values_changed_ = true;
    time_index_.sorted_here = true;
  }

  // Reordena una columna según `order`, con un solo buffer auxiliar por vector.
  static void permute(Column& col, const std::vector<std::uint32_t>& order) {
    const std::size_t n = order.size();
    if (!col.values.empty()) {
      std::vector<double> out(n);
      for (std::size_t i = 0; i < n; ++i) out[i] = col.values[order[i]];
      col.values.swap(out);
    }
    if (!col.codes.empty()) {
      std::vector<std::int32_t> out(n);
      for (std::size_t i = 0; i < n; ++i) out[i] = col.codes[order[i]];
      col.codes.swap(out);
    }
    if (!col.text.empty()) {
      std::vector<std::string> out(n);
      for (std::size_t i = 0; i < n; ++i) out[i] = std::move(col.text[order[i]]);
      col.text.swap(out);
    }
    if (!col.mask.empty()) {
      std::vector<std::uint8_t> out(n);
      for (std::size_t i = 0; i < n; ++i) out[i] = col.mask[order[i]];
      col.mask.swap(out);
    }
  }

  /** Frecuencia, repetidas y huecos, sobre las filas que quedaron. */
  void analyze_time_index() {
    const std::size_t j = pick_time_column();
    if (j == kNoColumn) return;
    const Column& col = cols_[j];

    std::vector<std::int64_t> days;
    days.reserve(col.size());
    bool ordered = true;  // tal como están las filas ahora
    for (std::size_t i = 0; i < col.size(); ++i) {
      if (!col.mask[i]) continue;
      const auto day = static_cast<std::int64_t>(col.values[i]);
      if (!days.empty() && day < days.back()) ordered = false;
      days.push_back(day);
    }
    if (days.size() < 2) return;

    time_index_.found = true;
    time_index_.column = col.name;
    time_index_.grain = col.date_grain;
    // `ordered` dice cómo venía el archivo, no cómo quedó: si lo reordenamos
    // nosotros es porque venía desordenado, y el análisis corre después.
    time_index_.ordered = !time_index_.sorted_here && ordered;
    time_index_.observations = days.size();

    // Si la serie ya está en orden — porque venía así o porque la ordenamos —
    // no hay nada que ordenar de nuevo: son millones de valores.
    if (!ordered) std::sort(days.begin(), days.end());
    days.erase(std::unique(days.begin(), days.end()), days.end());

    time_index_.first = to_iso(date_from_serial(days.front(), col.date_grain));
    time_index_.last = to_iso(date_from_serial(days.back(), col.date_grain));
    time_index_.frequency = infer_frequency(days, col.date_grain);
    count_periods(days, col.date_grain);
  }

  /**
   * Cuenta períodos observados, esperados y faltantes.
   *
   * Dos caminos porque son dos cosas distintas: una serie mensual se cuenta por
   * calendario — un trimestre no son 90 días ni un año 365, y contarlos así
   * inventa huecos en febrero y en cada bisiesto — y una diaria o semanal se
   * cuenta por días.
   */
  void count_periods(const std::vector<std::int64_t>& distinct, DateGrain grain) {
    const TimeFrequency f = time_index_.frequency;
    if (distinct.empty()) return;
    if (f == TimeFrequency::Unknown) {
      // Sin frecuencia no hay período, así que "faltar" no significa nada. Lo
      // que sí se puede decir es cuántas fechas distintas hay.
      time_index_.periods_observed = distinct.size();
      time_index_.duplicates = time_index_.observations - distinct.size();
      return;
    }

    // `distinct` viene ordenado y el número de período crece con la fecha, así
    // que los períodos salen ordenados solos: alcanza con recorrer los dos a la
    // vez. Un unordered_set acá costaría una inserción por observación sobre
    // series de millones de filas, para responder algo que ya está ordenado.
    const auto period_of = [&](std::int64_t day) -> std::int64_t {
      if (!is_calendar(f)) return day;
      const DateParse d = date_from_serial(day);
      const std::int64_t months = static_cast<std::int64_t>(d.year) * 12 + (d.month - 1);
      return months / months_per_period(f);
    };

    std::vector<std::int64_t> periods;
    periods.reserve(distinct.size());
    for (std::int64_t day : distinct) {
      const std::int64_t p = period_of(day);
      if (periods.empty() || periods.back() != p) periods.push_back(p);
    }
    time_index_.periods_observed = periods.size();
    time_index_.duplicates = time_index_.observations - periods.size();

    const std::int64_t step = is_calendar(f)                     ? 1
                              : f == TimeFrequency::Weekly      ? 7
                              : f == TimeFrequency::Fortnightly ? 14
                                                                : 1;
    const std::int64_t span = (periods.back() - periods.front()) / step + 1;
    // Una fecha con el año mal tipeado estira el rango a milenios. No se cuenta
    // un hueco por día de un rango que ya no describe a la serie.
    if (span <= 0 || span > 4000000) return;

    std::size_t k = 0;
    for (std::int64_t p = periods.front(); p <= periods.back(); p += step) {
      if (!is_calendar(f) && f == TimeFrequency::BusinessDaily && is_weekend(p)) continue;
      ++time_index_.periods_expected;
      while (k < periods.size() && periods[k] < p) ++k;  // observaciones fuera de la grilla
      if (k < periods.size() && periods[k] == p) {
        ++k;
        continue;
      }
      ++time_index_.missing_periods;
      if (time_index_.gap_examples.size() < 5) {
        if (is_calendar(f)) {
          const std::int64_t months = p * months_per_period(f);
          DateParse d;
          d.ok = true;
          d.year = static_cast<std::int32_t>(months / 12);
          d.month = static_cast<std::int32_t>(months % 12) + 1;
          d.day = 1;
          d.grain = grain == DateGrain::Day ? DateGrain::Month : grain;
          time_index_.gap_examples.push_back(to_iso(d));
        } else {
          time_index_.gap_examples.push_back(to_iso(date_from_serial(p, DateGrain::Day)));
        }
      }
    }
  }

  // ── Profiling ──────────────────────────────────────────────────────────────

  void compute_stats() {
    for (Column& col : cols_) {
      ColumnStats& s = col.stats;
      s.present = 0;
      for (std::uint8_t m : col.mask) s.present += m;
      s.missing = col.size() - s.present;
      s.has_moments = false;
      s.min = s.max = s.mean = s.sd = s.p25 = s.p50 = s.p75 = 0.0;

      if (col.type == ColumnType::Categorical) {
        s.unique = col.levels.size();
        continue;
      }
      if (col.type == ColumnType::Text) {
        std::unordered_set<std::string_view> uniq;
        s.unique_capped = false;
        for (std::size_t i = 0; i < col.text.size(); ++i) {
          if (!col.mask[i]) continue;
          if (uniq.size() >= kUniqueCap) {
            s.unique_capped = true;
            break;
          }
          uniq.emplace(col.text[i]);
        }
        s.unique = uniq.size();
        continue;
      }

      std::vector<double> all;
      all.reserve(s.present);
      for (std::size_t i = 0; i < col.values.size(); ++i) {
        if (col.mask[i]) all.push_back(col.values[i]);
      }
      if (all.empty()) {
        s.unique = 0;
        continue;
      }
      std::sort(all.begin(), all.end());

      s.unique = 1;
      for (std::size_t i = 1; i < all.size(); ++i) {
        if (all[i] != all[i - 1]) ++s.unique;
      }

      double sum = 0.0;
      for (double v : all) sum += v;
      const double mean = sum / static_cast<double>(all.size());
      double sq = 0.0;
      for (double v : all) sq += (v - mean) * (v - mean);

      s.has_moments = true;
      s.has_quantiles = true;
      s.min = all.front();
      s.max = all.back();
      s.mean = mean;
      s.sd = all.size() > 1 ? std::sqrt(sq / static_cast<double>(all.size() - 1)) : 0.0;
      s.p25 = quantile(all, 0.25);
      s.p50 = quantile(all, 0.50);
      s.p75 = quantile(all, 0.75);
    }
  }

  // ── Outliers ───────────────────────────────────────────────────────────────

  void apply_outliers(std::vector<std::uint8_t>& keep) {
    for (Column& col : cols_) {
      if (col.type != ColumnType::Numeric) continue;
      if (col.stats.present < kMinOutlierObs) continue;

      double lo = 0.0, hi = 0.0;
      if (opts_.outlier_rule == OutlierRule::IQR) {
        const double iqr = col.stats.p75 - col.stats.p25;
        if (iqr <= 0.0) continue;
        lo = col.stats.p25 - opts_.outlier_k * iqr;
        hi = col.stats.p75 + opts_.outlier_k * iqr;
      } else if (opts_.outlier_rule == OutlierRule::ZScore) {
        if (col.stats.sd <= 0.0) continue;
        lo = col.stats.mean - opts_.outlier_k * col.stats.sd;
        hi = col.stats.mean + opts_.outlier_k * col.stats.sd;
      } else {
        std::vector<double> dev;
        dev.reserve(col.stats.present);
        for (std::size_t i = 0; i < col.values.size(); ++i) {
          if (col.mask[i]) dev.push_back(std::fabs(col.values[i] - col.stats.p50));
        }
        std::sort(dev.begin(), dev.end());
        const double mad = quantile(dev, 0.5) * 1.4826;  // scaled to match sigma
        if (mad <= 0.0) continue;
        lo = col.stats.p50 - opts_.outlier_k * mad;
        hi = col.stats.p50 + opts_.outlier_k * mad;
      }

      std::size_t hits = 0;
      for (std::size_t i = 0; i < col.values.size(); ++i) {
        if (!col.mask[i]) continue;
        const double v = col.values[i];
        if (v >= lo && v <= hi) continue;
        ++hits;
        switch (opts_.outlier) {
          case OutlierPolicy::Flag:
            break;
          case OutlierPolicy::Winsorize:
            col.values[i] = std::min(std::max(v, lo), hi);
            values_changed_ = true;
            break;
          case OutlierPolicy::ToMissing:
            col.mask[i] = 0;
            values_changed_ = true;
            break;
          case OutlierPolicy::DropRow:
            if (i < keep.size()) keep[i] = 0;
            break;
        }
      }
      col.stats.outliers = hits;
      if (hits == 0) continue;

      const char* rule = opts_.outlier_rule == OutlierRule::IQR    ? "IQR"
                         : opts_.outlier_rule == OutlierRule::ZScore ? "z-score"
                                                                     : "MAD";
      const std::string range =
          "fuera de [" + format_number(lo) + ", " + format_number(hi) + "]";
      switch (opts_.outlier) {
        case OutlierPolicy::Flag:
          add(ActionKind::FlaggedOutliers, col.name, hits,
              "Se marcaron " + plural(hits, "valor atípico", "valores atípicos") + " en \"" +
                  col.name + "\": " + range + ", con la regla " + rule + " y k = " +
                  format_number(opts_.outlier_k) +
                  ". No se modificó ningún dato; quedan señalados para que decidas vos.");
          break;
        case OutlierPolicy::Winsorize:
          add(ActionKind::WinsorizedOutliers, col.name, hits,
              "Se winsorizaron " + plural(hits, "valor", "valores") + " en \"" + col.name +
                  "\" (" + range + ", regla " + rule +
                  "): se recortaron al borde del intervalo en vez de eliminarlos, para "
                  "conservar la observación sin dejar que la cola domine la estimación.");
          break;
        case OutlierPolicy::ToMissing:
          add(ActionKind::OutliersToMissing, col.name, hits,
              "Se pasaron a faltante " + plural(hits, "valor atípico", "valores atípicos") +
                  " en \"" + col.name + "\" (" + range + ", regla " + rule + ").");
          break;
        case OutlierPolicy::DropRow:
          add(ActionKind::DroppedOutlierRows, col.name, hits,
              "Se marcaron para eliminar " + plural(hits, "fila", "filas") +
                  " por valores atípicos en \"" + col.name + "\" (" + range + ", regla " +
                  rule + ").");
          break;
      }
    }
  }

  // ── Missing values ─────────────────────────────────────────────────────────

  void apply_missing(std::vector<std::uint8_t>& keep) {
    if (opts_.missing == MissingPolicy::Keep) return;

    if (opts_.missing == MissingPolicy::DropRow) {
      std::size_t hits = 0;
      for (std::size_t i = 0; i < keep.size(); ++i) {
        if (!keep[i]) continue;
        for (const Column& col : cols_) {
          if (i < col.mask.size() && !col.mask[i]) {
            keep[i] = 0;
            ++hits;
            break;
          }
        }
      }
      if (hits > 0) {
        add(ActionKind::DroppedMissingRows, "", hits,
            "Se eliminaron " + plural(hits, "fila", "filas") +
                " que tenían al menos un dato faltante. Es el criterio de casos completos: "
                "cualquier estimación posterior usa exactamente el mismo conjunto de filas.");
      }
      return;
    }

    for (Column& col : cols_) {
      if (col.type != ColumnType::Numeric) continue;
      std::size_t filled = 0;

      if (opts_.missing == MissingPolicy::Forward) {
        double last = 0.0;
        bool have = false;
        for (std::size_t i = 0; i < col.values.size(); ++i) {
          if (col.mask[i]) {
            last = col.values[i];
            have = true;
          } else if (have) {
            col.values[i] = last;
            col.mask[i] = 1;
            values_changed_ = true;
            ++filled;
          }
        }
        if (filled > 0) {
          add(ActionKind::ImputedMissing, col.name, filled,
              "Se completaron " + plural(filled, "faltante", "faltantes") + " en \"" +
                  col.name +
                  "\" arrastrando el último valor observado. Sirve para series de tiempo con "
                  "huecos, pero achata la varianza: los tramos rellenados no aportan "
                  "información nueva.");
        }
        continue;
      }

      double fill = 0.0;
      const char* how = "cero";
      if (opts_.missing == MissingPolicy::Mean) {
        fill = col.stats.mean;
        how = "la media";
      } else if (opts_.missing == MissingPolicy::Median) {
        fill = col.stats.p50;
        how = "la mediana";
      }
      for (std::size_t i = 0; i < col.values.size(); ++i) {
        if (col.mask[i]) continue;
        col.values[i] = fill;
        col.mask[i] = 1;
        values_changed_ = true;
        ++filled;
      }
      if (filled > 0) {
        add(ActionKind::ImputedMissing, col.name, filled,
            "Se imputaron " + plural(filled, "faltante", "faltantes") + " en \"" + col.name +
                "\" con " + how + " (" + format_number(fill) +
                "). Imputar con una constante reduce artificialmente la varianza de la "
                "variable y sesga sus errores estándar hacia abajo: usalo sabiendo eso.");
      }
    }
    (void)keep;
  }

  // ── Compaction ─────────────────────────────────────────────────────────────

  void compact(const std::vector<std::uint8_t>& keep) {
    std::size_t kept = 0;
    for (std::uint8_t k : keep) kept += k;
    rows_out_ = kept;
    if (kept == keep.size()) return;
    values_changed_ = true;

    for (Column& col : cols_) {
      std::size_t w = 0;
      for (std::size_t i = 0; i < col.mask.size(); ++i) {
        if (i < keep.size() && !keep[i]) continue;
        if (!col.values.empty()) col.values[w] = col.values[i];
        if (!col.codes.empty()) col.codes[w] = col.codes[i];
        if (!col.text.empty()) col.text[w] = std::move(col.text[i]);
        col.mask[w] = col.mask[i];
        ++w;
      }
      if (!col.values.empty()) col.values.resize(w);
      if (!col.codes.empty()) col.codes.resize(w);
      if (!col.text.empty()) col.text.resize(w);
      col.mask.resize(w);
    }
  }

  // ── Column pruning ─────────────────────────────────────────────────────────

  std::uint64_t column_hash(const Column& col) const {
    std::uint64_t h = fnv1a(1469598103934665603ULL, type_name(col.type));
    for (std::size_t i = 0; i < col.mask.size(); ++i) {
      if (!col.mask[i]) {
        h = fnv1a(h, "\x01NA\x1f");
        continue;
      }
      if (col.type == ColumnType::Text) {
        h = fnv1a(h, col.text[i]);
      } else if (col.type == ColumnType::Categorical) {
        h = fnv1a(h, col.levels[static_cast<std::size_t>(col.codes[i])]);
      } else {
        // Hash the bits, not a rendering of them. Formatting each value to
        // decimal here cost more than parsing the whole file did — and the
        // bitwise form is the stricter comparison anyway. Values are finite by
        // construction; the only quirk to fold away is -0.0.
        double v = col.values[i];
        if (v == 0.0) v = 0.0;
        h = fnv1a(h, std::string_view(reinterpret_cast<const char*>(&v), sizeof v));
      }
      h = fnv1a(h, "\x1f");
    }
    return h;
  }

  bool is_constant(const Column& col) const {
    if (col.stats.present == 0) return false;
    if (col.type == ColumnType::Text) {
      // Scan mode never counted text uniques, so it cannot claim constancy.
      return !col.stats.unique_capped && col.stats.unique <= 1;
    }
    if (col.type == ColumnType::Categorical) return col.stats.unique <= 1;
    return col.stats.has_moments && col.stats.min == col.stats.max;
  }

  void drop_columns() {
    std::vector<Column> kept;
    kept.reserve(cols_.size());
    std::unordered_map<std::uint64_t, std::string> seen;

    for (Column& col : cols_) {
      if (opts_.drop_empty_columns &&
          (col.type == ColumnType::Empty || col.stats.present == 0)) {
        add(ActionKind::DroppedEmptyColumn, col.name, 0,
            "Se eliminó la columna \"" + col.name +
                "\": no tiene ningún valor observado. Una columna vacía no puede entrar en "
                "ningún cálculo.");
        continue;
      }
      if (opts_.drop_constant_columns && is_constant(col)) {
        const std::string value = col.type == ColumnType::Numeric || col.type == ColumnType::Date
                                      ? format_number(col.stats.min)
                                      : std::string("un único valor");
        add(ActionKind::DroppedConstantColumn, col.name, 0,
            "Se eliminó la columna \"" + col.name + "\": vale siempre " + value +
                ". Una variable sin variación no explica nada y, como regresora, deja la "
                "matriz X'X singular.");
        continue;
      }
      // Comparing two columns cell by cell needs the cells. In scan mode they
      // were deliberately never stored, so this check simply does not apply.
      if (opts_.drop_duplicate_columns && !opts_.scan_only) {
        const std::uint64_t h = column_hash(col);
        const auto it = seen.find(h);
        if (it != seen.end()) {
          add(ActionKind::DroppedDuplicateColumn, col.name, 0,
              "Se eliminó la columna \"" + col.name + "\": es idéntica fila por fila a \"" +
                  it->second +
                  "\". Dos columnas iguales son colineales por construcción y hacen singular "
                  "la matriz X'X.");
          continue;
        }
        seen.emplace(h, col.name);
      }
      kept.push_back(std::move(col));
    }
    cols_ = std::move(kept);
  }

  // ── Reporting ──────────────────────────────────────────────────────────────

  void add(ActionKind kind, std::string column, std::size_t count, std::string detail) {
    actions_.push_back({kind, std::move(column), count, std::move(detail)});
  }

  void emit_actions() {
    std::vector<Action> head;
    const auto note = [&](ActionKind kind, std::string column, std::size_t count,
                          std::string detail) {
      head.push_back({kind, std::move(column), count, std::move(detail)});
    };

    const std::string delim =
        dialect_.delimiter == '\t'          ? "tabulación"
        : dialect_.delimiter == kNoDelimiter ? "ninguno (el archivo tiene una sola columna)"
                                            : std::string("\"") + dialect_.delimiter + "\"";
    note(ActionKind::InferredDialect, "", 0,
         std::string("Separador detectado: ") + delim + ". Primera fila tratada como " +
             (dialect_.has_header ? "encabezado" : "datos") + ".");

    if (encoding_.utf16_bom()) {
      note(ActionKind::UnsupportedEncoding, "", 1,
           "El archivo empieza con una marca de UTF-16. ChartBay lee UTF-8 y Windows-1252, "
           "así que lo que sigue va a estar mal leído de punta a punta. Abrilo en la "
           "planilla y volvé a guardarlo como \"CSV UTF-8\".");
    } else if (encoding_.converted() > 0) {
      note(ActionKind::ConvertedEncoding, "", encoding_.converted(),
           std::string("El archivo no estaba en UTF-8: se ") +
               (encoding_.converted() == 1 ? "tradujo " : "tradujeron ") +
               plural(encoding_.converted(), "byte", "bytes") +
               " leyéndolos como Windows-1252, que es lo que guarda Excel en español. Sin "
               "esto, cada acento y cada ñ quedan rotos en los nombres de columna, en los "
               "niveles de las categóricas y en el CSV que te llevás.");
    }
    if (time_index_.sorted_here) {
      note(ActionKind::SortedByTime, time_index_.column, 0,
           "Las filas se reordenaron por \"" + time_index_.column +
               "\": el archivo no venía en orden cronológico. Todo lo que mira el pasado —"
               " el arrastre de faltantes, los rezagos, la autocorrelación, las raíces "
               "unitarias — depende de ese orden, y sobre filas desordenadas devuelve un "
               "número, no un error.");
    }
    if (preamble_skipped_ > 0) {
      // Se nombra el encabezado que quedó, no el número de fila: entre el
      // título y la tabla suele haber líneas en blanco, que el scanner no
      // cuenta como filas, así que cualquier número que diéramos acá no
      // coincidiría con lo que el usuario ve al abrir el archivo.
      std::string head;
      for (std::size_t j = 0; j < names_.size() && j < 3; ++j) {
        head += (j == 0 ? "" : ", ") + names_[j];
      }
      if (names_.size() > 3) head += ", …";
      note(ActionKind::SkippedPreambleRows, "", preamble_skipped_,
           (preamble_skipped_ == 1 ? "Se salteó " : "Se saltearon ") +
               plural(preamble_skipped_, "fila", "filas") +
               " arriba del encabezado: título, metadata o líneas sueltas, todas más "
               "angostas que la tabla." +
               (head.empty() ? "" : " El encabezado tomado es \"" + head + "\"."));
    }
    if (footer_rows_ > 0) {
      std::string why;
      for (std::size_t i = 0; i < footer_why_.size(); ++i) {
        why += (i == 0 ? (footer_rows_ == 1 ? " Se reconoció porque " : " Se reconocieron porque ")
                       : "; ");
        why += footer_why_[i];
      }
      if (!why.empty()) why += ".";
      note(ActionKind::DroppedFooterRows, "", footer_rows_,
           (footer_rows_ == 1 ? "Se descartó " : "Se descartaron ") +
               plural(footer_rows_, "fila de pie de tabla", "filas de pie de tabla") + "." + why +
               " Un subtotal adentro de la columna no es una observación más: está en otra "
               "escala y arrastra la media, el desvío y el máximo de toda la variable.");
    }
    if (empty_rows_ > 0) {
      note(ActionKind::DroppedEmptyRows, "", empty_rows_,
           "Se descartaron " + plural(empty_rows_, "fila vacía", "filas vacías") +
               " (todas sus celdas estaban en blanco o eran marcadores de faltante).");
    }
    if (dup_rows_ > 0) {
      note(ActionKind::DroppedDuplicateRows, "", dup_rows_,
           "Se descartaron " + plural(dup_rows_, "fila duplicada", "filas duplicadas") +
               ", idénticas celda por celda a una fila anterior. Las duplicadas inflan el n "
               "sin aportar información y achican los errores estándar de forma espuria.");
    }
    if (padded_ > 0) {
      note(ActionKind::PaddedRaggedRow, "", padded_,
           "Hay " + plural(padded_, "fila", "filas") + " con menos de " +
               std::to_string(ncols_) +
               " celdas. Se completaron con faltantes en lugar de descartarlas.");
    }
    if (truncated_ > 0) {
      note(ActionKind::TruncatedRaggedRow, "", truncated_,
           "Hay " + plural(truncated_, "fila", "filas") + " con más de " +
               std::to_string(ncols_) +
               " celdas con contenido. Las celdas sobrantes se descartaron: revisá si el "
               "archivo tiene separadores sin escapar dentro de algún texto.");
    }
    if (scanner_ && scanner_->quote_anomalies() > 0) {
      note(ActionKind::MalformedQuotes, "", scanner_->quote_anomalies(),
           "Se encontraron " + plural(scanner_->quote_anomalies(), "comilla suelta",
                                      "comillas sueltas") +
               " dentro de campos entrecomillados. Se conservaron tal cual, sin cortar el "
               "campo.");
    }
    if (scanner_ && scanner_->unterminated_quote()) {
      note(ActionKind::UnterminatedQuote, "", 1,
           "El archivo termina con un campo entrecomillado sin cerrar. Se cerró en el final "
           "del archivo, pero es probable que falte contenido.");
    }

    for (const Column& col : cols_) {
      if (col.type == ColumnType::Numeric && col.number_format.decimal == ',') {
        note(ActionKind::InferredDecimal, col.name, 0,
             "En \"" + col.name +
                 "\" se leyó la coma como separador decimal y el punto como separador de "
                 "miles.");
      }
      if (col.stats.ambiguous_decimal) {
        const bool from_file = col.number_format.decimal == file_decimal_ &&
                               file_decimal_ != opts_.fallback_decimal;
        note(ActionKind::AmbiguousDecimal, col.name, 0,
             "En \"" + col.name +
                 "\" todos los valores tienen exactamente tres dígitos después del "
                 "separador, así que la columna sola no distingue 1.234 (mil doscientos "
                 "treinta y cuatro) de 1,234. Se usó \"" +
                 std::string(1, col.number_format.decimal) + "\" como separador decimal " +
                 (from_file ? "porque es la convención que votó el resto del archivo"
                            : "por defecto") +
                 ". Verificá el orden de magnitud.");
      }
      if (col.type == ColumnType::Date && col.stats.ambiguous_date_order) {
        note(ActionKind::AmbiguousDateOrder, col.name, 0,
             "En \"" + col.name +
                 "\" ningún valor tiene día mayor a 12, así que no se puede distinguir "
                 "DD/MM de MM/DD. Se asumió " +
                 std::string(opts_.fallback_date_order == DateOrder::MDY ? "MM/DD" : "DD/MM") +
                 ".");
      } else if (col.type == ColumnType::Date && col.date_order != DateOrder::Unknown) {
        note(ActionKind::InferredDateOrder, col.name, 0,
             "En \"" + col.name + "\" las fechas se leyeron como " +
                 (col.date_order == DateOrder::YMD   ? "AAAA-MM-DD"
                  : col.date_order == DateOrder::MDY ? "MM/DD/AAAA"
                                                     : "DD/MM/AAAA") +
                 ".");
      }
      if (col.stats.invalid > 0) {
        note(ActionKind::CoercedInvalid, col.name, col.stats.invalid,
             "En \"" + col.name + "\" hay " +
                 plural(col.stats.invalid, "celda que no pudo leerse como " +
                                               std::string(type_name(col.type)),
                        "celdas que no pudieron leerse como " +
                            std::string(type_name(col.type))) +
                 ". Se marcaron como faltantes en vez de forzar un número inventado.");
      }
    }

    head.insert(head.end(), actions_.begin(), actions_.end());
    actions_ = std::move(head);
  }

  // ── State ──────────────────────────────────────────────────────────────────

  CleanOptions opts_;
  EncodingFixer encoding_;
  std::string pre_;
  std::unique_ptr<CsvScanner> scanner_;
  bool started_ = false;
  Dialect dialect_;

  bool header_taken_ = false;
  std::vector<std::string> raw_names_;
  std::vector<std::string> names_;
  std::size_t width_ = 0;
  std::size_t ncols_ = 0;

  bool sampling_ = true;
  std::vector<std::vector<std::string>> sample_;
  std::size_t sample_cells_ = 0;
  std::size_t sample_bytes_ = 0;
  char file_decimal_ = '.';
  DateOrder file_date_order_ = DateOrder::DMY;

  std::vector<Column> cols_;
  // Escritura exacta → nivel. Atiende el caso normal, que es una categoría
  // repitiéndose idéntica millones de veces, con una sola búsqueda por hash.
  std::vector<std::unordered_map<std::string, LevelEntry>> level_index_;
  // Clave normalizada → nivel. Solo se consulta cuando aparece una escritura
  // que no se vio nunca, así que el costo es por variante y no por fila.
  std::vector<std::unordered_map<std::string, std::int32_t>> key_index_;
  std::size_t level_seq_ = 0;
  std::vector<double> scan_m2_;  // Welford accumulator, scan mode only

  bool values_changed_ = false;
  std::size_t rows_in_ = 0;
  std::size_t rows_kept_ = 0;
  std::size_t rows_out_ = 0;
  std::size_t empty_rows_ = 0;
  std::size_t dup_rows_ = 0;
  std::size_t preamble_skipped_ = 0;
  std::size_t footer_rows_ = 0;
  TimeIndex time_index_;
  std::vector<std::string> footer_why_;
  std::size_t padded_ = 0;
  std::size_t truncated_ = 0;

  RowHashSet row_hashes_;
  std::vector<Action> actions_;
};

Cleaner::Cleaner(CleanOptions options) : impl_(std::make_unique<Sink>(std::move(options))) {}
Cleaner::~Cleaner() = default;
void Cleaner::feed(const char* data, std::size_t len) { impl_->feed(data, len); }
CleanResult Cleaner::finish() { return impl_->finish(); }

CleanResult clean_buffer(std::string_view data, const CleanOptions& options) {
  Cleaner cleaner(options);
  cleaner.feed(data.data(), data.size());
  return cleaner.finish();
}

// ── CSV output ────────────────────────────────────────────────────────────────

namespace {

void write_cell(std::string& out, std::string_view value, char delimiter) {
  const bool needs_quotes =
      value.find(delimiter) != std::string_view::npos ||
      value.find('"') != std::string_view::npos || value.find('\n') != std::string_view::npos ||
      value.find('\r') != std::string_view::npos;
  if (!needs_quotes) {
    out.append(value);
    return;
  }
  out.push_back('"');
  for (char c : value) {
    if (c == '"') out.push_back('"');
    out.push_back(c);
  }
  out.push_back('"');
}

void render_header(std::string& out, const CleanResult& result, char delimiter) {
  for (std::size_t j = 0; j < result.columns.size(); ++j) {
    if (j) out.push_back(delimiter);
    write_cell(out, result.columns[j].name, delimiter);
  }
  out.push_back('\n');
}

void render_row(std::string& out, const CleanResult& result, std::size_t i, char delimiter) {
  for (std::size_t j = 0; j < result.columns.size(); ++j) {
    if (j) out.push_back(delimiter);
    const Column& col = result.columns[j];
    if (i >= col.mask.size() || !col.mask[i]) continue;  // missing → empty cell
    switch (col.type) {
      case ColumnType::Numeric:
        out.append(format_number(col.values[i]));
        break;
      case ColumnType::Date:
        out.append(
            to_iso(date_from_serial(static_cast<std::int64_t>(col.values[i]), col.date_grain)));
        break;
      case ColumnType::Categorical:
        write_cell(out, col.levels[static_cast<std::size_t>(col.codes[i])], delimiter);
        break;
      case ColumnType::Text:
        write_cell(out, col.text[i], delimiter);
        break;
      case ColumnType::Empty:
        break;
    }
  }
  out.push_back('\n');
}

}  // namespace

std::string to_csv(const CleanResult& result, char delimiter) {
  std::string out;
  if (result.columns.empty()) return out;
  out.reserve(result.rows_out * result.columns.size() * 8 + 256);
  render_header(out, result, delimiter);
  for (std::size_t i = 0; i < result.rows_out; ++i) render_row(out, result, i, delimiter);
  return out;
}

void write_csv(std::FILE* out, const CleanResult& result, char delimiter) {
  if (!out || result.columns.empty()) return;
  constexpr std::size_t kFlushAt = 1u << 18;
  std::string buf;
  buf.reserve(kFlushAt + 4096);

  render_header(buf, result, delimiter);
  for (std::size_t i = 0; i < result.rows_out; ++i) {
    render_row(buf, result, i, delimiter);
    if (buf.size() >= kFlushAt) {
      std::fwrite(buf.data(), 1, buf.size(), out);
      buf.clear();
    }
  }
  if (!buf.empty()) std::fwrite(buf.data(), 1, buf.size(), out);
}

}  // namespace chartbay
