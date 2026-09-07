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
  // Filas de basura encima del encabezado: el título del reporte, la fecha de
  // emisión, una línea en blanco. No es un detalle cosmético — el sniffer busca
  // el delimitador en las primeras filas, y tres líneas sin punto y coma
  // alcanzan para que un CSV de siete columnas se lea como una sola columna de
  // texto. Se cuenta en filas del scanner, antes del encabezado.
  std::size_t preamble_rows = 0;
};

// Infers the delimiter, how many junk rows sit above the table and whether the
// first row of the table is a header, from the first bytes of the file. Pass at
// least a few KB; whole lines only are considered.
Dialect sniff_dialect(std::string_view sample);

// Strips a UTF-8 byte order mark if present, so the first header does not come
// back as "\xEF\xBB\xBFfecha".
std::string_view strip_bom(std::string_view s);

/**
 * Decodificador tolerante: UTF-8 con Windows-1252 de respaldo.
 *
 * Excel en español guarda CSV en Windows-1252, no en UTF-8. Hasta ahora esos
 * bytes pasaban crudos y "Córdoba" salía "C?rdoba" en el archivo limpio, sin
 * que nada lo dijera. Acá cada secuencia UTF-8 válida se deja intacta byte a
 * byte — un archivo ya en UTF-8 sale idéntico al que entró — y todo byte que no
 * pueda ser UTF-8 se traduce como Windows-1252, que es la tabla que usan las
 * planillas y los navegadores para ese caso.
 *
 * Windows-1252 y no ISO-8859-1: se diferencian solo en 0x80–0x9F, donde
 * Latin-1 pone controles y Windows pone comillas tipográficas, guiones y el
 * símbolo del euro. Un archivo real que dice ser Latin-1 casi siempre es
 * Windows-1252, así que traducir por esa tabla acierta más seguido y nunca
 * produce un carácter de control.
 *
 * Lo que **no** hace es arreglar el mojibake ya cometido: "Ã³" es UTF-8 válido
 * y por lo tanto se respeta. Adivinar ahí rompería los archivos correctos.
 */
class EncodingFixer {
 public:
  // Convierte un bloque. La vista devuelta vale hasta la próxima llamada, y en
  // el caso común — el bloque ya es ASCII o UTF-8 — es el mismo `data` sin
  // copiar. Puede quedarse con los últimos bytes cuando el bloque corta una
  // secuencia multibyte al medio; salen en la llamada siguiente.
  std::string_view feed(const char* data, std::size_t len);
  // Cierra el archivo: lo que haya quedado de una secuencia incompleta ya no
  // puede completarse, así que se traduce como Windows-1252.
  std::string_view finish();

  // Bytes que no eran UTF-8 y se tradujeron. 0 = el archivo ya estaba en UTF-8.
  std::size_t converted() const { return converted_; }
  // El archivo empieza con un BOM de UTF-16 (FF FE o FE FF). Nada de lo que
  // sigue va a tener sentido; esto existe para poder decirlo en vez de escupir
  // una columna llamada "f\0e\0c\0h\0a".
  bool utf16_bom() const { return utf16_bom_; }

 private:
  std::string_view convert(const char* data, std::size_t len);

  std::string out_;      // bloque convertido, reutilizado entre llamadas
  std::string pending_;  // prefijo de una secuencia multibyte cortada al final
  std::size_t converted_ = 0;
  // Los primeros bytes del archivo, juntados entre llamadas: el BOM de UTF-16
  // son dos, y pueden llegar en feed() distintos.
  unsigned char prefix_[2] = {0, 0};
  std::size_t prefix_len_ = 0;
  bool utf16_bom_ = false;
};

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
