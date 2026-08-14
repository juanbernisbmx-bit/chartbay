// A ~100-line test harness. The point of this project is to have zero
// dependencies, and that includes the test build.
#pragma once

#include <cmath>
#include <cstdio>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

namespace test {

struct Case {
  const char* group;
  const char* name;
  void (*fn)();
};

inline std::vector<Case>& registry() {
  static std::vector<Case> cases;
  return cases;
}

inline int& checks() {
  static int n = 0;
  return n;
}

inline int& failures() {
  static int n = 0;
  return n;
}

inline std::string show(bool v) { return v ? "true" : "false"; }
inline std::string show(const std::string& v) { return "\"" + v + "\""; }
inline std::string show(std::string_view v) { return "\"" + std::string(v) + "\""; }
inline std::string show(const char* v) { return std::string("\"") + v + "\""; }
inline std::string show(char v) { return std::string("'") + v + "'"; }

template <typename T>
inline std::string show(T v) {
  char buf[64];
  if constexpr (std::is_floating_point_v<T>) {
    std::snprintf(buf, sizeof buf, "%.10g", static_cast<double>(v));
  } else {
    std::snprintf(buf, sizeof buf, "%lld", static_cast<long long>(v));
  }
  return buf;
}

inline void report(const char* file, int line, const std::string& what) {
  ++failures();
  std::printf("  \033[31mFAIL\033[0m %s:%d\n         %s\n", file, line, what.c_str());
}

struct Registrar {
  Registrar(const char* group, const char* name, void (*fn)()) {
    registry().push_back({group, name, fn});
  }
};

inline int run_all(const char* filter) {
  const char* current = nullptr;
  for (const Case& c : registry()) {
    if (filter && *filter && std::string(c.group).find(filter) == std::string::npos &&
        std::string(c.name).find(filter) == std::string::npos) {
      continue;
    }
    if (!current || std::string(current) != c.group) {
      current = c.group;
      std::printf("\n\033[1m%s\033[0m\n", c.group);
    }
    const int before = failures();
    c.fn();
    std::printf("  %s %s\n", failures() == before ? "\033[32mok\033[0m  " : "    ", c.name);
  }
  std::printf("\n%d checks, \033[%sm%d failures\033[0m\n", checks(),
              failures() == 0 ? "32" : "31", failures());
  return failures() == 0 ? 0 : 1;
}

}  // namespace test

#define CB_TEST(group, name)                                                        \
  static void cb_test_##group##_##name();                                           \
  static ::test::Registrar cb_reg_##group##_##name(#group, #name,                    \
                                                   &cb_test_##group##_##name);       \
  static void cb_test_##group##_##name()

#define CB_CHECK(cond)                                            \
  do {                                                            \
    ++::test::checks();                                           \
    if (!(cond)) ::test::report(__FILE__, __LINE__, #cond);       \
  } while (0)

#define CB_CHECK_EQ(actual, expected)                                                  \
  do {                                                                                 \
    ++::test::checks();                                                                \
    const auto cb_a = (actual);                                                        \
    const auto cb_e = (expected);                                                      \
    if (!(cb_a == cb_e)) {                                                             \
      ::test::report(__FILE__, __LINE__,                                               \
                     std::string(#actual) + "  →  got " + ::test::show(cb_a) +         \
                         ", want " + ::test::show(cb_e));                              \
    }                                                                                  \
  } while (0)

#define CB_CHECK_NEAR(actual, expected, eps)                                           \
  do {                                                                                 \
    ++::test::checks();                                                                \
    const double cb_a = static_cast<double>(actual);                                    \
    const double cb_e = static_cast<double>(expected);                                  \
    if (!(std::fabs(cb_a - cb_e) <= (eps))) {                                          \
      ::test::report(__FILE__, __LINE__,                                               \
                     std::string(#actual) + "  →  got " + ::test::show(cb_a) +         \
                         ", want " + ::test::show(cb_e));                              \
    }                                                                                  \
  } while (0)
