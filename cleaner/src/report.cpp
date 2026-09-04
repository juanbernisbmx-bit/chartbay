#include "chartbay/report.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace chartbay {
namespace {

void escape_json(std::string& out, std::string_view s) {
  out.push_back('"');
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  out.push_back('"');
}

// JSON has no NaN or Infinity, so anything non-finite becomes null.
void json_number(std::string& out, double v) {
  if (!std::isfinite(v)) {
    out += "null";
    return;
  }
  out += format_number(v);
}

void json_uint(std::string& out, std::size_t v) { out += std::to_string(v); }

const char* order_name(DateOrder o) {
  switch (o) {
    case DateOrder::YMD: return "ymd";
    case DateOrder::DMY: return "dmy";
    case DateOrder::MDY: return "mdy";
    case DateOrder::Unknown: break;
  }
  return "unknown";
}

const char* grain_name(DateGrain g) {
  switch (g) {
    case DateGrain::Day: return "day";
    case DateGrain::Month: return "month";
    case DateGrain::Quarter: return "quarter";
    case DateGrain::Year: return "year";
  }
  return "day";
}

}  // namespace

std::string to_json(const CleanResult& result) {
  std::string out;
  out.reserve(4096);
  out += "{\"rowsIn\":";
  json_uint(out, result.rows_in);
  out += ",\"rowsOut\":";
  json_uint(out, result.rows_out);
  out += ",\"columnsOut\":";
  json_uint(out, result.columns.size());

  out += ",\"dialect\":{\"delimiter\":";
  escape_json(out, std::string(1, result.dialect.delimiter));
  out += ",\"quote\":";
  escape_json(out, std::string(1, result.dialect.quote));
  out += ",\"hasHeader\":";
  out += result.dialect.has_header ? "true" : "false";
  out += "},\"quoteAnomalies\":";
  json_uint(out, result.quote_anomalies);
  out += ",\"unterminatedQuote\":";
  out += result.unterminated_quote ? "true" : "false";

  if (!result.error.empty()) {
    out += ",\"error\":";
    escape_json(out, result.error);
  }

  if (result.time_index.found || result.time_index.ambiguous) {
    const TimeIndex& t = result.time_index;
    out += ",\"timeIndex\":{\"found\":";
    out += t.found ? "true" : "false";
    out += ",\"ambiguous\":";
    out += t.ambiguous ? "true" : "false";
    out += ",\"column\":";
    escape_json(out, t.column);
    out += ",\"frequency\":";
    escape_json(out, frequency_code(t.frequency));
    out += ",\"ordered\":";
    out += t.ordered ? "true" : "false";
    out += ",\"sorted\":";
    out += t.sorted_here ? "true" : "false";
    out += ",\"observations\":";
    json_uint(out, t.observations);
    out += ",\"periodsObserved\":";
    json_uint(out, t.periods_observed);
    out += ",\"periodsExpected\":";
    json_uint(out, t.periods_expected);
    out += ",\"duplicates\":";
    json_uint(out, t.duplicates);
    out += ",\"missingPeriods\":";
    json_uint(out, t.missing_periods);
    out += ",\"first\":";
    escape_json(out, t.first);
    out += ",\"last\":";
    escape_json(out, t.last);
    out += ",\"gapExamples\":[";
    for (std::size_t i = 0; i < t.gap_examples.size(); ++i) {
      if (i) out.push_back(',');
      escape_json(out, t.gap_examples[i]);
    }
    out += "]}";
  }

  if (!result.fuzzy_matches.empty()) {
    out += ",\"fuzzyMatches\":[";
    for (std::size_t i = 0; i < result.fuzzy_matches.size(); ++i) {
      const FuzzyMatch& m = result.fuzzy_matches[i];
      if (i) out.push_back(',');
      out += "{\"column\":";
      escape_json(out, m.column);
      out += ",\"from\":";
      escape_json(out, m.from);
      out += ",\"to\":";
      escape_json(out, m.to);
      out += ",\"fromCount\":";
      json_uint(out, m.from_count);
      out += ",\"toCount\":";
      json_uint(out, m.to_count);
      out += ",\"distance\":";
      json_uint(out, m.distance);
      out.push_back('}');
    }
    out.push_back(']');
  }

  out += ",\"columns\":[";
  for (std::size_t j = 0; j < result.columns.size(); ++j) {
    const Column& col = result.columns[j];
    const ColumnStats& s = col.stats;
    if (j) out.push_back(',');
    out += "{\"name\":";
    escape_json(out, col.name);
    out += ",\"originalName\":";
    escape_json(out, col.original_name);
    out += ",\"type\":";
    escape_json(out, type_name(col.type));
    out += ",\"present\":";
    json_uint(out, s.present);
    out += ",\"missing\":";
    json_uint(out, s.missing);
    out += ",\"invalid\":";
    json_uint(out, s.invalid);
    out += ",\"unique\":";
    json_uint(out, s.unique);
    out += ",\"uniqueCapped\":";
    out += s.unique_capped ? "true" : "false";
    out += ",\"outliers\":";
    json_uint(out, s.outliers);

    if (s.has_moments) {
      out += ",\"min\":";
      json_number(out, s.min);
      out += ",\"max\":";
      json_number(out, s.max);
      out += ",\"mean\":";
      json_number(out, s.mean);
      out += ",\"sd\":";
      json_number(out, s.sd);
    }
    if (s.has_quantiles) {
      out += ",\"p25\":";
      json_number(out, s.p25);
      out += ",\"p50\":";
      json_number(out, s.p50);
      out += ",\"p75\":";
      json_number(out, s.p75);
    }

    if (col.type == ColumnType::Numeric) {
      out += ",\"decimalSeparator\":";
      escape_json(out, std::string(1, col.number_format.decimal));
      out += ",\"sawPercent\":";
      out += s.saw_percent ? "true" : "false";
      out += ",\"sawCurrency\":";
      out += s.saw_currency ? "true" : "false";
      out += ",\"ambiguousDecimal\":";
      out += s.ambiguous_decimal ? "true" : "false";
    }
    if (col.type == ColumnType::Date) {
      out += ",\"dateOrder\":";
      escape_json(out, order_name(col.date_order));
      out += ",\"dateGrain\":";
      escape_json(out, grain_name(col.date_grain));
      out += ",\"ambiguousDateOrder\":";
      out += s.ambiguous_date_order ? "true" : "false";
      if (s.has_moments) {
        out += ",\"minDate\":";
        escape_json(out, to_iso(date_from_serial(static_cast<std::int64_t>(s.min),
                                                 col.date_grain)));
        out += ",\"maxDate\":";
        escape_json(out, to_iso(date_from_serial(static_cast<std::int64_t>(s.max),
                                                 col.date_grain)));
      }
    }
    if (col.type == ColumnType::Categorical) {
      out += ",\"levels\":[";
      // The dictionary can be large; the report shows the head and says so.
      const std::size_t shown = col.levels.size() < 64 ? col.levels.size() : 64;
      for (std::size_t i = 0; i < shown; ++i) {
        if (i) out.push_back(',');
        escape_json(out, col.levels[i]);
      }
      out += "],\"levelsTruncated\":";
      out += shown < col.levels.size() ? "true" : "false";
    }
    out.push_back('}');
  }
  out += "]";

  out += ",\"actions\":[";
  for (std::size_t i = 0; i < result.actions.size(); ++i) {
    const Action& a = result.actions[i];
    if (i) out.push_back(',');
    out += "{\"kind\":";
    escape_json(out, action_code(a.kind));
    out += ",\"column\":";
    escape_json(out, a.column);
    out += ",\"count\":";
    json_uint(out, a.count);
    out += ",\"detail\":";
    escape_json(out, a.detail);
    out.push_back('}');
  }
  out += "]}";
  return out;
}

