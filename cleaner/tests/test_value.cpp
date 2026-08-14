#include "chartbay/value.hpp"

#include "harness.hpp"

using namespace chartbay;

namespace {

double num(std::string_view s, char decimal = '.') {
  return parse_number(s, NumberFormat{decimal}).value;
}

bool ok(std::string_view s, char decimal = '.') {
  return parse_number(s, NumberFormat{decimal}).ok;
}

}  // namespace

CB_TEST(trim, strips_ascii_and_unicode_space) {
  CB_CHECK_EQ(std::string(trim("  hola \t")), std::string("hola"));
  CB_CHECK_EQ(std::string(trim("\xC2\xA0" "42" "\xC2\xA0")), std::string("42"));
  CB_CHECK_EQ(std::string(trim("\xEF\xBB\xBF" "fecha")), std::string("fecha"));
  CB_CHECK_EQ(std::string(trim("\xE2\x80\x8B  x")), std::string("x"));
  CB_CHECK_EQ(std::string(trim("   ")), std::string(""));
}

CB_TEST(missing, recognises_the_usual_sentinels) {
  CB_CHECK(is_missing_token(""));
  CB_CHECK(is_missing_token("   "));
  CB_CHECK(is_missing_token("NA"));
  CB_CHECK(is_missing_token("n/a"));
  CB_CHECK(is_missing_token("#N/A"));
  CB_CHECK(is_missing_token("NULL"));
  CB_CHECK(is_missing_token("-"));
  CB_CHECK(is_missing_token("s/d"));
  CB_CHECK(is_missing_token("NaN"));
  CB_CHECK(!is_missing_token("0"));
  CB_CHECK(!is_missing_token("-1"));
  CB_CHECK(!is_missing_token("nada"));
}

CB_TEST(number, plain_values) {
  CB_CHECK_NEAR(num("42"), 42.0, 1e-12);
  CB_CHECK_NEAR(num("-3.5"), -3.5, 1e-12);
  CB_CHECK_NEAR(num("+0.25"), 0.25, 1e-12);
  CB_CHECK_NEAR(num(".5"), 0.5, 1e-12);
  CB_CHECK_NEAR(num("5."), 5.0, 1e-12);
  CB_CHECK_NEAR(num("1.5e3"), 1500.0, 1e-9);
  CB_CHECK_NEAR(num("2E-2"), 0.02, 1e-12);
  CB_CHECK(!ok(""));
  CB_CHECK(!ok("abc"));
  CB_CHECK(!ok("12 kg"));
  CB_CHECK(!ok("1.2.3"));
}

CB_TEST(number, thousands_grouping_is_validated) {
  CB_CHECK_NEAR(num("1,234,567"), 1234567.0, 1e-9);
  CB_CHECK_NEAR(num("1,234.56"), 1234.56, 1e-9);
  CB_CHECK_NEAR(num("1 234 567"), 1234567.0, 1e-9);
  CB_CHECK_NEAR(num("1'234'567"), 1234567.0, 1e-9);
  // Under a dot-decimal column, "1,5" cannot be 15: a group separator must be
  // followed by exactly three digits. Rejecting beats silently multiplying x10.
  CB_CHECK(!ok("1,5"));
  CB_CHECK(!ok("1,23"));
  CB_CHECK(!ok("12,3456"));
  CB_CHECK(!ok("1,234,56"));
  CB_CHECK(!ok(",234"));
}

CB_TEST(number, comma_decimal_column) {
  CB_CHECK_NEAR(num("1.234,56", ','), 1234.56, 1e-9);
  CB_CHECK_NEAR(num("0,5", ','), 0.5, 1e-12);
  CB_CHECK_NEAR(num("1.234.567", ','), 1234567.0, 1e-9);
  CB_CHECK(!ok("1.5", ','));
  CB_CHECK(!ok("1,234.56", ','));
}

CB_TEST(number, currency_percent_and_accounting) {
  const NumberParse a = parse_number("$1,234.50", NumberFormat{'.'});
  CB_CHECK(a.ok && a.currency);
  CB_CHECK_NEAR(a.value, 1234.5, 1e-9);

  const NumberParse b = parse_number("(1.234,56)", NumberFormat{','});
  CB_CHECK(b.ok && b.accounting);
  CB_CHECK_NEAR(b.value, -1234.56, 1e-9);

  const NumberParse c = parse_number("12,5%", NumberFormat{','});
  CB_CHECK(c.ok && c.percent);
  CB_CHECK_NEAR(c.value, 12.5, 1e-9);

  const NumberParse d = parse_number("US$ 1 234", NumberFormat{'.'});
  CB_CHECK(d.ok && d.currency);
  CB_CHECK_NEAR(d.value, 1234.0, 1e-9);

  CB_CHECK_NEAR(parse_number("1234-", NumberFormat{'.'}).value, -1234.0, 1e-9);
  CB_CHECK_NEAR(parse_number("1.234,5 ARS", NumberFormat{','}).value, 1234.5, 1e-9);

  // Same eight characters, two different numbers. Which one is correct is a
  // property of the column, never of the cell — hence the voting pass.
  CB_CHECK_NEAR(parse_number("($1.234)", NumberFormat{'.'}).value, -1.234, 1e-9);
  CB_CHECK_NEAR(parse_number("($1.234)", NumberFormat{','}).value, -1234.0, 1e-9);
}

