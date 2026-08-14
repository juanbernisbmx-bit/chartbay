// C ABI for the WebAssembly build.
//
// Deliberately not embind: the whole point of running this in the browser is to
// hand JavaScript pointers it can wrap with typed arrays, with no per-row and
// no per-cell crossing of the JS/WASM boundary. A numeric column comes back as
// one Float64Array view over WASM memory — zero copies, zero objects.
//
// Ownership: every pointer returned here belongs to the handle and stays valid
// until cbc_destroy. Typed-array views must be re-taken after anything that can
// grow WASM memory (that is, after any cbc_feed or cbc_finish), because growth
// detaches the old ArrayBuffer.
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <new>
#include <string>
#include <vector>

#include "chartbay/report.hpp"
#include "chartbay/table.hpp"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define CBC_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define CBC_EXPORT extern "C"
#endif

namespace {

using namespace chartbay;

// Text columns are handed over as one blob plus offsets, so reading a million
// strings is two typed-array reads rather than a million calls.
struct TextBlob {
  std::string bytes;
  std::vector<std::uint32_t> offsets;  // size() == rows + 1
  bool built = false;
};

struct Handle {
  std::unique_ptr<Cleaner> cleaner;
  CleanResult result;
  std::string report;
  std::vector<TextBlob> blobs;
  std::vector<std::string> name_cache;
  bool finished = false;
  int error = 0;  // 0 ok, 1 bad state, 2 out of memory, 3 internal
};

// Option indices. Mirrored by CLEAN_OPTION_LAYOUT in js/csvclean.ts — keep the
// two in step.
enum Ints {
  kSniff = 0,
  kDelimiter,
  kHasHeader,
  kFallbackDecimal,
  kFallbackDateOrder,
  kSampleRows,
  kMaxCategoricalLevels,
  kPercentAsFraction,
  kDropEmptyRows,
  kDropDuplicateRows,
  kDropEmptyColumns,
  kDropConstantColumns,
  kDropDuplicateColumns,
  kMissingPolicy,
  kOutlierPolicy,
  kOutlierRule,
  kIntCount,
};

enum Reals {
  kNumericThreshold = 0,
  kDateThreshold,
  kCategoricalRatio,
  kOutlierK,
  // Total input size, as a double so it survives past 2 GB. Only a hint, used
  // to pre-size the column buffers.
  kTotalBytes,
  kRealCount,
};

CleanOptions decode_options(const std::int32_t* ints, std::int32_t nints, const double* reals,
                            std::int32_t nreals) {
  CleanOptions opts;
  const auto geti = [&](int index, std::int32_t fallback) {
    return (ints && index < nints) ? ints[index] : fallback;
  };
  const auto getr = [&](int index, double fallback) {
    return (reals && index < nreals) ? reals[index] : fallback;
  };

  opts.sniff = geti(kSniff, 1) != 0;
  const std::int32_t delimiter = geti(kDelimiter, 0);
  if (delimiter > 0) {
    opts.dialect.delimiter = static_cast<char>(delimiter);
    opts.sniff = false;
  }
  opts.dialect.has_header = geti(kHasHeader, 1) != 0;
  opts.fallback_decimal = static_cast<char>(geti(kFallbackDecimal, '.'));
  switch (geti(kFallbackDateOrder, 2)) {
    case 1: opts.fallback_date_order = DateOrder::YMD; break;
    case 3: opts.fallback_date_order = DateOrder::MDY; break;
    default: opts.fallback_date_order = DateOrder::DMY; break;
  }
  if (const std::int32_t rows = geti(kSampleRows, 0); rows > 0) {
    opts.sample_rows = static_cast<std::size_t>(rows);
  }
  if (const std::int32_t levels = geti(kMaxCategoricalLevels, 0); levels > 0) {
    opts.max_categorical_levels = static_cast<std::size_t>(levels);
  }
  opts.percent_as_fraction = geti(kPercentAsFraction, 0) != 0;
  opts.drop_empty_rows = geti(kDropEmptyRows, 1) != 0;
  opts.drop_duplicate_rows = geti(kDropDuplicateRows, 1) != 0;
  opts.drop_empty_columns = geti(kDropEmptyColumns, 1) != 0;
  opts.drop_constant_columns = geti(kDropConstantColumns, 1) != 0;
  opts.drop_duplicate_columns = geti(kDropDuplicateColumns, 1) != 0;

  switch (geti(kMissingPolicy, 0)) {
    case 1: opts.missing = MissingPolicy::DropRow; break;
    case 2: opts.missing = MissingPolicy::Zero; break;
    case 3: opts.missing = MissingPolicy::Mean; break;
    case 4: opts.missing = MissingPolicy::Median; break;
    case 5: opts.missing = MissingPolicy::Forward; break;
    default: opts.missing = MissingPolicy::Keep; break;
  }
  switch (geti(kOutlierPolicy, 0)) {
    case 1: opts.outlier = OutlierPolicy::Winsorize; break;
    case 2: opts.outlier = OutlierPolicy::ToMissing; break;
    case 3: opts.outlier = OutlierPolicy::DropRow; break;
    default: opts.outlier = OutlierPolicy::Flag; break;
  }
  switch (geti(kOutlierRule, 0)) {
    case 1: opts.outlier_rule = OutlierRule::ZScore; break;
    case 2: opts.outlier_rule = OutlierRule::MAD; break;
    default: opts.outlier_rule = OutlierRule::IQR; break;
  }

  opts.numeric_threshold = getr(kNumericThreshold, opts.numeric_threshold);
  opts.date_threshold = getr(kDateThreshold, opts.date_threshold);
  opts.categorical_ratio = getr(kCategoricalRatio, opts.categorical_ratio);
  opts.outlier_k = getr(kOutlierK, opts.outlier_k);
  if (const double total = getr(kTotalBytes, 0.0); total > 0.0) {
    opts.total_bytes = static_cast<std::size_t>(total);
  }
  return opts;
}

Handle* as_handle(void* h) { return static_cast<Handle*>(h); }

bool column_ok(Handle* handle, std::int32_t j) {
  return handle && handle->finished && j >= 0 &&
         static_cast<std::size_t>(j) < handle->result.columns.size();
}

void build_blob(Handle* handle, std::int32_t j) {
  TextBlob& blob = handle->blobs[static_cast<std::size_t>(j)];
  if (blob.built) return;
  const Column& col = handle->result.columns[static_cast<std::size_t>(j)];
  blob.built = true;
  blob.offsets.reserve(col.text.size() + 1);
  blob.offsets.push_back(0);
  for (const std::string& value : col.text) {
    blob.bytes.append(value);
    blob.offsets.push_back(static_cast<std::uint32_t>(blob.bytes.size()));
  }
}

}  // namespace

