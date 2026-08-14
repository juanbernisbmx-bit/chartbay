#include "chartbay/table.hpp"

#include "chartbay/report.hpp"
#include "harness.hpp"

using namespace chartbay;

namespace {

const Column* col_by_name(const CleanResult& r, const std::string& name) {
  for (const Column& c : r.columns) {
    if (c.name == name) return &c;
  }
  return nullptr;
}

bool has_action(const CleanResult& r, ActionKind kind) {
  for (const Action& a : r.actions) {
    if (a.kind == kind) return true;
  }
  return false;
}

std::string types(const CleanResult& r) {
  std::string out;
  for (const Column& c : r.columns) {
    if (!out.empty()) out += ",";
    out += c.name;
    out += ":";
    out += type_name(c.type);
  }
  return out;
}

}  // namespace

CB_TEST(table, typing_basics) {
  const CleanResult r = clean_buffer(
      "fecha,pais,pbi,libre\n"
      "2024-01-01,AR,10.5,uno\n"
      "2024-01-02,BR,11.25,dos\n"
      "2024-01-03,AR,12,tres\n"
      "2024-01-04,BR,13,cuatro\n"
      "2024-01-05,AR,14,cinco\n"
      "2024-01-06,BR,15,seis\n");
  CB_CHECK_EQ(types(r), std::string("fecha:date,pais:categorical,pbi:numeric,libre:text"));
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(6));
}

CB_TEST(table, a_bare_year_is_a_number_not_a_date) {
  // "2020" parses as a date, but a column of them is almost always a number.
  const CleanResult r = clean_buffer("anio,mes\n2020,2020-01\n2021,2020-02\n2022,2020-03\n");
  CB_CHECK_EQ(types(r), std::string("anio:numeric,mes:date"));
}

CB_TEST(table, comma_decimals_and_currency) {
  const CleanResult r = clean_buffer(
      "monto;tasa\n"
      "$ 1.234,50;12,5%\n"
      "$ 2.000,00;3,25%\n"
      "($ 500,25);-1,5%\n");
  const Column* monto = col_by_name(r, "monto");
  CB_CHECK(monto != nullptr && monto->type == ColumnType::Numeric);
  CB_CHECK_EQ(monto->number_format.decimal, ',');
  CB_CHECK_NEAR(monto->values[0], 1234.50, 1e-9);
  CB_CHECK_NEAR(monto->values[2], -500.25, 1e-9);
  CB_CHECK(monto->stats.saw_currency);

  const Column* tasa = col_by_name(r, "tasa");
  CB_CHECK(tasa != nullptr && tasa->stats.saw_percent);
  CB_CHECK_NEAR(tasa->values[0], 12.5, 1e-9);
}

CB_TEST(table, percent_as_fraction_option) {
  CleanOptions opts;
  opts.percent_as_fraction = true;
  const CleanResult r = clean_buffer("tasa\n12,5%\n3,25%\n-1,5%\n", opts);
  CB_CHECK_EQ(r.columns.size(), static_cast<std::size_t>(1));
  CB_CHECK_NEAR(r.columns[0].values[0], 0.125, 1e-12);
}

CB_TEST(table, single_column_of_comma_decimals_is_not_split) {
  // The killer case for delimiter sniffing: every data row looks like a clean
  // two-field comma CSV, and only the header gives the game away.
  const CleanResult r = clean_buffer("tasa\n12,5\n3,25\n-1,5\n8,75\n");
  CB_CHECK_EQ(r.columns.size(), static_cast<std::size_t>(1));
  CB_CHECK_EQ(r.columns[0].name, std::string("tasa"));
  CB_CHECK_EQ(r.columns[0].type, ColumnType::Numeric);
  CB_CHECK_NEAR(r.columns[0].values[0], 12.5, 1e-12);
  CB_CHECK_NEAR(r.columns[0].values[2], -1.5, 1e-12);
}

CB_TEST(table, ambiguous_decimal_follows_the_rest_of_the_file) {
  // "45.000" alone is unreadable. The other columns settle the convention.
  const CleanResult r = clean_buffer(
      "claro;ambiguo\n"
      "1.234,56;45.000\n"
      "2.500,10;1.500\n"
      "3.000,25;2.000\n");
  const Column* amb = col_by_name(r, "ambiguo");
  CB_CHECK(amb != nullptr);
  CB_CHECK_NEAR(amb->values[0], 45000.0, 1e-9);
  CB_CHECK(amb->stats.ambiguous_decimal);
  CB_CHECK(has_action(r, ActionKind::AmbiguousDecimal));
}

CB_TEST(table, invalid_cells_become_missing_and_are_reported) {
  const CleanResult r = clean_buffer("x\n1\n2\n3\n4\n5\n6\n7\n8\nabc\n");
  const Column* x = col_by_name(r, "x");
  CB_CHECK(x != nullptr && x->type == ColumnType::Numeric);
  CB_CHECK_EQ(x->stats.invalid, static_cast<std::size_t>(1));
  CB_CHECK_EQ(x->stats.present, static_cast<std::size_t>(8));
  CB_CHECK_EQ(x->mask[8], static_cast<std::uint8_t>(0));
  CB_CHECK(has_action(r, ActionKind::CoercedInvalid));
}