CB_TEST(number, format_votes) {
  NumberFormatVotes v;
  v.observe("1.234,56");
  v.observe("987,10");
  CB_CHECK_EQ(v.resolve().decimal, ',');

  NumberFormatVotes w;
  w.observe("1,234.56");
  w.observe("0.75");
  CB_CHECK_EQ(w.resolve().decimal, '.');

  // "1.234" alone decides nothing, so the fallback is used and it is flagged.
  NumberFormatVotes amb;
  amb.observe("1.234");
  amb.observe("5.678");
  CB_CHECK(amb.undecided());
  CB_CHECK_EQ(amb.ambiguous, static_cast<std::size_t>(2));
  CB_CHECK_EQ(amb.resolve(',').decimal, ',');

  // A repeated separator can only be grouping, which pins the other char.
  NumberFormatVotes grp;
  grp.observe("1.234.567");
  CB_CHECK_EQ(grp.resolve().decimal, ',');

  NumberFormatVotes ints;
  ints.observe("42");
  ints.observe("7");
  CB_CHECK(ints.undecided());
  CB_CHECK_EQ(ints.ambiguous, static_cast<std::size_t>(0));
}

CB_TEST(date, iso_and_orders) {
  DateParse d = parse_date("2024-03-09", DateOrder::DMY);
  CB_CHECK(d.ok);
  CB_CHECK_EQ(to_iso(d), std::string("2024-03-09"));

  // A four-digit leader is ISO whatever the column voted for.
  CB_CHECK_EQ(to_iso(parse_date("2024/03/09", DateOrder::MDY)), std::string("2024-03-09"));
  CB_CHECK_EQ(to_iso(parse_date("09/03/2024", DateOrder::DMY)), std::string("2024-03-09"));
  CB_CHECK_EQ(to_iso(parse_date("09/03/2024", DateOrder::MDY)), std::string("2024-09-03"));
  CB_CHECK_EQ(to_iso(parse_date("09.03.2024", DateOrder::DMY)), std::string("2024-03-09"));
  CB_CHECK_EQ(to_iso(parse_date("2024-03-09T10:15:00Z", DateOrder::DMY)),
              std::string("2024-03-09"));
  CB_CHECK(!parse_date("31/02/2024", DateOrder::DMY).ok);  // February has no 31st
  CB_CHECK(parse_date("29/02/2024", DateOrder::DMY).ok);   // 2024 is a leap year
  CB_CHECK(!parse_date("29/02/2023", DateOrder::DMY).ok);
}

CB_TEST(date, coarser_grains) {
  CB_CHECK_EQ(to_iso(parse_date("2024", DateOrder::DMY)), std::string("2024"));
  CB_CHECK_EQ(to_iso(parse_date("2024-03", DateOrder::DMY)), std::string("2024-03"));
  CB_CHECK_EQ(to_iso(parse_date("202403", DateOrder::DMY)), std::string("2024-03"));
  CB_CHECK_EQ(to_iso(parse_date("20240309", DateOrder::DMY)), std::string("2024-03-09"));
  CB_CHECK_EQ(to_iso(parse_date("2024Q2", DateOrder::DMY)), std::string("2024-Q2"));
  CB_CHECK_EQ(to_iso(parse_date("2024-Q2", DateOrder::DMY)), std::string("2024-Q2"));
  CB_CHECK_EQ(to_iso(parse_date("Q2 2024", DateOrder::DMY)), std::string("2024-Q2"));
  CB_CHECK_EQ(to_iso(parse_date("ene-2024", DateOrder::DMY)), std::string("2024-01"));
  CB_CHECK_EQ(to_iso(parse_date("Mar 2024", DateOrder::DMY)), std::string("2024-03"));
  CB_CHECK_EQ(to_iso(parse_date("9 dic 2024", DateOrder::DMY)), std::string("2024-12-09"));
}

CB_TEST(date, serial_is_days_since_epoch) {
  CB_CHECK_EQ(parse_date("1970-01-01", DateOrder::YMD).serial(), static_cast<std::int64_t>(0));
  CB_CHECK_EQ(parse_date("1970-01-02", DateOrder::YMD).serial(), static_cast<std::int64_t>(1));
  CB_CHECK_EQ(parse_date("1969-12-31", DateOrder::YMD).serial(), static_cast<std::int64_t>(-1));
  CB_CHECK_EQ(parse_date("2024-03-09", DateOrder::YMD).serial(),
              static_cast<std::int64_t>(19791));
}

CB_TEST(date, order_votes) {
  DateOrderVotes v;
  v.observe("13/01/2024");  // 13 cannot be a month
  v.observe("01/02/2024");
  CB_CHECK_EQ(v.resolve(), DateOrder::DMY);

  DateOrderVotes w;
  w.observe("01/13/2024");
  CB_CHECK_EQ(w.resolve(), DateOrder::MDY);

  DateOrderVotes iso;
  iso.observe("2024-01-02");
  CB_CHECK_EQ(iso.resolve(), DateOrder::YMD);

  DateOrderVotes tie;
  tie.observe("01/02/2024");
  tie.observe("03/04/2024");
  CB_CHECK(tie.undecided());
  CB_CHECK_EQ(tie.resolve(DateOrder::MDY), DateOrder::MDY);
  CB_CHECK_EQ(tie.parseable, static_cast<std::size_t>(2));
}

CB_TEST(boolean, common_spellings) {
  bool b = false;
  CB_CHECK(parse_bool("true", &b) && b);
  CB_CHECK(parse_bool("Si", &b) && b);
  CB_CHECK(parse_bool("VERDADERO", &b) && b);
  CB_CHECK(parse_bool("no", &b) && !b);
  CB_CHECK(parse_bool("0", &b) && !b);
  CB_CHECK(!parse_bool("maybe", &b));
}
