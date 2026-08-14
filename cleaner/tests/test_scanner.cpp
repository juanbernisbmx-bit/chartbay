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

CB_TEST(sniff, bom_is_stripped) {
  const Rows r = scan(strip_bom("\xEF\xBB\xBF" "fecha,valor\n2024-01-01,10\n"));
  CB_CHECK_EQ(r[0][0], std::string("fecha"));
}
