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

const char* action_code(ActionKind k) {
  switch (k) {
    case ActionKind::InferredDialect: return "inferred_dialect";
    case ActionKind::InferredDecimal: return "inferred_decimal";
    case ActionKind::InferredDateOrder: return "inferred_date_order";
    case ActionKind::AmbiguousDecimal: return "ambiguous_decimal";
    case ActionKind::AmbiguousDateOrder: return "ambiguous_date_order";
    case ActionKind::PaddedRaggedRow: return "padded_ragged_row";
    case ActionKind::TruncatedRaggedRow: return "truncated_ragged_row";
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
    if (!started_) {
      pre_.append(data, len);
      if (pre_.size() < kSniffBytes) return;
      start();
      return;
    }
    scanner_->feed(data, len);
  }

  CleanResult finish() {
    if (!started_) start();
    scanner_->finish();
    if (sampling_) {
      resolve_types();
      flush_sample();
      sampling_ = false;
    }

    if (opts_.scan_only) {
      // Nothing was materialised, so there is nothing to sort, compact,
      // impute or compare. The moments were accumulated as the rows went by.
      finalize_scan_stats();
      rows_out_ = rows_kept_;
      drop_columns();
    } else {
      compute_stats();
      std::vector<std::uint8_t> keep(rows_kept_, 1);
      apply_outliers(keep);
      apply_missing(keep);
      compact(keep);
      // Profiling every numeric column means sorting it. On the default path
      // (flag outliers, keep missing) nothing above touches a value, so the
      // second pass would sort millions of doubles to reproduce what we have.
      if (values_changed_) compute_stats();
      drop_columns();
    }
    emit_actions();

    CleanResult result;
    result.dialect = dialect_;
    result.rows_in = rows_in_;
    result.rows_out = rows_out_;
    result.quote_anomalies = scanner_->quote_anomalies();
    result.unterminated_quote = scanner_->unterminated_quote();
    result.columns = std::move(cols_);
    result.actions = std::move(actions_);
    return result;
  }

 private:
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
    dialect_ = opts_.sniff ? sniff_dialect(body.substr(0, std::min(body.size(), kSniffBytes)))
                           : opts_.dialect;
    scanner_ = std::make_unique<CsvScanner>(dialect_, *this);
    scanner_->feed(body.data(), body.size());
    pre_.clear();
    pre_.shrink_to_fit();
  }

  void on_row(const std::string_view* fields, std::size_t n) override {
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
          auto& index = level_index_[j];
          if (index.find(std::string(cell)) == index.end() &&
              col.levels.size() < kMaxLevels) {
            index.emplace(std::string(cell), static_cast<std::int32_t>(col.levels.size()));
            col.levels.emplace_back(cell);
          }
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
        auto& index = level_index_[j];
        const auto it = index.find(std::string(cell));
        if (it != index.end()) {
          col.codes.push_back(it->second);
          col.mask.push_back(1);
          break;
        }
        if (col.levels.size() >= kMaxLevels) {
          col.codes.push_back(-1);
          col.mask.push_back(0);
          ++col.stats.missing;
          ++col.stats.invalid;
          break;
        }
        const auto code = static_cast<std::int32_t>(col.levels.size());
        index.emplace(std::string(cell), code);
        col.levels.emplace_back(cell);
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
  std::vector<std::unordered_map<std::string, std::int32_t>> level_index_;
  std::vector<double> scan_m2_;  // Welford accumulator, scan mode only

  bool values_changed_ = false;
  std::size_t rows_in_ = 0;
  std::size_t rows_kept_ = 0;
  std::size_t rows_out_ = 0;
  std::size_t empty_rows_ = 0;
  std::size_t dup_rows_ = 0;
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
