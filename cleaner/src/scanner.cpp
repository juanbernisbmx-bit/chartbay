#include "chartbay/scanner.hpp"

#include <algorithm>

#include "chartbay/value.hpp"

namespace chartbay {
namespace {

constexpr std::size_t kNpos = std::string_view::npos;

// Rows sampled for sniffing. Enough to be representative, small enough that a
// pathological file cannot make the sniffer expensive.
constexpr std::size_t kSniffRows = 200;

class CountSink : public RowSink {
 public:
  void on_row(const std::string_view*, std::size_t n) override {
    if (counts.size() < kSniffRows) counts.push_back(n);
  }
  std::vector<std::size_t> counts;
};

class HeadSink : public RowSink {
 public:
  void on_row(const std::string_view* f, std::size_t n) override {
    if (rows.size() >= 50) return;
    std::vector<std::string> row;
    row.reserve(n);
    for (std::size_t i = 0; i < n; ++i) row.emplace_back(f[i]);
    rows.push_back(std::move(row));
  }
  std::vector<std::vector<std::string>> rows;
};

// A cell counts as "data-shaped" if it reads as a number under either decimal
// convention, or as a date. Headers rarely do; data columns usually do.
bool looks_like_value(std::string_view s) {
  if (parse_number(s, NumberFormat{'.'}).ok) return true;
  if (parse_number(s, NumberFormat{','}).ok) return true;
  return parse_date(s, DateOrder::DMY).ok;
}

}  // namespace

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
    CountSink sink;
    CsvScanner scanner(d, sink);
    scanner.feed(sample.data(), sample.size());
    scanner.finish();
    if (sink.counts.empty()) continue;

    std::vector<std::size_t> sorted = sink.counts;
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
    if (mode < 2) continue;

    // The first row has to be as wide as the rest. Without this, a
    // single-column file of comma decimals ("tasa\n12,5\n3,25\n") looks like a
    // clean two-column comma CSV to everything except the header. A file with
    // a stray title line above the header is the one legitimate exception, so
    // overwhelming consistency also passes.
    const double consistency = static_cast<double>(mode_run) / sink.counts.size();
    if (sink.counts[0] != mode && consistency < 0.9) continue;

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

  // Decide whether row 0 is a header: a text cell sitting on top of a column of
  // numbers or dates is a name, not an observation.
  HeadSink head;
  CsvScanner scanner(best, head);
  scanner.feed(sample.data(), sample.size());
  scanner.finish();

  best.has_header = true;
  if (head.rows.size() >= 2) {
    std::size_t votes_header = 0, votes_data = 0;
    for (std::size_t j = 0; j < head.rows[0].size(); ++j) {
      const bool head_is_value = looks_like_value(head.rows[0][j]);
      std::size_t body = 0, body_values = 0;
      for (std::size_t r = 1; r < head.rows.size(); ++r) {
        if (j >= head.rows[r].size()) continue;
        const std::string& cell = head.rows[r][j];
        if (is_missing_token(cell)) continue;
        ++body;
        if (looks_like_value(cell)) ++body_values;
      }
      if (body == 0) continue;
      if (body_values * 10 < body * 6) continue;  // the column is not value-shaped
      ++(head_is_value ? votes_data : votes_header);
    }
    best.has_header = votes_header > 0 || votes_data == 0;
  }

  return best;
}

}  // namespace chartbay
