#include "chartbay/report.hpp"

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
  std::snprintf(buf, sizeof buf, "separador '%s'  encabezado %s\n\n", delim.c_str(),
                result.dialect.has_header ? "sí" : "no");
  out += buf;

  std::snprintf(buf, sizeof buf, "%-24s %-12s %9s %9s %9s %9s\n", "columna", "tipo", "n",
                "faltan", "únicos", "atípicos");
  out += buf;
  out += std::string(78, '-') + "\n";

  for (const Column& col : result.columns) {
    std::string name = col.name;
    if (name.size() > 24) name = name.substr(0, 21) + "...";
    std::snprintf(buf, sizeof buf, "%-24s %-12s %9zu %9zu %9zu %9zu\n", name.c_str(),
                  type_name(col.type), col.stats.present, col.stats.missing,
                  col.stats.unique, col.stats.outliers);
    out += buf;
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
  if (!result.error.empty()) {
    out += "\nerror: " + result.error + "\n";
  }
  return out;
}

}  // namespace chartbay