// ── Memory the caller can write into ──────────────────────────────────────────

CBC_EXPORT std::uint8_t* cbc_alloc(std::size_t n) {
  return static_cast<std::uint8_t*>(std::malloc(n ? n : 1));
}

CBC_EXPORT void cbc_free(std::uint8_t* p) { std::free(p); }

// ── Lifecycle ─────────────────────────────────────────────────────────────────

CBC_EXPORT void* cbc_create(const std::int32_t* ints, std::int32_t nints, const double* reals,
                            std::int32_t nreals) {
  auto* handle = new (std::nothrow) Handle();
  if (!handle) return nullptr;
  handle->cleaner =
      std::make_unique<Cleaner>(decode_options(ints, nints, reals, nreals));
  return handle;
}

CBC_EXPORT void cbc_destroy(void* h) { delete as_handle(h); }

CBC_EXPORT std::int32_t cbc_feed(void* h, const std::uint8_t* data, std::size_t n) {
  Handle* handle = as_handle(h);
  if (!handle || handle->finished || !handle->cleaner) return 1;
  try {
    handle->cleaner->feed(reinterpret_cast<const char*>(data), n);
  } catch (const std::bad_alloc&) {
    handle->error = 2;
    return 2;
  } catch (...) {
    handle->error = 3;
    return 3;
  }
  return 0;
}

CBC_EXPORT std::int32_t cbc_finish(void* h) {
  Handle* handle = as_handle(h);
  if (!handle || handle->finished || !handle->cleaner) return 1;
  try {
    handle->result = handle->cleaner->finish();
  } catch (const std::bad_alloc&) {
    handle->error = 2;
    return 2;
  } catch (...) {
    handle->error = 3;
    return 3;
  }
  handle->cleaner.reset();  // the sample and scanner buffers go away here
  handle->finished = true;
  handle->blobs.resize(handle->result.columns.size());
  handle->name_cache.resize(handle->result.columns.size());
  return 0;
}

CBC_EXPORT std::int32_t cbc_error(void* h) {
  Handle* handle = as_handle(h);
  return handle ? handle->error : 1;
}

// ── Shape ─────────────────────────────────────────────────────────────────────

CBC_EXPORT std::size_t cbc_row_count(void* h) {
  Handle* handle = as_handle(h);
  return (handle && handle->finished) ? handle->result.rows_out : 0;
}

CBC_EXPORT std::int32_t cbc_column_count(void* h) {
  Handle* handle = as_handle(h);
  return (handle && handle->finished)
             ? static_cast<std::int32_t>(handle->result.columns.size())
             : 0;
}