namespace {

// printf alinea contando bytes. En UTF-8 eso corre la tabla un lugar por cada
// acento — y ahora que el arreglo de encoding hace que los acentos sobrevivan,
// una columna llamada "region" con tilde desalinea toda la fila. Peor: cortar
// un nombre largo por byte puede partir un caracter al medio y dejar el resumen
// con bytes invalidos.
//
// Se cuentan caracteres, no anchos de celda tipografica: para un CSV en
// castellano es lo mismo, y contar ancho real pediria una tabla de Unicode.
std::size_t utf8_length(std::string_view s) {
  std::size_t n = 0;
  for (char c : s) n += (static_cast<unsigned char>(c) & 0xC0) != 0x80;
  return n;
}

std::string_view utf8_prefix(std::string_view s, std::size_t chars) {
  std::size_t seen = 0, i = 0;
  for (; i < s.size(); ++i) {
    if ((static_cast<unsigned char>(s[i]) & 0xC0) == 0x80) continue;
    if (seen == chars) break;
    ++seen;
  }
  return s.substr(0, i);
}

// Campo de ancho fijo, recortando por caracter y rellenando a la izquierda o a
// la derecha segun `left`.
std::string utf8_field(std::string_view s, std::size_t width, bool left = true) {
  std::string out(s);
  if (utf8_length(out) > width) {
    out = std::string(utf8_prefix(out, width > 3 ? width - 3 : width)) + "...";
  }
  const std::size_t pad = width - std::min(width, utf8_length(out));
  return left ? out + std::string(pad, ' ') : std::string(pad, ' ') + out;
}

}  // namespace

