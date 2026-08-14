#include "chartbay/value.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace chartbay {
namespace {

constexpr std::size_t kNpos = std::string_view::npos;

bool starts_with(std::string_view s, std::string_view p) {
  return s.size() >= p.size() && s.compare(0, p.size(), p) == 0;
}

bool ends_with(std::string_view s, std::string_view p) {
  return s.size() >= p.size() && s.compare(s.size() - p.size(), p.size(), p) == 0;
}

char lower(char c) { return (c >= 'A' && c <= 'Z') ? static_cast<char>(c + 32) : c; }

bool iequals(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) return false;
  for (std::size_t i = 0; i < a.size(); ++i) {
    if (lower(a[i]) != lower(b[i])) return false;
  }
  return true;
}

bool is_digit(char c) { return c >= '0' && c <= '9'; }

bool all_digits(std::string_view s) {
  for (char c : s) {
    if (!is_digit(c)) return false;
  }
  return true;
}

// UTF-8 space-alikes that survive a copy-paste out of Excel, Sheets or a PDF.
// They look like padding but break every naive numeric parser.
constexpr std::string_view kUnicodeSpaces[] = {
    "\xC2\xA0",      // U+00A0 no-break space
    "\xE2\x80\xAF",  // U+202F narrow no-break space
    "\xE2\x80\x89",  // U+2009 thin space
    "\xE2\x80\x8B",  // U+200B zero-width space
    "\xEF\xBB\xBF",  // U+FEFF byte order mark
};

bool is_ascii_space(char c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\v' || c == '\f';
}

// Lead and trail bytes of the UTF-8 space sequences above. These guards turn
// trim() from ten string comparisons per call into two byte tests, which
// matters because trim runs on every cell several times over.
bool maybe_unicode_space_lead(char c) {
  const auto u = static_cast<unsigned char>(c);
  return u == 0xC2 || u == 0xE2 || u == 0xEF;
}

bool maybe_unicode_space_tail(char c) {
  const auto u = static_cast<unsigned char>(c);
  return u == 0xA0 || u == 0xAF || u == 0x89 || u == 0x8B || u == 0xBF;
}

// Longest match first, so "US$" wins over "$".
constexpr std::string_view kCurrencySymbols[] = {
    "US$", "R$", "$",
    "\xE2\x82\xAC",  // €
    "\xC2\xA3",      // £
    "\xC2\xA5",      // ¥
    "\xE2\x82\xB9",  // ₹
    "\xE2\x82\xBD",  // ₽
    "\xE2\x82\xA9",  // ₩
};

constexpr std::string_view kCurrencyCodes[] = {
    "ARS", "USD", "EUR", "BRL", "CLP", "COP", "MXN", "PEN",
    "UYU", "GBP", "JPY", "CNY", "CHF", "CAD", "AUD",
};

constexpr std::string_view kMissingTokens[] = {
    "na",  "n/a",  "n/d",  "#n/a", "#na", "null",     "nil",     "none",  "nan",
    "-",   "--",   "---",  ".",    "..",  "?",        "???",     "s/d",   "sd",
    "s/i", "n.d.", "nd",   "sin dato",    "missing",  "vacio",   "vacío",
    "#value!", "#div/0!", "#ref!", "#name?", "#null!", "#num!",
};

// Non-ASCII months are stored in UTF-8; the lowercase compare below is
// byte-wise, which is fine because the accented bytes are already lowercase.
struct MonthName {
  std::string_view text;
  int month;
};

constexpr MonthName kMonthNames[] = {
    {"ene", 1},  {"enero", 1},      {"jan", 1},  {"january", 1},
    {"feb", 2},  {"febrero", 2},    {"february", 2},
    {"mar", 3},  {"marzo", 3},      {"march", 3},
    {"abr", 4},  {"abril", 4},      {"apr", 4},  {"april", 4},
    {"may", 5},  {"mayo", 5},
    {"jun", 6},  {"junio", 6},      {"june", 6},
    {"jul", 7},  {"julio", 7},      {"july", 7},
    {"ago", 8},  {"agosto", 8},     {"aug", 8},  {"august", 8},
    {"sep", 9},  {"sept", 9},       {"septiembre", 9}, {"september", 9},
    {"oct", 10}, {"octubre", 10},   {"october", 10},
    {"nov", 11}, {"noviembre", 11}, {"november", 11},
    {"dic", 12}, {"diciembre", 12}, {"dec", 12}, {"december", 12},
};

