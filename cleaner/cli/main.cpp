// csvclean — native front end for the cleaner.
//
// Same library the browser gets; this binary exists so the core can be run,
// profiled and diffed against pandas without an Emscripten toolchain in the
// loop. Reads in 1 MiB blocks, so file size is bounded by the output, not the
// input.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "chartbay/report.hpp"
#include "chartbay/table.hpp"

namespace {

constexpr std::size_t kBlock = 1u << 20;

void usage() {
  std::fputs(
      "uso: csvclean <archivo.csv|-> [opciones]\n"
      "\n"
      "  salida\n"
      "    --out FILE            CSV limpio (por defecto stdout, '-' = stdout)\n"
      "    --report FILE         reporte JSON ('-' = stdout)\n"
      "    --quiet               no imprimir el resumen en stderr\n"
      "    --time                desglose de tiempo por etapa\n"
      "\n"
      "  parseo\n"
      "    --delimiter C         forzar separador (usá 'tab' para tabulación)\n"
      "    --no-header           la primera fila son datos, no nombres\n"
      "    --decimal . | ,       separador decimal por defecto ante ambigüedad\n"
      "    --date-order dmy|mdy|ymd\n"
      "    --percent-fraction    12,5% se guarda como 0.125 en vez de 12.5\n"
      "    --sample N            filas usadas para inferir tipos (5000)\n"
      "\n"
      "  limpieza\n"
      "    --missing keep|drop|zero|mean|median|ffill      (keep)\n"
      "    --outliers flag|winsorize|missing|drop          (flag)\n"
      "    --outlier-rule iqr|zscore|mad                   (iqr)\n"
      "    --outlier-k N                                   (3)\n"
      "    --keep-duplicate-rows --keep-empty-cols\n"
      "    --keep-constant-cols  --keep-duplicate-cols\n",
      stderr);
}

bool eq(const char* a, const char* b) { return std::strcmp(a, b) == 0; }

std::FILE* open_out(const std::string& path) {
  if (path == "-") return stdout;
  std::FILE* f = std::fopen(path.c_str(), "wb");
  if (!f) std::fprintf(stderr, "csvclean: no se pudo escribir %s\n", path.c_str());
  return f;
}

bool write_file(const std::string& path, const std::string& data) {
  std::FILE* f = open_out(path);
  if (!f) return false;
  const bool ok = std::fwrite(data.data(), 1, data.size(), f) == data.size();
  if (f != stdout) std::fclose(f);
  return ok;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2 || eq(argv[1], "-h") || eq(argv[1], "--help")) {
    usage();
    return argc < 2 ? 2 : 0;
  }

  const std::string input = argv[1];
  std::string out_path;
  std::string report_path;
  bool quiet = false;
  bool timing = false;
  chartbay::CleanOptions opts;