std::string to_text(const CleanResult& result) {
  std::string out;
  char buf[256];

  std::snprintf(buf, sizeof buf, "%zu filas leídas → %zu filas, %zu columnas\n",
                result.rows_in, result.rows_out, result.columns.size());
  out += buf;

  const std::string delim = result.dialect.delimiter == '\t' ? "\\t"
                            : result.dialect.delimiter == kNoDelimiter
                                ? "ninguno"
                                : std::string(1, result.dialect.delimiter);
  std::snprintf(buf, sizeof buf, "separador '%s'  encabezado %s\n", delim.c_str(),
                result.dialect.has_header ? "sí" : "no");
  out += buf;

  if (result.time_index.ambiguous) {
    out += "índice: hay más de una columna de fechas, ninguna se tomó como índice\n";
  }
  if (const TimeIndex& t = result.time_index; t.found) {
    out += "índice '" + t.column + "'  " + frequency_label(t.frequency) + "  " + t.first +
           " → " + t.last;
    if (t.duplicates > 0) {
      out += "  " + std::to_string(t.duplicates) + (t.duplicates == 1 ? " repetida" : " repetidas");
    }
    if (t.missing_periods > 0) {
      out += "  " + std::to_string(t.missing_periods) +
             (t.missing_periods == 1 ? " faltante" : " faltantes");
    }
    if (!t.ordered && !t.sorted_here) out += "  SIN ORDENAR";
    if (t.sorted_here) out += "  (reordenado)";
    out.push_back('\n');
  }
  out.push_back('\n');

  out += utf8_field("columna", 24) + " " + utf8_field("tipo", 12) + " " +
         utf8_field("n", 9, false) + " " + utf8_field("faltan", 9, false) + " " +
         utf8_field("únicos", 9, false) + " " + utf8_field("atípicos", 9, false) + "\n";
  out += std::string(78, '-') + "\n";

  for (const Column& col : result.columns) {
    std::snprintf(buf, sizeof buf, "%-12s %9zu %9zu %9zu %9zu\n", type_name(col.type),
                  col.stats.present, col.stats.missing, col.stats.unique, col.stats.outliers);
    out += utf8_field(col.name, 24) + " " + buf;
    if (col.stats.has_moments && col.type == ColumnType::Numeric) {
      std::snprintf(buf, sizeof buf, "%-24s   min %s  p50 %s  max %s  media %s  sd %s\n", "",
                    format_number(col.stats.min).c_str(), format_number(col.stats.p50).c_str(),
                    format_number(col.stats.max).c_str(), format_number(col.stats.mean).c_str(),
                    format_number(col.stats.sd).c_str());
      out += buf;
    } else if (col.stats.has_moments && col.type == ColumnType::Date) {
      const std::string lo =
          to_iso(date_from_serial(static_cast<std::int64_t>(col.stats.min), col.date_grain));
      const std::string hi =
          to_iso(date_from_serial(static_cast<std::int64_t>(col.stats.max), col.date_grain));
      std::snprintf(buf, sizeof buf, "%-24s   %s → %s\n", "", lo.c_str(), hi.c_str());
      out += buf;
    }
  }

  if (!result.actions.empty()) {
    out += "\nacciones\n";
    out += std::string(78, '-') + "\n";
    for (const Action& a : result.actions) {
      out += "  · ";
      out += a.detail;
      out += "\n";
    }
  }
  if (!result.fuzzy_matches.empty()) {
    out += "\nescrituras parecidas (no se fusionaron)\n";
    out += std::string(78, '-') + "\n";
    for (const FuzzyMatch& m : result.fuzzy_matches) {
      out += "  · " + m.column + ": \"" + m.from + "\" (" + std::to_string(m.from_count) +
             ") se parece a \"" + m.to + "\" (" + std::to_string(m.to_count) + ")\n";
    }
    out += "  se detectaron pero no se tocaron, porque corriste --no-fuzzy-categories\n";
  }

  if (!result.error.empty()) {
    out += "\nerror: " + result.error + "\n";
  }
  return out;
}

}  // namespace chartbay