bool strip_unicode_space_prefix(std::string_view& s) {
  for (std::string_view sp : kUnicodeSpaces) {
    if (starts_with(s, sp)) {
      s.remove_prefix(sp.size());
      return true;
    }
  }
  return false;
}

bool strip_unicode_space_suffix(std::string_view& s) {
  for (std::string_view sp : kUnicodeSpaces) {
    if (ends_with(s, sp)) {
      s.remove_suffix(sp.size());
      return true;
    }
  }
  return false;
}

// Byte tables of what can begin or end a currency mark, derived from the
// tables above so the two cannot drift apart. Turns "does this cell carry a
// currency?" into two array lookups instead of 24 memcmps.
struct CurrencyGuard {
  bool lead[256] = {};
  bool tail[256] = {};

  CurrencyGuard() {
    const auto mark = [](bool* table, char c) {
      table[static_cast<unsigned char>(c)] = true;
      table[static_cast<unsigned char>(lower(c))] = true;
    };
    for (std::string_view sym : kCurrencySymbols) {
      mark(lead, sym.front());
      mark(tail, sym.back());
    }
    for (std::string_view code : kCurrencyCodes) {
      mark(lead, code.front());
      mark(tail, code.back());
    }
  }
};

const CurrencyGuard kCurrencyGuard;

bool strip_currency(std::string_view& s) {
  if (!kCurrencyGuard.lead[static_cast<unsigned char>(s.front())] &&
      !kCurrencyGuard.tail[static_cast<unsigned char>(s.back())]) {
    return false;
  }
  for (std::string_view sym : kCurrencySymbols) {
    if (s.size() > sym.size() && starts_with(s, sym)) {
      s.remove_prefix(sym.size());
      return true;
    }
    if (s.size() > sym.size() && ends_with(s, sym)) {
      s.remove_suffix(sym.size());
      return true;
    }
  }
  for (std::string_view code : kCurrencyCodes) {
    if (s.size() > code.size() && iequals(s.substr(0, code.size()), code)) {
      s.remove_prefix(code.size());
      return true;
    }
    if (s.size() > code.size() && iequals(s.substr(s.size() - code.size()), code)) {
      s.remove_suffix(code.size());
      return true;
    }
  }
  return false;
}

