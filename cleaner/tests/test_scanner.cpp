#include "chartbay/scanner.hpp"

#include <algorithm>

#include "harness.hpp"

using namespace chartbay;

namespace {

using Rows = std::vector<std::vector<std::string>>;

class Recorder : public RowSink {
 public:
  void on_row(const std::string_view* fields, std::size_t n) override {
    std::vector<std::string> row;
    row.reserve(n);
    for (std::size_t i = 0; i < n; ++i) row.emplace_back(fields[i]);
    rows.push_back(std::move(row));
  }
  Rows rows;
};

// chunk == 0 feeds the whole buffer at once.
Rows scan(std::string_view input, Dialect d = Dialect{}, std::size_t chunk = 0) {
  Recorder rec;
  CsvScanner scanner(d, rec);
  if (chunk == 0) {
    scanner.feed(input.data(), input.size());
  } else {
    for (std::size_t i = 0; i < input.size(); i += chunk) {
      scanner.feed(input.data() + i, std::min(chunk, input.size() - i));
    }
  }
  scanner.finish();
  return rec.rows;
}

std::string render(const Rows& rows) {
  std::string out;
  for (const auto& row : rows) {
    out += "[";
    for (std::size_t i = 0; i < row.size(); ++i) {
      if (i) out += "|";
      out += row[i];
    }
    out += "]";
  }
  return out;
}

// The whole point of a push parser is that chunk boundaries are invisible.
// Feeding the same bytes in every possible block size must give one answer.
void check_chunk_invariance(std::string_view input, Dialect d, const char* file, int line) {
  const std::string expected = render(scan(input, d));
  for (std::size_t chunk = 1; chunk <= input.size() + 1; ++chunk) {
    ++::test::checks();
    const std::string got = render(scan(input, d, chunk));
    if (got != expected) {
      ::test::report(file, line,
                     "chunk=" + std::to_string(chunk) + "  got " + got + ", want " + expected);
      return;  // one failure per input is enough noise
    }
  }
}

#define CHECK_CHUNK_INVARIANT(input, dialect) \
  check_chunk_invariance((input), (dialect), __FILE__, __LINE__)

}  // namespace

CB_TEST(scanner, basic_rows) {
  const Rows r = scan("a,b,c\n1,2,3\n");
  CB_CHECK_EQ(r.size(), static_cast<std::size_t>(2));
  CB_CHECK_EQ(render(r), std::string("[a|b|c][1|2|3]"));
}

CB_TEST(scanner, no_trailing_newline) {
  CB_CHECK_EQ(render(scan("a,b\n1,2")), std::string("[a|b][1|2]"));
}

CB_TEST(scanner, empty_fields_and_trailing_delimiter) {
  CB_CHECK_EQ(render(scan("a,,c\n")), std::string("[a||c]"));
  CB_CHECK_EQ(render(scan("a,b,\n")), std::string("[a|b|]"));
  CB_CHECK_EQ(render(scan("a,b,")), std::string("[a|b|]"));
  CB_CHECK_EQ(render(scan(",,\n")), std::string("[||]"));
}

CB_TEST(scanner, blank_lines_are_skipped) {
  CB_CHECK_EQ(render(scan("a,b\n\n\n1,2\n\n")), std::string("[a|b][1|2]"));
}

CB_TEST(scanner, crlf_and_lone_cr) {
  CB_CHECK_EQ(render(scan("a,b\r\n1,2\r\n")), std::string("[a|b][1|2]"));
  CB_CHECK_EQ(render(scan("a,b\r1,2\r")), std::string("[a|b][1|2]"));
}

CB_TEST(scanner, quoted_fields) {
  CB_CHECK_EQ(render(scan("\"a,b\",c\n")), std::string("[a,b|c]"));
  CB_CHECK_EQ(render(scan("\"line\nbreak\",c\n")), std::string("[line\nbreak|c]"));
  CB_CHECK_EQ(render(scan("\"say \"\"hi\"\"\",c\n")), std::string("[say \"hi\"|c]"));
  CB_CHECK_EQ(render(scan("\"\",x\n")), std::string("[|x]"));
  CB_CHECK_EQ(render(scan("\"a\"\"\",x\n")), std::string("[a\"|x]"));
  CB_CHECK_EQ(render(scan("\"trailing\"")), std::string("[trailing]"));
}

CB_TEST(scanner, malformed_quotes_are_kept_not_dropped) {
  Recorder rec;
  Dialect d;
  CsvScanner scanner(d, rec);
  const std::string input = "\"a\"b\",c\n";
  scanner.feed(input.data(), input.size());
  scanner.finish();
  CB_CHECK_EQ(render(rec.rows), std::string("[a\"b|c]"));
  CB_CHECK_EQ(scanner.quote_anomalies(), static_cast<std::size_t>(1));
}

