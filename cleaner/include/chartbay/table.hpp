// The cleaner proper: bytes in, typed columns out.
//
// Everything is one streaming pass. The first `sample_rows` data rows are held
// as raw text while the per-column formats are voted on; once the types are
// settled the sample is converted and released, and the rest of the file goes
// straight into the column buffers. Peak memory is therefore the output, not
// the input — which is the whole reason this exists: the current TypeScript
// path allocates one JS object per row and dies well before the C++ one does.
//
// Output is columnar on purpose. A numeric column is a contiguous
// std::vector<double>, so the WASM build can hand JavaScript a Float64Array
// view over WASM memory with no copy and no per-row object.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "chartbay/scanner.hpp"
#include "chartbay/value.hpp"

namespace chartbay {

enum class ColumnType : std::uint8_t {
  Empty,        // nothing but missing values
  Numeric,      // values[] holds the number
  Date,         // values[] holds days since 1970-01-01
  Categorical,  // codes[] indexes levels[]
  Text,         // text[] holds the raw string
};

const char* type_name(ColumnType t);

enum class MissingPolicy : std::uint8_t { Keep, DropRow, Zero, Mean, Median, Forward };
enum class OutlierPolicy : std::uint8_t { Flag, Winsorize, ToMissing, DropRow };
enum class OutlierRule : std::uint8_t { IQR, ZScore, MAD };

struct CleanOptions {
  // ── Parsing ──
  bool sniff = true;         // when false, `dialect` is used as given
  Dialect dialect;
  char fallback_decimal = '.';
  DateOrder fallback_date_order = DateOrder::DMY;
  // Rows held in memory to vote on formats. Also capped by sample_cells so a
  // 400-column file cannot blow up the sample.
  std::size_t sample_rows = 5000;
  std::size_t sample_cells = 500000;
  // Total input size, when the caller knows it (a file size, a Content-Length).
  // Used only to pre-size the column buffers: growing them by doubling costs
  // several hundred MB of transient allocation on a large file. 0 = unknown.
  std::size_t total_bytes = 0;

  // ── Typing ──
  // Share of non-missing cells that must parse for the column to take the type.
  // Below 1.0 on purpose: a column of ten thousand numbers with three typos in
  // it is a numeric column with three bad cells, not a text column.
  double numeric_threshold = 0.8;
  double date_threshold = 0.9;
  std::size_t max_categorical_levels = 50;
  double categorical_ratio = 0.2;  // unique/non-missing below this is categorical
  bool percent_as_fraction = false;  // "12,5%" → 0.125 instead of 12.5

  // ── Rows and columns ──
  bool drop_empty_rows = true;
  bool drop_duplicate_rows = true;
  bool drop_empty_columns = true;
  bool drop_constant_columns = true;
  bool drop_duplicate_columns = true;

  MissingPolicy missing = MissingPolicy::Keep;
  OutlierPolicy outlier = OutlierPolicy::Flag;
  OutlierRule outlier_rule = OutlierRule::IQR;
  double outlier_k = 3.0;  // IQR multiplier, or sigmas for ZScore/MAD
};

struct ColumnStats {
  std::size_t present = 0;
  std::size_t missing = 0;
  std::size_t invalid = 0;  // non-missing cells that did not parse as the column type
  std::size_t unique = 0;
  bool unique_capped = false;
  std::size_t outliers = 0;

  bool has_moments = false;
  double min = 0, max = 0, mean = 0, sd = 0, p25 = 0, p50 = 0, p75 = 0;

  bool saw_percent = false;
  bool saw_currency = false;
  bool ambiguous_decimal = false;    // no cell in the sample settled . vs ,
  bool ambiguous_date_order = false; // no cell settled DD/MM vs MM/DD
};

struct Column {
  std::string name;
  std::string original_name;
  ColumnType type = ColumnType::Text;
  NumberFormat number_format;
  DateOrder date_order = DateOrder::Unknown;
  DateGrain date_grain = DateGrain::Day;

  std::vector<double> values;       // Numeric and Date
  std::vector<std::uint8_t> mask;   // 1 present, 0 missing — parallel to values/text
  std::vector<std::int32_t> codes;  // Categorical, -1 when missing
  std::vector<std::string> levels;  // Categorical dictionary
  std::vector<std::string> text;    // Text

  ColumnStats stats;
  std::size_t size() const;
};

enum class ActionKind : std::uint8_t {
  InferredDialect,
  InferredDecimal,
  InferredDateOrder,
  AmbiguousDecimal,
  AmbiguousDateOrder,
  PaddedRaggedRow,
  TruncatedRaggedRow,
  DroppedEmptyRows,
  DroppedDuplicateRows,
  DroppedEmptyColumn,
  DroppedConstantColumn,
  DroppedDuplicateColumn,
  RenamedColumn,
  CoercedInvalid,
  ImputedMissing,
  DroppedMissingRows,
  FlaggedOutliers,
  WinsorizedOutliers,
  OutliersToMissing,
  DroppedOutlierRows,
  MalformedQuotes,
  UnterminatedQuote,
};

const char* action_code(ActionKind k);

// Every action carries its own justification, in the same spirit as
// autoRepair.ts on the TypeScript side: the user should never have to guess
// why a row or a column disappeared.
struct Action {
  ActionKind kind;
  std::string column;  // empty for table-level actions
  std::size_t count = 0;
  std::string detail;
};

struct CleanResult {
  std::vector<Column> columns;
  std::size_t rows_in = 0;   // data rows read, header excluded
  std::size_t rows_out = 0;
  std::vector<Action> actions;
  Dialect dialect;
  std::size_t quote_anomalies = 0;
  bool unterminated_quote = false;
  std::string error;
};

class Cleaner {
 public:
  explicit Cleaner(CleanOptions options = {});
  ~Cleaner();
  Cleaner(const Cleaner&) = delete;
  Cleaner& operator=(const Cleaner&) = delete;

  // Feed the file in order, in chunks of any size.
  void feed(const char* data, std::size_t len);
  // Finishes parsing and runs every cleaning stage. Call once.
  CleanResult finish();

 private:
  class Sink;
  std::unique_ptr<Sink> impl_;
};

// Convenience wrapper for callers that already hold the whole file.
CleanResult clean_buffer(std::string_view data, const CleanOptions& options = {});

// Renders a cleaned table back to CSV (ISO dates, dot decimals, empty cell for
// missing). Used by the CLI and available to the browser for export.
std::string to_csv(const CleanResult& result, char delimiter = ',');

// Same output, streamed a block at a time. The whole-string form would peak at
// hundreds of MB on the files this library exists for.
void write_csv(std::FILE* out, const CleanResult& result, char delimiter = ',');

// Shortest decimal string that reads back as exactly the same double.
std::string format_number(double v);

}  // namespace chartbay