CB_TEST(table, drops_empty_constant_and_duplicate_columns) {
  const CleanResult r = clean_buffer(
      "a,copia_de_a,vacia,constante\n"
      "1,1,,7\n"
      "2,2,,7\n"
      "3,3,,7\n");
  CB_CHECK_EQ(types(r), std::string("a:numeric"));
  CB_CHECK(has_action(r, ActionKind::DroppedEmptyColumn));
  CB_CHECK(has_action(r, ActionKind::DroppedConstantColumn));
  CB_CHECK(has_action(r, ActionKind::DroppedDuplicateColumn));
}

CB_TEST(table, keeps_them_when_asked) {
  CleanOptions opts;
  opts.drop_empty_columns = false;
  opts.drop_constant_columns = false;
  opts.drop_duplicate_columns = false;
  const CleanResult r = clean_buffer("a,b,vacia\n1,1,\n2,2,\n", opts);
  CB_CHECK_EQ(r.columns.size(), static_cast<std::size_t>(3));
}

CB_TEST(table, drops_duplicate_and_empty_rows) {
  // The ",," row is not a blank line — it is a row of empty cells, so the
  // scanner reports it and the cleaner is the one that drops it.
  const CleanResult r = clean_buffer("a,b\n1,2\n1,2\n3,4\n,\n1,2\n");
  CB_CHECK_EQ(r.rows_in, static_cast<std::size_t>(5));
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(2));
  CB_CHECK(has_action(r, ActionKind::DroppedDuplicateRows));
  CB_CHECK(has_action(r, ActionKind::DroppedEmptyRows));
}

CB_TEST(table, duplicate_column_names_are_disambiguated) {
  const CleanResult r = clean_buffer("x,x,\n1,9,5\n2,8,6\n3,7,4\n");
  CB_CHECK_EQ(r.columns.size(), static_cast<std::size_t>(3));
  CB_CHECK_EQ(r.columns[0].name, std::string("x"));
  CB_CHECK_EQ(r.columns[1].name, std::string("x_2"));
  CB_CHECK_EQ(r.columns[2].name, std::string("col_3"));
}

CB_TEST(table, ragged_rows_are_padded_not_dropped) {
  const CleanResult r = clean_buffer("a,b,c\n1,2,3\n4,5\n6,7,8\n");
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(3));
  CB_CHECK(has_action(r, ActionKind::PaddedRaggedRow));
  const Column* c = col_by_name(r, "c");
  CB_CHECK(c != nullptr);
  CB_CHECK_EQ(c->mask[1], static_cast<std::uint8_t>(0));
}

CB_TEST(table, headerless_files_get_generated_names) {
  const CleanResult r = clean_buffer("1,2.5\n3,4.5\n5,6.5\n7,8.5\n");
  CB_CHECK(!r.dialect.has_header);
  CB_CHECK_EQ(r.columns[0].name, std::string("col_1"));
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(4));
}

CB_TEST(table, missing_policy_drop_row) {
  CleanOptions opts;
  opts.missing = MissingPolicy::DropRow;
  const CleanResult r = clean_buffer("a,b\n1,1\n2,\n3,3\n4,4\n", opts);
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(3));
  CB_CHECK(has_action(r, ActionKind::DroppedMissingRows));
}

CB_TEST(table, missing_policy_median) {
  CleanOptions opts;
  opts.missing = MissingPolicy::Median;
  const CleanResult r = clean_buffer("id,a\n1,1\n2,2\n3,\n4,3\n5,5\n", opts);
  const Column* a = col_by_name(r, "a");
  CB_CHECK(a != nullptr);
  CB_CHECK_EQ(a->stats.missing, static_cast<std::size_t>(0));
  CB_CHECK_NEAR(a->values[2], 2.5, 1e-12);  // median of 1,2,3,5
  CB_CHECK(has_action(r, ActionKind::ImputedMissing));
}

CB_TEST(table, missing_policy_forward_fill) {
  CleanOptions opts;
  opts.missing = MissingPolicy::Forward;
  const CleanResult r = clean_buffer("id,a\n1,\n2,2\n3,\n4,\n5,5\n", opts);
  const Column* a = col_by_name(r, "a");
  CB_CHECK(a != nullptr);
  CB_CHECK_EQ(a->mask[0], static_cast<std::uint8_t>(0));  // nothing to carry yet
  CB_CHECK_NEAR(a->values[2], 2.0, 1e-12);
  CB_CHECK_NEAR(a->values[3], 2.0, 1e-12);
}

namespace {

// Distinct rows on purpose: duplicate-row dropping is on by default, and
// "10,10,10" would collapse to a single observation.
constexpr const char* kOutlierCsv =
    "id,x\n1,10\n2,11\n3,12\n4,13\n5,14\n6,15\n7,16\n8,17\n9,18\n10,100000\n";

}  // namespace