CB_TEST(scanner, unterminated_quote_is_flagged) {
  Recorder rec;
  Dialect d;
  CsvScanner scanner(d, rec);
  const std::string input = "a,\"never closed\n";
  scanner.feed(input.data(), input.size());
  scanner.finish();
  CB_CHECK(scanner.unterminated_quote());
  CB_CHECK_EQ(render(rec.rows), std::string("[a|never closed\n]"));
}

CB_TEST(scanner, ragged_rows_are_passed_through) {
  CB_CHECK_EQ(render(scan("a,b,c\n1,2\n3,4,5,6\n")), std::string("[a|b|c][1|2][3|4|5|6]"));
}

CB_TEST(scanner, chunk_boundaries_are_invisible) {
  const Dialect comma;
  CHECK_CHUNK_INVARIANT("a,b,c\n1,2,3\n4,5,6\n", comma);
  CHECK_CHUNK_INVARIANT("a,b\r\n1,2\r\n", comma);
  CHECK_CHUNK_INVARIANT("\"a,b\",\"c\nd\"\n1,2\n", comma);
  CHECK_CHUNK_INVARIANT("\"say \"\"hi\"\"\",x\n\"y\"\"\",z\n", comma);
  CHECK_CHUNK_INVARIANT("a,b,\n,,\n\n1,2,3", comma);
  CHECK_CHUNK_INVARIANT("\"\",\"\",\"\"\n", comma);
  CHECK_CHUNK_INVARIANT("largo,\"con , coma\",\"con \"\"comillas\"\"\",fin\n", comma);
}

CB_TEST(sniff, delimiter) {
  CB_CHECK_EQ(sniff_dialect("a,b,c\n1,2,3\n4,5,6\n").delimiter, ',');
  CB_CHECK_EQ(sniff_dialect("a;b;c\n1;2;3\n4;5;6\n").delimiter, ';');
  CB_CHECK_EQ(sniff_dialect("a\tb\tc\n1\t2\t3\n4\t5\t6\n").delimiter, '\t');
  CB_CHECK_EQ(sniff_dialect("a|b|c\n1|2|3\n4|5|6\n").delimiter, '|');
  // Comma-decimal data with a semicolon delimiter: the comma splits nothing
  // consistent, the semicolon does.
  CB_CHECK_EQ(sniff_dialect("pais;pbi;infl\nAR;1.234,5;211,4\nBR;2.173,0;4,6\n").delimiter, ';');
}

CB_TEST(sniff, header_detection) {
  CB_CHECK(sniff_dialect("fecha,valor\n2024-01-01,10\n2024-01-02,11\n").has_header);
  CB_CHECK(!sniff_dialect("1,2\n3,4\n5,6\n").has_header);
  CB_CHECK(sniff_dialect("region,pais\nnorte,AR\nsur,CL\n").has_header);
}

// ── Encoding ─────────────────────────────────────────────────────────────────

namespace {

// Corre el arreglo de encoding partiendo la entrada en bloques de `chunk`
// bytes, que es como llega desde un Blob del navegador.
std::string fix_encoding(std::string_view in, std::size_t chunk, std::size_t* converted = nullptr) {
  EncodingFixer fixer;
  std::string out;
  for (std::size_t i = 0; i < in.size(); i += chunk) {
    const std::size_t n = std::min(chunk, in.size() - i);
    out += fixer.feed(in.data() + i, n);
  }
  out += fixer.finish();
  if (converted) *converted = fixer.converted();
  return out;
}

}  // namespace

CB_TEST(encoding, valid_utf8_comes_out_byte_for_byte) {
  // La garantia que hace que se pueda dejar prendido siempre: un archivo
  // correcto no se toca, ni un byte, ni se cuenta una conversion.
  const std::string in = "fecha;región;año\n2024-01-01;Córdoba;2024\nnaïve;日本語;ñ\n";
  std::size_t converted = 999;
  CB_CHECK_EQ(fix_encoding(in, in.size(), &converted), in);
  CB_CHECK_EQ(converted, static_cast<std::size_t>(0));
}

CB_TEST(encoding, windows_1252_becomes_utf8) {
  // "Córdoba" tal como lo guarda Excel en castellano: 0xF3 suelto.
  std::size_t converted = 0;
  CB_CHECK_EQ(fix_encoding("C\xF3rdoba", 32, &converted), std::string("Córdoba"));
  CB_CHECK_EQ(converted, static_cast<std::size_t>(1));
  CB_CHECK_EQ(fix_encoding("a\xF1o", 32), std::string("año"));
}

CB_TEST(encoding, the_windows_only_range_is_not_latin1) {
  // 0x80-0x9F es donde las dos tablas se separan: Latin-1 pone controles y
  // Windows-1252 pone los caracteres que Word mete en el texto. 0x92 es el
  // apostrofo de "don't", el mas comun de todos.
  CB_CHECK_EQ(fix_encoding("don\x92t", 32), std::string("don’t"));
  CB_CHECK_EQ(fix_encoding("\x80 100", 32), std::string("€ 100"));
  CB_CHECK_EQ(fix_encoding("1996\x97" "2024", 32), std::string("1996—2024"));
}