  for (int i = 2; i < argc; ++i) {
    const char* a = argv[i];
    const auto next = [&](const char* name) -> const char* {
      if (i + 1 >= argc) {
        std::fprintf(stderr, "csvclean: %s necesita un valor\n", name);
        std::exit(2);
      }
      return argv[++i];
    };

    if (eq(a, "--out")) {
      out_path = next(a);
    } else if (eq(a, "--report")) {
      report_path = next(a);
    } else if (eq(a, "--quiet")) {
      quiet = true;
    } else if (eq(a, "--time")) {
      timing = true;
    } else if (eq(a, "--delimiter")) {
      const char* v = next(a);
      opts.sniff = false;
      opts.dialect.delimiter = eq(v, "tab") ? '\t' : v[0];
    } else if (eq(a, "--no-header")) {
      opts.sniff = false;
      opts.dialect.has_header = false;
    } else if (eq(a, "--decimal")) {
      opts.fallback_decimal = next(a)[0];
    } else if (eq(a, "--date-order")) {
      const char* v = next(a);
      opts.fallback_date_order = eq(v, "mdy")   ? chartbay::DateOrder::MDY
                                : eq(v, "ymd") ? chartbay::DateOrder::YMD
                                               : chartbay::DateOrder::DMY;
    } else if (eq(a, "--percent-fraction")) {
      opts.percent_as_fraction = true;
    } else if (eq(a, "--sample")) {
      opts.sample_rows = static_cast<std::size_t>(std::atoll(next(a)));
    } else if (eq(a, "--missing")) {
      const char* v = next(a);
      using M = chartbay::MissingPolicy;
      opts.missing = eq(v, "drop")     ? M::DropRow
                     : eq(v, "zero")   ? M::Zero
                     : eq(v, "mean")   ? M::Mean
                     : eq(v, "median") ? M::Median
                     : eq(v, "ffill")  ? M::Forward
                                       : M::Keep;
    } else if (eq(a, "--outliers")) {
      const char* v = next(a);
      using O = chartbay::OutlierPolicy;
      opts.outlier = eq(v, "winsorize") ? O::Winsorize
                     : eq(v, "missing") ? O::ToMissing
                     : eq(v, "drop")    ? O::DropRow
                                        : O::Flag;
    } else if (eq(a, "--outlier-rule")) {
      const char* v = next(a);
      using R = chartbay::OutlierRule;
      opts.outlier_rule = eq(v, "zscore") ? R::ZScore : eq(v, "mad") ? R::MAD : R::IQR;
    } else if (eq(a, "--outlier-k")) {
      opts.outlier_k = std::atof(next(a));
    } else if (eq(a, "--keep-duplicate-rows")) {
      opts.drop_duplicate_rows = false;
    } else if (eq(a, "--keep-empty-cols")) {
      opts.drop_empty_columns = false;
    } else if (eq(a, "--keep-constant-cols")) {
      opts.drop_constant_columns = false;
    } else if (eq(a, "--keep-duplicate-cols")) {
      opts.drop_duplicate_columns = false;
    } else {
      std::fprintf(stderr, "csvclean: opción desconocida %s\n", a);
      usage();
      return 2;
    }
  }

  std::FILE* in = input == "-" ? stdin : std::fopen(input.c_str(), "rb");
  if (!in) {
    std::fprintf(stderr, "csvclean: no se pudo abrir %s\n", input.c_str());
    return 1;
  }

  // Pre-size the column buffers when the input is a real file.
  if (input != "-") {
    if (std::fseek(in, 0, SEEK_END) == 0) {
      const long size = std::ftell(in);
      if (size > 0) opts.total_bytes = static_cast<std::size_t>(size);
      std::rewind(in);
    }
  }

  using Clock = std::chrono::steady_clock;
  const auto t0 = Clock::now();

  chartbay::Cleaner cleaner(opts);
  std::vector<char> block(kBlock);
  std::size_t bytes = 0;
  while (true) {
    const std::size_t n = std::fread(block.data(), 1, block.size(), in);
    if (n == 0) break;
    bytes += n;
    cleaner.feed(block.data(), n);
  }
  if (in != stdin) std::fclose(in);

  const auto t1 = Clock::now();
  const chartbay::CleanResult result = cleaner.finish();
  const auto t2 = Clock::now();

  if (!quiet) std::fputs(chartbay::to_text(result).c_str(), stderr);
  if (!report_path.empty() && !write_file(report_path, chartbay::to_json(result))) return 1;

  std::FILE* out = open_out(out_path.empty() ? "-" : out_path);
  if (!out) return 1;
  chartbay::write_csv(out, result);
  if (out != stdout) std::fclose(out);
  const auto t3 = Clock::now();

  if (timing) {
    const auto ms = [](Clock::time_point a, Clock::time_point b) {
      return std::chrono::duration<double, std::milli>(b - a).count();
    };
    const double mb = static_cast<double>(bytes) / (1024.0 * 1024.0);
    std::fprintf(stderr,
                 "\n%.1f MB  leer+parsear %.0f ms  limpiar+perfilar %.0f ms  "
                 "escribir CSV %.0f ms  total %.0f ms  (%.0f MB/s hasta columnas)\n",
                 mb, ms(t0, t1), ms(t1, t2), ms(t2, t3), ms(t0, t3),
                 mb / (ms(t0, t2) / 1000.0));
  }
  return 0;
}