CBC_EXPORT const char* cbc_column_name(void* h, std::int32_t j) {
  Handle* handle = as_handle(h);
  if (!column_ok(handle, j)) return "";
  return handle->result.columns[static_cast<std::size_t>(j)].name.c_str();
}

// 0 empty, 1 numeric, 2 date, 3 categorical, 4 text
CBC_EXPORT std::int32_t cbc_column_type(void* h, std::int32_t j) {
  Handle* handle = as_handle(h);
  if (!column_ok(handle, j)) return 0;
  switch (handle->result.columns[static_cast<std::size_t>(j)].type) {
    case ColumnType::Numeric: return 1;
    case ColumnType::Date: return 2;
    case ColumnType::Categorical: return 3;
    case ColumnType::Text: return 4;
    case ColumnType::Empty: break;
  }
  return 0;
}

// ── Column data ───────────────────────────────────────────────────────────────

// Numeric: the value. Date: days since 1970-01-01. Null for other types.
CBC_EXPORT const double* cbc_column_values(void* h, std::int32_t j) {
  Handle* handle = as_handle(h);
  if (!column_ok(handle, j)) return nullptr;
  const Column& col = handle->result.columns[static_cast<std::size_t>(j)];
  return col.values.empty() ? nullptr : col.values.data();
}

// One byte per row: 1 present, 0 missing. Present for every column type.
CBC_EXPORT const std::uint8_t* cbc_column_mask(void* h, std::int32_t j) {
  Handle* handle = as_handle(h);
  if (!column_ok(handle, j)) return nullptr;
  const Column& col = handle->result.columns[static_cast<std::size_t>(j)];
  return col.mask.empty() ? nullptr : col.mask.data();
}

// Categorical: index into the level list, -1 when missing.
CBC_EXPORT const std::int32_t* cbc_column_codes(void* h, std::int32_t j) {
  Handle* handle = as_handle(h);
  if (!column_ok(handle, j)) return nullptr;
  const Column& col = handle->result.columns[static_cast<std::size_t>(j)];
  return col.codes.empty() ? nullptr : col.codes.data();
}

CBC_EXPORT std::int32_t cbc_level_count(void* h, std::int32_t j) {
  Handle* handle = as_handle(h);
  if (!column_ok(handle, j)) return 0;
  return static_cast<std::int32_t>(
      handle->result.columns[static_cast<std::size_t>(j)].levels.size());
}

CBC_EXPORT const char* cbc_level_name(void* h, std::int32_t j, std::int32_t k) {
  Handle* handle = as_handle(h);
  if (!column_ok(handle, j) || k < 0) return "";
  const Column& col = handle->result.columns[static_cast<std::size_t>(j)];
  if (static_cast<std::size_t>(k) >= col.levels.size()) return "";
  return col.levels[static_cast<std::size_t>(k)].c_str();
}

// Text columns, as one UTF-8 blob plus rows+1 offsets. Built on first request.
CBC_EXPORT const char* cbc_text_blob(void* h, std::int32_t j) {
  Handle* handle = as_handle(h);
  if (!column_ok(handle, j)) return nullptr;
  build_blob(handle, j);
  return handle->blobs[static_cast<std::size_t>(j)].bytes.c_str();
}

CBC_EXPORT const std::uint32_t* cbc_text_offsets(void* h, std::int32_t j) {
  Handle* handle = as_handle(h);
  if (!column_ok(handle, j)) return nullptr;
  build_blob(handle, j);
  return handle->blobs[static_cast<std::size_t>(j)].offsets.data();
}

// Drops a column's payload once the caller has copied it out. WASM memory
// never shrinks, so this does not return anything to the browser — but it does
// let the module's own allocator reuse the space instead of growing further.
CBC_EXPORT void cbc_release_column(void* h, std::int32_t j) {
  Handle* handle = as_handle(h);
  if (!column_ok(handle, j)) return;
  Column& col = handle->result.columns[static_cast<std::size_t>(j)];
  std::vector<double>().swap(col.values);
  std::vector<std::uint8_t>().swap(col.mask);
  std::vector<std::int32_t>().swap(col.codes);
  std::vector<std::string>().swap(col.text);
  TextBlob& blob = handle->blobs[static_cast<std::size_t>(j)];
  std::string().swap(blob.bytes);
  std::vector<std::uint32_t>().swap(blob.offsets);
}

// ── Report ────────────────────────────────────────────────────────────────────

CBC_EXPORT const char* cbc_report_json(void* h) {
  Handle* handle = as_handle(h);
  if (!handle || !handle->finished) return "{}";
  if (handle->report.empty()) handle->report = to_json(handle->result);
  return handle->report.c_str();
}
