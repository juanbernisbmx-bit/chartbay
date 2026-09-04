// Value-level normalization: the layer that turns a raw CSV cell into a number,
// a date, or a missing marker. Everything here is per-cell and allocation-free
// on the hot path, so it can run over tens of millions of cells.
//
// The hard part is that the meaning of "1.234" depends on the column, not on
// the cell: it is 1234 in es-AR and 1.234 in en-US. So parsing is a two-phase
// affair — collect votes over a sample (NumberFormatVotes / DateOrderVotes),
// resolve one format for the whole column, then parse every cell with it.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace chartbay {

// Strips ASCII whitespace plus the UTF-8 spaces that leak out of spreadsheets
// and PDFs: NBSP (U+00A0), narrow NBSP (U+202F), thin space (U+2009),
// zero-width space (U+200B) and a stray BOM (U+FEFF).
std::string_view trim(std::string_view s);

// True when the whole trimmed token is one of the missing-value sentinels:
// "", NA, N/A, #N/A, NULL, NONE, NIL, -, --, ., ?, s/d, NaN, missing...
bool is_missing_token(std::string_view s);

/**
 * Clave con la que se comparan dos escrituras de la misma categoría.
 *
 * Pasa a minúsculas, saca los acentos y colapsa los espacios internos, todo
 * sobre UTF-8. "Buenos Aires", "buenos aires" y "BUENOS  AIRES" dan la misma
 * clave; "Córdoba" y "Cordoba" también. Es una clave de comparación y nada
 * más: el nivel que se muestra sigue siendo una de las escrituras del archivo,
 * nunca esta forma aplanada.
 *
 * Cubre Latin-1 y los agregados de Windows-1252, que es todo el castellano,
 * portugués, francés, italiano y alemán. Lo que caiga afuera pasa tal cual: es
 * preferible no unificar a unificar mal.
 */
std::string category_key(std::string_view s);

/**
 * Distancia de edición entre dos claves, contando también las transposiciones.
 *
 * Damerau y no Levenshtein a secas porque el error de tipeo más común es
 * cambiar dos letras de lugar — "Buenos Aries" —, y para Levenshtein eso son
 * dos ediciones, lo mismo que dos errores independientes.
 *
 * Corta apenas se pasa de `max` y devuelve `max + 1`: acá se compara cada nivel
 * contra todos los demás, y lo único que importa es si están cerca.
 */
std::size_t edit_distance(std::string_view a, std::string_view b, std::size_t max);

// ── Numbers ───────────────────────────────────────────────────────────────────

// The decimal separator inferred for a column. The group separator is always
// the other member of the pair, so one char pins the whole format.
struct NumberFormat {
  char decimal = '.';
  char group() const { return decimal == ',' ? '.' : ','; }
};

struct NumberParse {
  bool ok = false;
  double value = 0.0;
  bool percent = false;     // the cell carried a % sign
  bool currency = false;    // the cell carried a currency symbol or ISO code
  bool accounting = false;  // negative written as (1.234,56) or 1234-
};

// Parses one cell under `fmt`. Group separators are validated strictly: with
// fmt.decimal == '.', the cell "1,5" is rejected rather than silently read as
// 15, because a comma there cannot be a thousands separator.
NumberParse parse_number(std::string_view raw, NumberFormat fmt);

// Evidence accumulated over a column sample to pick the decimal separator.
// A cell like "1,234" votes for nothing — it is genuinely ambiguous — so a
// column made only of those falls back to the configured default.
struct NumberFormatVotes {
  std::size_t decimal_comma = 0;
  std::size_t decimal_dot = 0;
  std::size_t ambiguous = 0;

  void observe(std::string_view raw);
  NumberFormat resolve(char fallback = '.') const;
  bool undecided() const { return decimal_comma == 0 && decimal_dot == 0; }
};

// ── Dates ─────────────────────────────────────────────────────────────────────

enum class DateOrder : std::uint8_t { Unknown, YMD, DMY, MDY };
enum class DateGrain : std::uint8_t { Day, Month, Quarter, Year };

struct DateParse {
  bool ok = false;
  std::int32_t year = 0;
  std::int32_t month = 1;
  std::int32_t day = 1;
  DateGrain grain = DateGrain::Day;

  // Days since 1970-01-01, proleptic Gregorian. Sub-day grains anchor on the
  // first day of the period so a mixed column still sorts correctly.
  std::int64_t serial() const;
};

// Recognises ISO (2024-03-01), slash/dash/dot triples under `order`, year-month
// (2024-03), quarters (2024Q1, 2024-Q1, Q1 2024) and bare years (2024).
DateParse parse_date(std::string_view raw, DateOrder order);

// Inverse of DateParse::serial(), for rendering a stored column back to text.
DateParse date_from_serial(std::int64_t days, DateGrain grain = DateGrain::Day);

std::string to_iso(const DateParse& d);

// Votes for the component order of a column of date-like cells.
struct DateOrderVotes {
  std::size_t iso = 0;         // 4-digit first component
  std::size_t dmy = 0;         // first component > 12, so it must be a day
  std::size_t mdy = 0;         // second component > 12, so it must be a day
  std::size_t parseable = 0;   // cells that look like a date under any order

  void observe(std::string_view raw);
  DateOrder resolve(DateOrder fallback = DateOrder::DMY) const;
  // True when nothing in the sample disambiguated DD/MM from MM/DD.
  bool undecided() const { return iso == 0 && dmy == 0 && mdy == 0; }
};

// ── Booleans ──────────────────────────────────────────────────────────────────

// Recognises true/false, verdadero/falso, si/sí/no, yes/no, t/f, y/n, 1/0.
// Written as 1.0 / 0.0 so a boolean column can go straight into a regression.
bool parse_bool(std::string_view raw, bool* out);

}  // namespace chartbay