CB_TEST(table, outliers_are_flagged_by_default) {
  const CleanResult r = clean_buffer(kOutlierCsv);
  const Column* x = col_by_name(r, "x");
  CB_CHECK(x != nullptr);
  CB_CHECK_EQ(x->stats.outliers, static_cast<std::size_t>(1));
  CB_CHECK_EQ(x->stats.present, static_cast<std::size_t>(10));  // flagged, not removed
  CB_CHECK_NEAR(x->stats.max, 100000.0, 1e-6);
  CB_CHECK(has_action(r, ActionKind::FlaggedOutliers));
}

CB_TEST(table, outliers_winsorized) {
  CleanOptions opts;
  opts.outlier = OutlierPolicy::Winsorize;
  const CleanResult r = clean_buffer(kOutlierCsv, opts);
  const Column* x = col_by_name(r, "x");
  CB_CHECK(x != nullptr);
  CB_CHECK_EQ(x->stats.present, static_cast<std::size_t>(10));
  CB_CHECK(x->stats.max < 100.0);
  CB_CHECK(has_action(r, ActionKind::WinsorizedOutliers));
}

CB_TEST(table, outliers_drop_row) {
  CleanOptions opts;
  opts.outlier = OutlierPolicy::DropRow;
  const CleanResult r = clean_buffer(kOutlierCsv, opts);
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(9));
}

CB_TEST(table, outliers_to_missing) {
  CleanOptions opts;
  opts.outlier = OutlierPolicy::ToMissing;
  const CleanResult r = clean_buffer(kOutlierCsv, opts);
  const Column* x = col_by_name(r, "x");
  CB_CHECK(x != nullptr);
  CB_CHECK_EQ(x->stats.present, static_cast<std::size_t>(9));
  CB_CHECK_EQ(x->stats.missing, static_cast<std::size_t>(1));
}

CB_TEST(table, chunked_feeding_matches_single_shot) {
  const std::string csv =
      "fecha;pais;monto\n"
      "01/03/2024;Argentina;1.234,50\n"
      "02/03/2024;Brasil;\"2.173,00\"\n"
      "03/03/2024;Chile;-\n"
      "04/03/2024;Argentina;98,75\n"
      "05/03/2024;Brasil;115,00\n"
      "06/03/2024;Chile;120,25\n";
  const std::string reference = to_csv(clean_buffer(csv));

  for (std::size_t chunk : {1u, 2u, 3u, 7u, 13u, 64u}) {
    Cleaner cleaner;
    for (std::size_t i = 0; i < csv.size(); i += chunk) {
      cleaner.feed(csv.data() + i, std::min(chunk, csv.size() - i));
    }
    CB_CHECK_EQ(to_csv(cleaner.finish()), reference);
  }
}

CB_TEST(table, csv_round_trip_normalises) {
  const CleanResult r = clean_buffer(
      "fecha;monto;texto\n"
      "01/03/2024;1.234,50;\"con ; punto y coma\"\n"
      "02/03/2024;2.000,00;\"con \"\"comillas\"\"\"\n"
      "03/03/2024;3.500,75;simple\n");
  const std::string csv = to_csv(r);
  // Output is comma-delimited, so the semicolon inside the text needs no quotes.
  CB_CHECK(csv.find("2024-03-01,1234.5,con ; punto y coma") != std::string::npos);
  CB_CHECK(csv.find("\"con \"\"comillas\"\"\"") != std::string::npos);
  CB_CHECK(to_csv(r, ';').find("\"con ; punto y coma\"") != std::string::npos);
}

CB_TEST(table, report_json_is_well_formed_enough) {
  const CleanResult r = clean_buffer("a,b\n1,x\n2,y\n3,x\n4,y\n");
  const std::string json = to_json(r);
  CB_CHECK(json.rfind("{\"rowsIn\":4", 0) == 0);
  CB_CHECK(json.find("\"columns\":[") != std::string::npos);
  CB_CHECK(json.find("\"actions\":[") != std::string::npos);
  CB_CHECK(json.find("\"type\":\"numeric\"") != std::string::npos);
  // Braces must balance, which is the cheapest useful check without a parser.
  int depth = 0;
  bool in_string = false, escaped = false;
  for (char c : json) {
    if (in_string) {
      if (escaped) escaped = false;
      else if (c == '\\') escaped = true;
      else if (c == '"') in_string = false;
      continue;
    }
    if (c == '"') in_string = true;
    else if (c == '{' || c == '[') ++depth;
    else if (c == '}' || c == ']') --depth;
  }
  CB_CHECK_EQ(depth, 0);
  CB_CHECK(!in_string);
}

CB_TEST(table, empty_input_is_not_a_crash) {
  const CleanResult r = clean_buffer("");
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(0));
  CB_CHECK_EQ(r.columns.size(), static_cast<std::size_t>(0));
  CB_CHECK_EQ(to_csv(r), std::string(""));
}

CB_TEST(table, header_only_file) {
  const CleanResult r = clean_buffer("a,b,c\n");
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(0));
}