// Copies the digits of an integer part into `buf` while validating the
// thousands grouping. "1.234.567" passes under group '.', "1.23" does not —
// a separator that is not followed by exactly three digits is not a separator,
// it is a decimal point, and the column format says otherwise.
bool append_integer_part(std::string_view in, char group, char* buf, std::size_t cap,
                         std::size_t* n) {
  std::size_t run = 0;
  bool seen_sep = false;
  for (std::size_t i = 0; i < in.size(); ++i) {
    const char c = in[i];
    if (is_digit(c)) {
      if (*n + 1 >= cap) return false;
      buf[(*n)++] = c;
      ++run;
      continue;
    }
    bool is_sep = (c == group) || c == '\'' || c == ' ';
    if (!is_sep && c == '\xC2' && i + 1 < in.size() && in[i + 1] == '\xA0') {
      is_sep = true;
      ++i;  // consume the second NBSP byte
    }
    if (!is_sep) return false;
    if (!seen_sep) {
      if (run < 1 || run > 3) return false;
      seen_sep = true;
    } else if (run != 3) {
      return false;
    }
    run = 0;
  }
  return !seen_sep || run == 3;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

bool is_leap(std::int32_t y) { return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0; }

int days_in_month(std::int32_t y, int m) {
  static constexpr int kDays[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  if (m < 1 || m > 12) return 0;
  if (m == 2 && is_leap(y)) return 29;
  return kDays[m - 1];
}

bool valid_ymd(std::int32_t y, int m, int d) {
  return y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= days_in_month(y, m);
}

bool is_date_separator(char c) { return c == '-' || c == '/' || c == '.' || c == ' '; }

// Splits a date-like token into at most four separator-delimited pieces.
std::size_t split_date(std::string_view s, std::string_view* parts, std::size_t max_parts) {
  std::size_t n = 0;
  std::size_t start = 0;
  for (std::size_t i = 0; i <= s.size(); ++i) {
    if (i < s.size() && !is_date_separator(s[i])) continue;
    if (i > start) {
      if (n >= max_parts) return max_parts + 1;  // too many pieces
      parts[n++] = s.substr(start, i - start);
    }
    start = i + 1;
  }
  return n;
}

bool to_int(std::string_view s, std::int32_t* out) {
  if (s.empty() || s.size() > 9 || !all_digits(s)) return false;
  std::int32_t v = 0;
  for (char c : s) v = v * 10 + (c - '0');
  *out = v;
  return true;
}

int month_from_name(std::string_view s) {
  // Called for every component of every date-like cell, so the numeric case —
  // which is nearly all of them — must cost one comparison, not a heap
  // allocation and a table walk.
  if (s.size() < 3 || s.size() > 10 || is_digit(s.front())) return 0;
  char lowered[10];
  for (std::size_t i = 0; i < s.size(); ++i) lowered[i] = lower(s[i]);
  const std::string_view key(lowered, s.size());
  for (const MonthName& m : kMonthNames) {
    if (key == m.text) return m.month;
  }
  return 0;
}

// Howard Hinnant's days_from_civil, proleptic Gregorian, epoch 1970-01-01.
std::int64_t days_from_civil(std::int64_t y, unsigned m, unsigned d) {
  y -= m <= 2;
  const std::int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<std::int64_t>(doe) - 719468;
}

DateParse make_date(std::int32_t y, int m, int d, DateGrain grain) {
  DateParse out;
  if (!valid_ymd(y, m, d)) return out;
  out.ok = true;
  out.year = y;
  out.month = m;
  out.day = d;
  out.grain = grain;
  return out;
}

// Recognises 2024Q1, 2024-Q1, 2024 Q1, Q1-2024 and 1Q2024.
DateParse parse_quarter(std::string_view s) {
  DateParse out;
  std::size_t q = kNpos;
  for (std::size_t i = 0; i < s.size(); ++i) {
    if (s[i] == 'Q' || s[i] == 'q') {
      if (q != kNpos) return out;  // more than one Q
      q = i;
    }
  }
  if (q == kNpos) return out;

  std::string_view before = trim(s.substr(0, q));
  std::string_view after = trim(s.substr(q + 1));
  while (!before.empty() && is_date_separator(before.back())) before.remove_suffix(1);
  while (!after.empty() && is_date_separator(after.front())) after.remove_prefix(1);

  std::int32_t a = 0, b = 0;
  if (before.empty()) {
    // "Q1 2024"
    std::string_view parts[2];
    const std::size_t n = split_date(after, parts, 2);
    if (n != 2 || !to_int(parts[0], &a) || !to_int(parts[1], &b)) return out;
    return (a >= 1 && a <= 4 && b >= 1000) ? make_date(b, (a - 1) * 3 + 1, 1, DateGrain::Quarter)
                                           : out;
  }
  if (!to_int(before, &a) || !to_int(after, &b)) return out;
  if (a >= 1000 && b >= 1 && b <= 4) return make_date(a, (b - 1) * 3 + 1, 1, DateGrain::Quarter);
  if (b >= 1000 && a >= 1 && a <= 4) return make_date(b, (a - 1) * 3 + 1, 1, DateGrain::Quarter);
  return out;
}

}  // namespace

// ── Trimming and missing values ───────────────────────────────────────────────

std::string_view trim(std::string_view s) {
  bool changed = true;
  while (changed && !s.empty()) {
    changed = false;
    while (!s.empty() && is_ascii_space(s.front())) {
      s.remove_prefix(1);
      changed = true;
    }
    while (!s.empty() && is_ascii_space(s.back())) {
      s.remove_suffix(1);
      changed = true;
    }
    if (!s.empty() && maybe_unicode_space_lead(s.front()) && strip_unicode_space_prefix(s)) {
      changed = true;
    }
    if (!s.empty() && maybe_unicode_space_tail(s.back()) && strip_unicode_space_suffix(s)) {
      changed = true;
    }
  }
  return s;
}

bool is_missing_token(std::string_view s) {
  s = trim(s);
  if (s.empty()) return true;
  if (s.size() > 12) return false;
  // Every sentinel starts with one of these. Without the guard this runs 30
  // case-insensitive comparisons on every cell of the file.
  switch (lower(s.front())) {
    case 'n': case 's': case 'm': case 'v':
    case '#': case '-': case '.': case '?':
      break;
    default:
      return false;
  }
  for (std::string_view tok : kMissingTokens) {
    if (iequals(s, tok)) return true;
  }
  return false;
}

// ── Numbers ───────────────────────────────────────────────────────────────────

NumberParse parse_number(std::string_view raw, NumberFormat fmt) {
  NumberParse out;
  std::string_view s = trim(raw);
  if (s.empty()) return out;

  // Peel decorations off the outside until only the numeral is left. Looping
  // handles any nesting order: "($1.234)", "$(1.234)", "-$1.234", "1.234-".
  bool neg = false;
  for (bool changed = true; changed;) {
    changed = false;
    s = trim(s);
    if (s.empty()) return out;
    if (s.size() >= 2 && s.front() == '(' && s.back() == ')') {
      s.remove_prefix(1);
      s.remove_suffix(1);
      out.accounting = true;
      neg = !neg;
      changed = true;
      continue;
    }
    // A numeral with digits at both ends carries no currency mark, so skip the
    // 24 prefix/suffix comparisons that scanning the tables would cost.
    if ((!is_digit(s.front()) || !is_digit(s.back())) && strip_currency(s)) {
      out.currency = true;
      changed = true;
      continue;
    }
    if (s.back() == '%') {
      s.remove_suffix(1);
      out.percent = true;
      changed = true;
      continue;
    }
    if (s.front() == '+') {
      s.remove_prefix(1);
      changed = true;
      continue;
    }
    if (s.front() == '-') {
      s.remove_prefix(1);
      neg = !neg;
      changed = true;
      continue;
    }
    if (s.back() == '-') {
      s.remove_suffix(1);
      neg = !neg;
      out.accounting = true;
      changed = true;
      continue;
    }
  }

  // Split off a scientific-notation exponent, but only a well-formed one.
  std::string_view mantissa = s;
  std::string_view exponent;
  for (std::size_t i = 0; i < s.size(); ++i) {
    if (s[i] != 'e' && s[i] != 'E') continue;
    if (i == 0) return out;
    std::string_view tail = s.substr(i + 1);
    std::string_view digits = tail;
    if (!digits.empty() && (digits.front() == '+' || digits.front() == '-')) {
      digits.remove_prefix(1);
    }
    if (digits.empty() || digits.size() > 4 || !all_digits(digits)) return out;
    mantissa = s.substr(0, i);
    exponent = tail;
    break;
  }

  const char dec = fmt.decimal;
  const std::size_t dot = mantissa.find(dec);
  if (dot != kNpos && mantissa.find(dec, dot + 1) != kNpos) return out;  // two decimal points

  const std::string_view int_part = dot == kNpos ? mantissa : mantissa.substr(0, dot);
  const std::string_view frac_part = dot == kNpos ? std::string_view{} : mantissa.substr(dot + 1);

  char buf[64];
  std::size_t n = 0;
  if (!append_integer_part(int_part, fmt.group(), buf, sizeof buf, &n)) return out;
  const std::size_t int_digits = n;

  if (dot != kNpos) {
    if (!all_digits(frac_part)) return out;
    if (int_digits == 0 && frac_part.empty()) return out;
    if (n + 1 + frac_part.size() >= sizeof buf) return out;
    buf[n++] = '.';
    for (char c : frac_part) buf[n++] = c;
  } else if (int_digits == 0) {
    return out;
  }

  if (!exponent.empty()) {
    if (n + 1 + exponent.size() >= sizeof buf) return out;
    buf[n++] = 'e';
    for (char c : exponent) buf[n++] = c;
  }
  buf[n] = '\0';

  // strtod reads the decimal point from LC_NUMERIC. The buffer is already
  // normalised to '.', and nothing in this library calls setlocale, so the
  // default "C" locale applies.
  char* end = nullptr;
  const double v = std::strtod(buf, &end);
  if (end != buf + n || !std::isfinite(v)) return out;

  out.ok = true;
  out.value = neg ? -v : v;
  return out;
}

void NumberFormatVotes::observe(std::string_view raw) {
  std::string_view s = trim(raw);
  const std::size_t first = s.find_first_of("0123456789");
  if (first == kNpos) return;
  s = s.substr(first);

  const std::size_t e = s.find_first_of("eE");
  if (e != kNpos) s = s.substr(0, e);

  const std::size_t last = s.find_last_of("0123456789");
  if (last == kNpos) return;
  s = s.substr(0, last + 1);

  std::size_t commas = 0, dots = 0, last_comma = kNpos, last_dot = kNpos;
  for (std::size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    if (is_digit(c)) continue;
    if (c == ',') {
      ++commas;
      last_comma = i;
    } else if (c == '.') {
      ++dots;
      last_dot = i;
    } else if (c != ' ' && c != '\'') {
      return;  // not a plain numeral, so it carries no evidence
    }
  }

  if (commas > 0 && dots > 0) {
    // Both present: the rightmost one is the decimal separator.
    ++(last_comma > last_dot ? decimal_comma : decimal_dot);
    return;
  }
  if (commas == 0 && dots == 0) return;  // a bare integer decides nothing

  const bool comma_only = commas > 0;
  const std::size_t count = comma_only ? commas : dots;
  const std::size_t pos = comma_only ? last_comma : last_dot;

  if (count >= 2) {
    // Repeated, so it groups thousands — which makes the other char the decimal.
    ++(comma_only ? decimal_dot : decimal_comma);
    return;
  }
  if (s.size() - pos - 1 == 3) {
    ++ambiguous;  // "1,234": 1234 or 1.234, no way to tell from this cell
    return;
  }
  ++(comma_only ? decimal_comma : decimal_dot);
}

NumberFormat NumberFormatVotes::resolve(char fallback) const {
  if (decimal_comma > decimal_dot) return NumberFormat{','};
  if (decimal_dot > decimal_comma) return NumberFormat{'.'};
  return NumberFormat{fallback};
}

// ── Dates ─────────────────────────────────────────────────────────────────────

std::int64_t DateParse::serial() const {
  return days_from_civil(year, static_cast<unsigned>(month), static_cast<unsigned>(day));
}

DateParse parse_date(std::string_view raw, DateOrder order) {
  DateParse out;
  std::string_view s = trim(raw);
  if (s.empty() || s.size() > 40) return out;

  // Drop a trailing clock time: "2024-03-01T10:30:00Z", "01/03/2024 10:30".
  const std::size_t colon = s.find(':');
  if (colon != kNpos) {
    const std::size_t cut = s.find_last_of(" T", colon);
    if (cut == kNpos) return out;
    s = trim(s.substr(0, cut));
    if (s.empty()) return out;
  }

  if (DateParse q = parse_quarter(s); q.ok) return q;

  std::string_view parts[4];
  const std::size_t n = split_date(s, parts, 4);
  if (n == 0 || n > 3) return out;

  // A named month pins its own position, so the column order does not matter.
  for (std::size_t i = 0; i < n; ++i) {
    const int m = month_from_name(parts[i]);
    if (m == 0) continue;
    std::int32_t nums[2] = {0, 0};
    std::size_t k = 0;
    for (std::size_t j = 0; j < n; ++j) {
      if (j == i) continue;
      if (k >= 2 || !to_int(parts[j], &nums[k++])) return out;
    }
    if (k == 1) {
      const std::int32_t y = nums[0] < 100 ? 2000 + nums[0] : nums[0];
      return make_date(y, m, 1, DateGrain::Month);
    }
    if (k == 2) {
      // The four-digit component is the year; the other one is the day.
      const bool first_is_year = nums[0] >= 1000;
      const std::int32_t y = first_is_year ? nums[0] : nums[1];
      const std::int32_t d = first_is_year ? nums[1] : nums[0];
      return make_date(y, m, d, DateGrain::Day);
    }
    return out;
  }

  std::int32_t v[3] = {0, 0, 0};
  for (std::size_t i = 0; i < n; ++i) {
    if (!to_int(parts[i], &v[i])) return out;
  }

  if (n == 1) {
    const std::string_view only = parts[0];
    if (only.size() == 4) return make_date(v[0], 1, 1, DateGrain::Year);
    if (only.size() == 6) return make_date(v[0] / 100, v[0] % 100, 1, DateGrain::Month);
    if (only.size() == 8) {
      return make_date(v[0] / 10000, (v[0] / 100) % 100, v[0] % 100, DateGrain::Day);
    }
    return out;
  }

  if (n == 2) {
    if (parts[0].size() == 4) return make_date(v[0], v[1], 1, DateGrain::Month);
    if (parts[1].size() == 4) return make_date(v[1], v[0], 1, DateGrain::Month);
    return out;
  }

  // Three components. A four-digit leader is unambiguously ISO whatever the
  // column voted for; otherwise the column's resolved order decides.
  if (parts[0].size() == 4) return make_date(v[0], v[1], v[2], DateGrain::Day);
  if (parts[2].size() == 4 || order == DateOrder::DMY || order == DateOrder::MDY) {
    std::int32_t y = v[2];
    if (parts[2].size() <= 2) y = y < 70 ? 2000 + y : 1900 + y;
    const bool mdy = order == DateOrder::MDY;
    return make_date(y, mdy ? v[0] : v[1], mdy ? v[1] : v[0], DateGrain::Day);
  }
  if (order == DateOrder::YMD) return make_date(v[0], v[1], v[2], DateGrain::Day);
  return out;
}

DateParse date_from_serial(std::int64_t days, DateGrain grain) {
  // Howard Hinnant's civil_from_days, the exact inverse of days_from_civil.
  days += 719468;
  const std::int64_t era = (days >= 0 ? days : days - 146096) / 146097;
  const auto doe = static_cast<std::uint64_t>(days - era * 146097);
  const std::uint64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const std::int64_t y = static_cast<std::int64_t>(yoe) + era * 400;
  const std::uint64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const std::uint64_t mp = (5 * doy + 2) / 153;
  const std::uint64_t d = doy - (153 * mp + 2) / 5 + 1;
  const std::uint64_t m = mp + (mp < 10 ? 3 : -9);

  DateParse out;
  out.ok = true;
  out.year = static_cast<std::int32_t>(y + (m <= 2));
  out.month = static_cast<std::int32_t>(m);
  out.day = static_cast<std::int32_t>(d);
  out.grain = grain;
  return out;
}

std::string to_iso(const DateParse& d) {
  if (!d.ok) return {};
  char buf[16];
  switch (d.grain) {
    case DateGrain::Year:
      std::snprintf(buf, sizeof buf, "%04d", d.year);
      break;
    case DateGrain::Quarter:
      std::snprintf(buf, sizeof buf, "%04d-Q%d", d.year, (d.month - 1) / 3 + 1);
      break;
    case DateGrain::Month:
      std::snprintf(buf, sizeof buf, "%04d-%02d", d.year, d.month);
      break;
    case DateGrain::Day:
    default:
      std::snprintf(buf, sizeof buf, "%04d-%02d-%02d", d.year, d.month, d.day);
      break;
  }
  return std::string(buf);
}

void DateOrderVotes::observe(std::string_view raw) {
  std::string_view s = trim(raw);
  if (s.empty()) return;
  const std::size_t colon = s.find(':');
  if (colon != kNpos) {
    const std::size_t cut = s.find_last_of(" T", colon);
    if (cut == kNpos) return;
    s = trim(s.substr(0, cut));
  }

  std::string_view parts[4];
  const std::size_t n = split_date(s, parts, 4);
  if (n != 3) {
    // Still counts as a date if some other shape parses (ISO month, quarter…).
    if (parse_date(raw, DateOrder::DMY).ok) ++parseable;
    return;
  }

  std::int32_t v[3] = {0, 0, 0};
  for (std::size_t i = 0; i < 3; ++i) {
    if (!to_int(parts[i], &v[i])) {
      if (month_from_name(parts[i]) != 0 && parse_date(raw, DateOrder::DMY).ok) ++parseable;
      return;
    }
  }
  ++parseable;

  if (parts[0].size() == 4) {
    ++iso;
  } else if (v[0] > 12 && v[0] <= 31) {
    ++dmy;
  } else if (v[1] > 12 && v[1] <= 31) {
    ++mdy;
  }
}

DateOrder DateOrderVotes::resolve(DateOrder fallback) const {
  if (dmy > mdy) return DateOrder::DMY;
  if (mdy > dmy) return DateOrder::MDY;
  if (iso > 0) return DateOrder::YMD;
  return fallback;
}

// ── Booleans ──────────────────────────────────────────────────────────────────

bool parse_bool(std::string_view raw, bool* out) {
  static constexpr std::string_view kTrue[] = {"true", "verdadero", "si", "s\xC3\xAD",
                                               "yes",  "t",         "y",  "1"};
  static constexpr std::string_view kFalse[] = {"false", "falso", "no", "n", "f", "0"};
  const std::string_view s = trim(raw);
  for (std::string_view t : kTrue) {
    if (iequals(s, t)) {
      *out = true;
      return true;
    }
  }
  for (std::string_view f : kFalse) {
    if (iequals(s, f)) {
      *out = false;
      return true;
    }
  }
  return false;
}

}  // namespace chartbay
