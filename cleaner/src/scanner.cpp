#include "chartbay/scanner.hpp"

#include <algorithm>
#include <cstring>

#include "chartbay/value.hpp"

namespace chartbay {
namespace {

constexpr std::size_t kNpos = std::string_view::npos;

// Rows sampled for sniffing. Enough to be representative, small enough that a
// pathological file cannot make the sniffer expensive.
constexpr std::size_t kSniffRows = 200;

// Filas de basura toleradas encima de la tabla. Un titulo, una fecha de
// emision y una linea en blanco es lo habitual en cualquier export de planilla;
// veinte ya no es un preambulo, es otro archivo pegado arriba.
constexpr std::size_t kMaxPreambleRows = 20;

// Filas cuyas celdas se guardan enteras para votar el encabezado. Tiene que
// dejar cuerpo suficiente por debajo del preambulo mas largo que se acepta.
constexpr std::size_t kHeadRows = 60;

class SniffSink : public RowSink {
 public:
  void on_row(const std::string_view* f, std::size_t n) override {
    if (counts.size() < kSniffRows) counts.push_back(n);
    if (rows.size() >= kHeadRows) return;
    std::vector<std::string> row;
    row.reserve(n);
    for (std::size_t i = 0; i < n; ++i) row.emplace_back(f[i]);
    rows.push_back(std::move(row));
  }
  std::vector<std::size_t> counts;
  std::vector<std::vector<std::string>> rows;
};

// A cell counts as "data-shaped" if it reads as a number under either decimal
// convention, or as a date. Headers rarely do; data columns usually do.
bool looks_like_value(std::string_view s) {
  if (parse_number(s, NumberFormat{'.'}).ok) return true;
  if (parse_number(s, NumberFormat{','}).ok) return true;
  return parse_date(s, DateOrder::DMY).ok;
}

struct HeaderVote {
  std::size_t header = 0;  // columnas cuya primera celda es un nombre
  std::size_t data = 0;    // columnas cuya primera celda es una observacion mas
};

// Vota si la fila `start` es el encabezado de las que tiene debajo: una celda
// de texto arriba de una columna de numeros o fechas es un nombre, no un dato.
HeaderVote vote_header(const std::vector<std::vector<std::string>>& rows, std::size_t start) {
  HeaderVote v;
  if (rows.size() < start + 2) return v;
  for (std::size_t j = 0; j < rows[start].size(); ++j) {
    const bool head_is_value = looks_like_value(rows[start][j]);
    std::size_t body = 0, body_values = 0;
    for (std::size_t r = start + 1; r < rows.size(); ++r) {
      if (j >= rows[r].size()) continue;
      const std::string& cell = rows[r][j];
      if (is_missing_token(cell)) continue;
      ++body;
      if (looks_like_value(cell)) ++body_values;
    }
    if (body == 0) continue;
    if (body_values * 10 < body * 6) continue;  // the column is not value-shaped
    ++(head_is_value ? v.data : v.header);
  }
  return v;
}

// Ancho de fila mas frecuente. `floor` descarta los anchos por debajo de el, que
// es como se ignora un preambulo: cinco lineas de titulo hacen que el ancho mas
// frecuente del archivo sea 1, y con eso el delimitador correcto se descartaria
// por no partir nada.
std::size_t modal_count(const std::vector<std::size_t>& counts, std::size_t floor) {
  std::vector<std::size_t> sorted;
  sorted.reserve(counts.size());
  for (std::size_t n : counts) {
    if (n >= floor) sorted.push_back(n);
  }
  if (sorted.empty()) return 0;
  std::sort(sorted.begin(), sorted.end());
  std::size_t mode = sorted[0], mode_run = 0, run = 0, prev = sorted[0];
  for (std::size_t n : sorted) {
    run = (n == prev) ? run + 1 : 1;
    prev = n;
    if (run > mode_run) {
      mode_run = run;
      mode = n;
    }
  }
  return mode;
}

}  // namespace

// ── Encoding ──────────────────────────────────────────────────────────────────

namespace {

// Primer byte >= 0x80, de a ocho. Un CSV es casi todo ASCII, asi que esta es la
// funcion que decide cuanto paga un archivo correcto por el arreglo de encoding:
// si el bloque entero es ASCII se devuelve sin copiar un solo byte.
std::size_t first_high_byte(const char* data, std::size_t len) {
  std::size_t i = 0;
  while (i + sizeof(std::uint64_t) <= len) {
    std::uint64_t word;
    std::memcpy(&word, data + i, sizeof word);
    if (word & 0x8080808080808080ULL) break;
    i += sizeof(std::uint64_t);
  }
  for (; i < len; ++i) {
    if (static_cast<unsigned char>(data[i]) >= 0x80) return i;
  }
  return len;
}

constexpr int kInvalidSequence = 0;
constexpr int kIncompleteSequence = -1;

// Largo de la secuencia UTF-8 que empieza en s[0], validando el rango de cada
// byte de continuacion. Los rangos raros (0xE0, 0xED, 0xF0, 0xF4) no son
// decoracion: son los que rechazan las formas sobrelargas y los sustitutos, que
// es lo unico que separa "validar UTF-8" de "contar bytes altos".
int utf8_sequence_length(const unsigned char* s, std::size_t avail) {
  const unsigned char c = s[0];
  int need;
  unsigned char lo, hi;  // rango del primer byte de continuacion
  if (c >= 0xC2 && c <= 0xDF) {
    need = 2;
    lo = 0x80;
    hi = 0xBF;
  } else if (c == 0xE0) {
    need = 3;
    lo = 0xA0;
    hi = 0xBF;
  } else if (c == 0xED) {
    need = 3;
    lo = 0x80;
    hi = 0x9F;
  } else if ((c >= 0xE1 && c <= 0xEC) || c == 0xEE || c == 0xEF) {
    need = 3;
    lo = 0x80;
    hi = 0xBF;
  } else if (c == 0xF0) {
    need = 4;
    lo = 0x90;
    hi = 0xBF;
  } else if (c >= 0xF1 && c <= 0xF3) {
    need = 4;
    lo = 0x80;
    hi = 0xBF;
  } else if (c == 0xF4) {
    need = 4;
    lo = 0x80;
    hi = 0x8F;
  } else {
    return kInvalidSequence;  // 0x80-0xC1 y 0xF5-0xFF no empiezan nada
  }
  if (avail < static_cast<std::size_t>(need)) {
    // El prefijo que hay tiene que seguir siendo valido para que valga la pena
    // esperar al bloque siguiente.
    for (std::size_t i = 1; i < avail; ++i) {
      const unsigned char k = s[i];
      const bool ok = (i == 1) ? (k >= lo && k <= hi) : (k >= 0x80 && k <= 0xBF);
      if (!ok) return kInvalidSequence;
    }
    return kIncompleteSequence;
  }
  if (s[1] < lo || s[1] > hi) return kInvalidSequence;
  for (int i = 2; i < need; ++i) {
    if (s[i] < 0x80 || s[i] > 0xBF) return kInvalidSequence;
  }
  return need;
}

// Windows-1252 se separa de Latin-1 solo en 0x80-0x9F, y justo ahi viven los
// caracteres que Word y Excel meten en el texto todo el tiempo: la comilla
// tipografica (0x92, el apostrofo de "don't"), los guiones largos y el euro.
// Fuera de ese tramo el codigo de Windows-1252 es el punto Unicode.
std::uint32_t cp1252_code_point(unsigned char b) {
  static constexpr std::uint32_t kHigh[32] = {
      0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
      0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
      0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
      0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
  };
  if (b >= 0x80 && b <= 0x9F) return kHigh[b - 0x80];
  return b;
}

void append_utf8(std::string& out, std::uint32_t cp) {
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

}  // namespace

std::string_view EncodingFixer::feed(const char* data, std::size_t len) {
  if (first_ && len > 0) {
    first_ = false;
    // El BOM de UTF-16 se mira sobre el byte crudo, antes de tocar nada: 0xFF
    // no es UTF-8 valido y el propio arreglo lo convertiria en "ÿ".
    const auto b0 = static_cast<unsigned char>(data[0]);
    const auto b1 = len > 1 ? static_cast<unsigned char>(data[1]) : 0;
    utf16_bom_ = (b0 == 0xFF && b1 == 0xFE) || (b0 == 0xFE && b1 == 0xFF);
  }
  if (len == 0) return {};
  if (pending_.empty() && first_high_byte(data, len) == len) {
    return std::string_view(data, len);  // ASCII puro: sin copia
  }
  return convert(data, len);
}

std::string_view EncodingFixer::convert(const char* data, std::size_t len) {
  out_.clear();
  out_.reserve(pending_.size() + len + len / 8);

  // Lo que quedo colgando del bloque anterior, resuelto contra el arranque de
  // este. Son tres bytes como maximo, asi que se copian y listo.
  std::size_t start = 0;
  if (!pending_.empty()) {
    unsigned char head[8] = {0};
    std::size_t n = 0;
    for (char c : pending_) head[n++] = static_cast<unsigned char>(c);
    const std::size_t taken = std::min(len, sizeof head - n);
    for (std::size_t i = 0; i < taken; ++i) head[n + i] = static_cast<unsigned char>(data[i]);
    const int seq = utf8_sequence_length(head, n + taken);
    if (seq > 0) {
      for (int i = 0; i < seq; ++i) out_.push_back(static_cast<char>(head[i]));
      start = static_cast<std::size_t>(seq) - n;
    } else if (seq == kIncompleteSequence) {
      // Un bloque tan corto que la secuencia sigue sin cerrarse.
      pending_.append(data, len);
      return {};
    } else {
      for (std::size_t i = 0; i < n; ++i) {
        append_utf8(out_, cp1252_code_point(head[i]));
        ++converted_;
      }
    }
    pending_.clear();
  }

  const auto* p = reinterpret_cast<const unsigned char*>(data);
  std::size_t i = start;
  while (i < len) {
    if (p[i] < 0x80) {
      const std::size_t run = i + first_high_byte(data + i, len - i);
      out_.append(data + i, run - i);
      i = run;
      continue;
    }
    const int seq = utf8_sequence_length(p + i, len - i);
    if (seq == kIncompleteSequence) {
      pending_.assign(data + i, len - i);
      break;
    }
    if (seq == kInvalidSequence) {
      append_utf8(out_, cp1252_code_point(p[i]));
      ++converted_;
      ++i;
      continue;
    }
    out_.append(data + i, static_cast<std::size_t>(seq));
    i += static_cast<std::size_t>(seq);
  }
  return out_;
}

std::string_view EncodingFixer::finish() {
  if (pending_.empty()) return {};
  out_.clear();
  // Una secuencia que el archivo nunca cerro ya no puede ser UTF-8.
  for (char c : pending_) {
    append_utf8(out_, cp1252_code_point(static_cast<unsigned char>(c)));
    ++converted_;
  }
  pending_.clear();
  return out_;
}

std::string_view strip_bom(std::string_view s) {
  constexpr std::string_view kBom = "\xEF\xBB\xBF";
  if (s.size() >= kBom.size() && s.compare(0, kBom.size(), kBom) == 0) {
    s.remove_prefix(kBom.size());
  }
  return s;
}

// ── Scanner ───────────────────────────────────────────────────────────────────

CsvScanner::CsvScanner(Dialect dialect, RowSink& sink) : dialect_(dialect), sink_(sink) {}

void CsvScanner::begin_field(std::size_t i) {
  field_start_ = i;
  if (dirty_) field_buf_begin_ = row_buf_.size();
  in_field_ = true;
  at_row_start_ = false;
}

void CsvScanner::end_field(std::size_t end) {
  if (dirty_) {
    if (end > field_start_) row_buf_.append(chunk_ + field_start_, end - field_start_);
    spans_.push_back({field_buf_begin_, row_buf_.size()});
  } else {
    spans_.push_back({field_start_, end});
  }
  in_field_ = false;
  quote_flushed_ = false;
}

void CsvScanner::end_row() {
  static const char kEmpty[] = "";
  const char* base = dirty_ ? row_buf_.data() : (chunk_ ? chunk_ : kEmpty);
  views_.clear();
  views_.reserve(spans_.size());
  for (const Span& s : spans_) views_.emplace_back(base + s.begin, s.end - s.begin);
  sink_.on_row(views_.data(), views_.size());
  ++rows_;

  spans_.clear();
  row_buf_.clear();
  dirty_ = false;
  in_field_ = false;
  at_row_start_ = true;
  quote_flushed_ = false;
  st_ = St::FieldStart;
}

void CsvScanner::go_dirty(std::size_t upto, bool field_open) {
  if (!dirty_) {
    std::string buf;
    std::size_t total = 0;
    for (const Span& s : spans_) total += s.end - s.begin;
    buf.reserve(total + 64);
    for (Span& s : spans_) {
      const std::size_t begin = buf.size();
      buf.append(chunk_ + s.begin, s.end - s.begin);
      s.begin = begin;
      s.end = buf.size();
    }
    row_buf_.swap(buf);
    dirty_ = true;
    if (field_open) field_buf_begin_ = row_buf_.size();
  }
  if (field_open) {
    if (upto > field_start_) row_buf_.append(chunk_ + field_start_, upto - field_start_);
    field_start_ = upto;
  }
}

void CsvScanner::feed(const char* data, std::size_t len) {
  if (len == 0) return;
  chunk_ = data;
  chunk_len_ = len;
  field_start_ = 0;

  std::size_t i = 0;
  if (skip_lf_) {
    skip_lf_ = false;
    if (data[0] == '\n') i = 1;
  }

  const char delim = dialect_.delimiter;
  const char quote = dialect_.quote;

  // Returns how many bytes the line break at `pos` occupies. A CR that lands on
  // the last byte of the chunk arms skip_lf_, because its LF may be in the next.
  const auto newline_len = [&](std::size_t pos) -> std::size_t {
    if (data[pos] != '\r') return 1;
    if (pos + 1 < len) return data[pos + 1] == '\n' ? 2 : 1;
    skip_lf_ = true;
    return 1;
  };

  while (i < len) {
    const char c = data[i];
    switch (st_) {
      case St::FieldStart:
        if (c == quote) {
          begin_field(i + 1);
          st_ = St::Quoted;
          ++i;
        } else if (c == delim) {
          begin_field(i);
          end_field(i);
          ++i;
        } else if (c == '\n' || c == '\r') {
          if (at_row_start_) {
            i += newline_len(i);  // blank line, not a row
          } else {
            begin_field(i);
            end_field(i);
            i += newline_len(i);
            end_row();
          }
        } else {
          begin_field(i);
          st_ = St::Unquoted;
        }
        break;

      case St::Unquoted:
        if (c == delim) {
          end_field(i);
          st_ = St::FieldStart;
          ++i;
        } else if (c == '\n' || c == '\r') {
          end_field(i);
          i += newline_len(i);
          end_row();
        } else {
          ++i;
        }
        break;

      case St::Quoted:
        if (c == quote) {
          quote_pos_ = i;
          st_ = St::QuotedQuote;
        }
        ++i;
        break;

      case St::QuotedQuote:
        if (c == quote) {
          // "" — an escaped quote. Keep one of the two.
          if (quote_flushed_) {
            row_buf_.push_back(quote);
            field_start_ = i + 1;
            quote_flushed_ = false;
          } else {
            go_dirty(quote_pos_ + 1, true);
            field_start_ = i + 1;
          }
          st_ = St::Quoted;
          ++i;
        } else if (c == delim) {
          end_field(quote_flushed_ ? field_start_ : quote_pos_);
          st_ = St::FieldStart;
          ++i;
        } else if (c == '\n' || c == '\r') {
          end_field(quote_flushed_ ? field_start_ : quote_pos_);
          i += newline_len(i);
          end_row();
        } else {
          // A lone quote in the middle of a quoted field. Excel writes these
          // when a user types a quote into a cell. Keep it verbatim.
          ++quote_anomalies_;
          if (quote_flushed_) {
            row_buf_.push_back(quote);
            field_start_ = i;
            quote_flushed_ = false;
          }
          st_ = St::Quoted;
        }
        break;
    }
  }

  // Carry whatever is half-parsed into row_buf_ so it outlives this chunk.
  switch (st_) {
    case St::Unquoted:
    case St::Quoted:
      go_dirty(len, true);
      break;
    case St::QuotedQuote:
      if (!quote_flushed_) {
        go_dirty(quote_pos_, true);
        quote_flushed_ = true;
      }
      break;
    case St::FieldStart:
      if (!spans_.empty()) go_dirty(0, false);
      break;
  }

  chunk_ = nullptr;
  chunk_len_ = 0;
  field_start_ = 0;
}

void CsvScanner::finish() {
  if (st_ == St::Quoted) unterminated_ = true;
  if (in_field_) {
    end_field(field_start_);
  } else if (st_ == St::FieldStart && !at_row_start_) {
    begin_field(0);  // trailing delimiter: "a,b," ends on one empty field
    end_field(0);
  }
  if (!spans_.empty()) end_row();
  st_ = St::FieldStart;
}

// ── Sniffing ──────────────────────────────────────────────────────────────────

Dialect sniff_dialect(std::string_view sample) {
  sample = strip_bom(sample);
  // Whole lines only: a truncated tail would skew every field count.
  const std::size_t last_nl = sample.find_last_of('\n');
  if (last_nl != kNpos) sample = sample.substr(0, last_nl + 1);
  if (sample.empty()) return Dialect{};

  static constexpr char kCandidates[] = {',', ';', '\t', '|'};
  Dialect best;
  double best_score = -1.0;

  for (char candidate : kCandidates) {
    Dialect d;
    d.delimiter = candidate;
    SniffSink sink;
    CsvScanner scanner(d, sink);
    scanner.feed(sample.data(), sample.size());
    scanner.finish();
    if (sink.counts.empty()) continue;

    std::size_t mode = modal_count(sink.counts, 0);
    // El ancho modal del archivo entero puede ser el del preambulo: cuatro
    // lineas de titulo arriba de tres filas de datos dan 1. Se vuelve a votar
    // mirando solo las filas que este delimitador parte de verdad.
    if (mode < 2) mode = modal_count(sink.counts, 2);
    if (mode < 2) continue;

    const std::size_t seen = sink.counts.size();
    std::size_t at_mode = 0;
    for (std::size_t n : sink.counts) at_mode += (n == mode);

    // The first row has to be as wide as the rest. Without this, a
    // single-column file of comma decimals ("tasa\n12,5\n3,25\n") looks like a
    // clean two-column comma CSV to everything except the header. A file with
    // a stray title line above the header is the one legitimate exception, so
    // overwhelming consistency also passes.
    double consistency = static_cast<double>(at_mode) / static_cast<double>(seen);
    bool accepted = sink.counts[0] == mode || consistency >= 0.9;

    // Y el otro camino: que lo de arriba no sea una fila ancha sino basura, y
    // la tabla empiece mas abajo. Se acepta solo con evidencia positiva — el
    // tramo de abajo tiene que ser consistente *y* empezar con un encabezado —
    // porque sin ese segundo requisito "tasa\n12,5\n3,25\n" volveria a leerse
    // como dos columnas con el nombre de la variable de preambulo.
    std::size_t preamble = 0;
    while (preamble < seen && sink.counts[preamble] != mode) ++preamble;
    if (preamble > 0 && preamble <= kMaxPreambleRows && seen - preamble >= 3) {
      std::size_t table_at_mode = 0;
      for (std::size_t i = preamble; i < seen; ++i) table_at_mode += (sink.counts[i] == mode);
      const double table_consistency =
          static_cast<double>(table_at_mode) / static_cast<double>(seen - preamble);
      if (table_consistency >= 0.9 && vote_header(sink.rows, preamble).header > 0) {
        consistency = table_consistency;
        d.preamble_rows = preamble;
        accepted = true;
      }
    }
    if (!accepted) continue;

    // Consistency dominates; the field count only breaks ties, so a delimiter
    // that shatters text into many ragged columns cannot win.
    const double score = consistency * 100.0 + std::min<double>(static_cast<double>(mode), 50.0);
    if (score > best_score) {
      best_score = score;
      best = d;
    }
  }

  // Nothing split the file consistently: it is one column.
  if (best_score < 0.0) best.delimiter = kNoDelimiter;

  // Decide whether the first row of the table is a header: a text cell sitting
  // on top of a column of numbers or dates is a name, not an observation.
  SniffSink head;
  CsvScanner scanner(best, head);
  scanner.feed(sample.data(), sample.size());
  scanner.finish();

  const HeaderVote v = vote_header(head.rows, best.preamble_rows);
  best.has_header = v.header > 0 || v.data == 0;
  return best;
}

}  // namespace chartbay