CB_TEST(encoding, chunk_boundaries_are_invisible) {
  // El mismo invariante que sostiene al scanner: una secuencia UTF-8 partida
  // entre dos bloques no puede cambiar el resultado, ni convertirse por error
  // como si fueran dos bytes sueltos de Windows-1252.
  const std::string in = "región;Córdoba;日本;año\nnaïve;$ 1.234,56;ñandú;fin\n";
  for (std::size_t chunk = 1; chunk <= in.size() + 2; ++chunk) {
    std::size_t converted = 0;
    const std::string out = fix_encoding(in, chunk, &converted);
    CB_CHECK_EQ(out, in);
    CB_CHECK_EQ(converted, static_cast<std::size_t>(0));
  }
}

CB_TEST(encoding, mixed_and_truncated_sequences) {
  // Un archivo con las dos cosas: UTF-8 valido y bytes que no lo son. Cada
  // parte se resuelve por su cuenta.
  CB_CHECK_EQ(fix_encoding("Córdoba y C\xF3rdoba", 32), std::string("Córdoba y Córdoba"));
  // Una secuencia que el archivo corta antes de cerrar ya no puede ser UTF-8.
  CB_CHECK_EQ(fix_encoding("fin\xC3", 32), std::string("finÃ"));
  // Sobrelargas y sustitutos son invalidos aunque tengan la forma: 0xC0 0xAF
  // seria "/" escrito en dos bytes, el truco clasico para colar un ../
  CB_CHECK_EQ(fix_encoding("\xC0\xAF", 32), std::string("À¯"));
}

CB_TEST(encoding, utf16_is_flagged_not_guessed) {
  EncodingFixer fixer;
  const std::string in = "\xFF\xFE" "f\0e\0";
  fixer.feed(in.data(), 4);
  CB_CHECK(fixer.utf16_bom());
  EncodingFixer plain;
  plain.feed("fecha", 5);
  CB_CHECK(!plain.utf16_bom());
}

CB_TEST(sniff, preamble_above_the_table) {
  // Lo que exporta cualquier planilla: titulo, fecha de emision, linea en
  // blanco, y recien ahi la tabla. Sin saltearlo el sniffer busca el separador
  // en filas que no lo tienen y el archivo entero se lee como una sola columna.
  const Dialect d = sniff_dialect(
      "Reporte de ventas 2024\n"
      "Generado el 03/09/2026\n"
      "\n"
      "fecha;provincia;monto\n"
      "01/03/2024;Buenos Aires;1.234,50\n"
      "02/03/2024;Cordoba;2.000,00\n"
      "03/03/2024;Santa Fe;1.500,00\n");
  CB_CHECK_EQ(d.delimiter, ';');
  CB_CHECK_EQ(d.preamble_rows, static_cast<std::size_t>(2));
  CB_CHECK(d.has_header);
}

CB_TEST(sniff, preamble_longer_than_the_table) {
  // Cuatro lineas de metadata sobre tres de datos: el ancho mas frecuente del
  // archivo es 1, y si ese fuera el criterio el ';' quedaria descartado por no
  // partir nada.
  const Dialect d = sniff_dialect(
      "INSTITUTO\nSerie mensual\nBase 2004=100\nActualizado 09/2026\n"
      "fecha;ipc\n01/2024;100,5\n02/2024;101,2\n03/2024;102,9\n");
  CB_CHECK_EQ(d.delimiter, ';');
  CB_CHECK_EQ(d.preamble_rows, static_cast<std::size_t>(4));
}

CB_TEST(sniff, a_lone_header_is_not_a_preamble) {
  // La contracara, y la razon por la que el salto exige que abajo haya un
  // encabezado: "tasa" sobre valores con coma decimal tiene exactamente la
  // misma forma que un titulo sobre una tabla de dos columnas.
  const Dialect d = sniff_dialect("tasa\n12,5\n3,25\n7,125\n");
  CB_CHECK_EQ(d.preamble_rows, static_cast<std::size_t>(0));
  CB_CHECK_EQ(d.delimiter, kNoDelimiter);
}

CB_TEST(sniff, no_preamble_on_a_clean_file) {
  const Dialect d = sniff_dialect("fecha,valor\n2024-01-01,10\n2024-01-02,11\n");
  CB_CHECK_EQ(d.preamble_rows, static_cast<std::size_t>(0));
}

CB_TEST(sniff, bom_is_stripped) {
  const Rows r = scan(strip_bom("\xEF\xBB\xBF" "fecha,valor\n2024-01-01,10\n"));
  CB_CHECK_EQ(r[0][0], std::string("fecha"));
}
