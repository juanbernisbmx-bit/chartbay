// Streaming CSV scanner.
//
// The parser is a push machine: callers feed byte chunks in order and it calls
// back once per row. That shape is what makes it usable from both sides — the
// CLI reads the file in blocks, and the browser hands over Blob slices — with
// no requirement that the whole file ever be resident.
//
// Rows that live entirely inside one chunk and carry no "" escapes are handed
// out as views straight into that chunk (no copy). Only rows that straddle a
// chunk boundary or need unescaping get copied into an internal buffer.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace chartbay {

// Delimiter used for single-column files. ASCII unit separator: it cannot
// occur in a text CSV, so the scanner simply never splits.
constexpr char kNoDelimiter = '\x1f';

struct Dialect {
  char delimiter = ',';
  char quote = '"';
  bool has_header = true;
};

// Infers the delimiter and whether row 0 is a header, from the first bytes of
// the file. Pass at least a few KB; whole lines only are considered.
Dialect sniff_dialect(std::string_view sample);

// Strips a UTF-8 byte order mark if present, so the first header does not come
// back as "\xEF\xBB\xBFfecha".
std::string_view strip_bom(std::string_view s);

class RowSink {
 public:
  virtual ~RowSink() = default;
  // `fields` is only valid for the duration of the call. Copy what you keep.
  virtual void on_row(const std::string_view* fields, std::size_t n) = 0;
};

class CsvScanner {
 public:
  CsvScanner(Dialect dialect, RowSink& sink);

  // Feeds the next chunk of the file. Chunks may split anywhere, including in
  // the middle of a quoted field or between the CR and LF of a line break.
  void feed(const char* data, std::size_t len);

  // Emits the final row when the file does not end with a line break.
  void finish();

  std::size_t rows() const { return rows_; }
  // Quotes found in the middle of a quoted field, e.g. "a"b". They are kept
  // verbatim rather than rejected, but counted so the report can say so.
  std::size_t quote_anomalies() const { return quote_anomalies_; }
  // True when the file ended inside an unterminated quoted field.
  bool unterminated_quote() const { return unterminated_; }

 private:
  enum class St : std::uint8_t { FieldStart, Unquoted, Quoted, QuotedQuote };
  struct Span {
    std::size_t begin;
    std::size_t end;
  };

  void begin_field(std::size_t i);
  void end_field(std::size_t end);
  void end_row();
  // Moves the row built so far into row_buf_ so it survives the current chunk.
  // `upto` is how much of the open field to carry over.
  void go_dirty(std::size_t upto, bool field_open);

  Dialect dialect_;
  RowSink& sink_;

  St st_ = St::FieldStart;
  const char* chunk_ = nullptr;
  std::size_t chunk_len_ = 0;
  std::size_t field_start_ = 0;
  std::size_t field_buf_begin_ = 0;
  std::size_t quote_pos_ = 0;  // index of a candidate closing quote

  bool dirty_ = false;
  bool in_field_ = false;
  bool at_row_start_ = true;
  bool quote_flushed_ = false;  // the closing quote's content is already buffered
  bool skip_lf_ = false;        // the previous chunk ended on a CR
  bool unterminated_ = false;

  std::string row_buf_;
  std::vector<Span> spans_;
  std::vector<std::string_view> views_;
  std::size_t rows_ = 0;
  std::size_t quote_anomalies_ = 0;
};

}  // namespace chartbay
