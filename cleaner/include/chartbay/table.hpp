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
  /**
   * Fuerza el separador decimal, ignorando la votación.
   *
   * `fallback_decimal` solo entra cuando el archivo entero quedó indeciso: una
   * columna ambigua hereda lo que votó el resto. Eso es lo correcto por
   * defecto, pero deja al usuario sin forma de decir "leelo al revés" cuando la
   * votación acertó para unas columnas y no para otras. '\0' = sin forzar.
   */
  char force_decimal = '\0';
  /** Igual que force_decimal, para el orden de las fechas. */
  DateOrder force_date_order = DateOrder::Unknown;
  /**
   * Detecta y saltea las filas de basura encima del encabezado.
   *
   * Un export de planilla casi nunca empieza en la fila de nombres: arriba hay
   * un titulo, la fecha de emision, a veces una linea en blanco. Con `sniff`
   * activo esto se decide solo; `dialect.preamble_rows` sirve para fijarlo a
   * mano, y ahi este interruptor no interviene.
   */
  bool detect_preamble = true;
  /**
   * Traduce a UTF-8 lo que no sea UTF-8 válido, leyéndolo como Windows-1252.
   *
   * Excel en español guarda en Windows-1252: sin esto "Córdoba" sale "C?rdoba"
   * en el archivo limpio y nada lo dice. Un archivo que ya está en UTF-8 pasa
   * byte a byte idéntico, así que prenderlo no tiene costo de corrección — solo
   * conviene apagarlo para mirar los bytes crudos de un archivo en algún otro
   * encoding.
   */
  bool fix_encoding = true;

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
  /**
   * Unifica las escrituras de una misma categoría.
   *
   * "Buenos Aires", "buenos aires" y "BUENOS  AIRES" son un solo nivel, y
   * "Córdoba" y "Cordoba" también. La comparación ignora mayúsculas, acentos y
   * espacios internos; el nivel que queda es la escritura **más frecuente del
   * archivo**, nunca una forma aplanada inventada.
   *
   * No es cosmético. Cada escritura de más es una dummy de más en la
   * regresión, y sobre todo: son las escrituras repetidas las que inflan el
   * conteo de únicos, así que una columna de provincias con ruido de mayúsculas
   * se tipaba como texto libre y no entraba a ningún modelo.
   *
   * Toda fusión queda escrita en el reporte con las dos escrituras a la vista,
   * porque acá — a diferencia del resto de la limpieza — se está cambiando lo
   * que el archivo dice.
   */
  bool unify_categories = true;
  /**
   * Analiza la columna de fechas como índice temporal: frecuencia, fechas
   * repetidas y períodos faltantes.
   */
  bool analyze_time_index = true;
  /**
   * Ordena las filas por fecha cuando la columna de fechas es inequívocamente
   * el índice: una sola columna de fechas, sin faltantes y sin repetidas.
   *
   * Las tres condiciones no son cautela de más. Con fechas repetidas lo que hay
   * suele ser un panel — provincia por mes —, y ordenar solo por fecha mezcla
   * las unidades y arruina cualquier rezago. Con más de una columna de fechas
   * no se sabe cuál es el índice. Fuera de esos casos, ordenar es lo correcto:
   * el arrastre de faltantes y todo el motor de series suponen orden temporal,
   * y sobre filas desordenadas devuelven un número, no un error.
   */
  bool sort_by_time = true;
  double categorical_ratio = 0.2;  // unique/non-missing below this is categorical
  bool percent_as_fraction = false;  // "12,5%" → 0.125 instead of 12.5

  // ── Rows and columns ──
  bool drop_empty_rows = true;
  bool drop_duplicate_rows = true;
  /**
   * Descarta la fila de totales del final.
   *
   * Un subtotal adentro de la columna no es un dato de mas: es un dato de otra
   * escala. En un archivo de cien filas de ~1500 la fila TOTAL lleva la media
   * de 1537 a 3068 y el desvio de 290 a 15296, y como es una sola fila no hay
   * nada en el perfil que lo delate salvo el maximo. Se reconoce por la
   * etiqueta ("TOTAL", "Suma"), por la aritmetica (el valor es exactamente la
   * suma de lo que tiene encima) o por la forma (una nota al pie suelta), y
   * nunca se descarta sin decir cual de las tres fue.
   */
  bool drop_footer_rows = true;
  bool drop_empty_columns = true;
  bool drop_constant_columns = true;
  bool drop_duplicate_columns = true;

  // Streaming profile only: count rows, missing cells and invalid cells, and
  // track running moments, without ever materialising a column. Memory becomes
  // O(columns) instead of O(rows), so the file may be arbitrarily larger than
  // available memory. Quantiles, outliers, duplicate-row and duplicate-column
  // detection and every row-level policy are unavailable in this mode, because
  // all of them need the values kept. El pie de tabla se sigue reconociendo
  // cuando el archivo entero entra en la muestra; mas alla de eso hace falta la
  // columna materializada para comparar el total contra la suma.
  bool scan_only = false;

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

  bool has_moments = false;   // min, max, mean and sd are valid
  bool has_quantiles = false; // p25, p50 and p75 are valid (never in scan mode)
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

/**
 * Frecuencia de una serie de tiempo, inferida de los espacios entre
 * observaciones. `BusinessDaily` es la que separa una serie financiera de una
 * diaria con huecos: son los mismos saltos de tres días, pero caen todos en fin
 * de semana.
 */
enum class TimeFrequency : std::uint8_t {
  Unknown,
  Daily,
  BusinessDaily,
  Weekly,
  Fortnightly,
  Monthly,
  Quarterly,
  Semiannual,
  Annual,
};

const char* frequency_code(TimeFrequency f);   // para el JSON
const char* frequency_label(TimeFrequency f);  // para el reporte, en castellano

/**
 * El índice temporal de la tabla: qué columna es, con qué frecuencia avanza, si
 * viene ordenada y qué le falta.
 *
 * Existe porque el motor econométrico da resultados sin sentido — no un error,
 * un número — sobre una serie desordenada o con lagunas. Un ADF sobre filas en
 * orden alfabético de provincia no significa nada, y hasta acá nada lo decía.
 */
struct TimeIndex {
  bool found = false;      // hay una única columna de fechas y se pudo analizar
  bool ambiguous = false;  // hay más de una columna de fechas: no se adivina
  std::string column;
  TimeFrequency frequency = TimeFrequency::Unknown;
  bool ordered = true;       // las fechas venían en orden no decreciente
  bool sorted_here = false;  // se reordenaron las filas
  DateGrain grain = DateGrain::Day;

  std::size_t observations = 0;      // filas con fecha
  std::size_t periods_observed = 0;  // períodos distintos con al menos una
  std::size_t periods_expected = 0;  // los que debería haber entre el primero y el último
  std::size_t duplicates = 0;        // observaciones que caen en un período ya ocupado
  std::size_t missing_periods = 0;   // períodos sin ninguna observación

  std::string first;
  std::string last;
  std::vector<std::string> gap_examples;  // hasta 5, para poder ir a mirarlos
};

enum class ActionKind : std::uint8_t {
  InferredDialect,
  InferredDecimal,
  InferredDateOrder,
  AmbiguousDecimal,
  AmbiguousDateOrder,
  PaddedRaggedRow,
  TruncatedRaggedRow,
  SkippedPreambleRows,
  DroppedFooterRows,
  ConvertedEncoding,
  UnsupportedEncoding,
  UnifiedLevels,
  SortedByTime,
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
  TimeIndex time_index;
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
