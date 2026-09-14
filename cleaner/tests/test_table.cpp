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

// ── Índice temporal ──────────────────────────────────────────────────────────

CB_TEST(table, a_month_grain_column_has_no_day_to_be_ambiguous_about) {
  // "2024-03" no tiene día: no hay nada que pueda leerse DD/MM ni MM/DD. Sin
  // este corte, una serie mensual sana abría el diagnóstico con una advertencia
  // grave sobre un componente que sus fechas no tienen.
  const CleanResult r = clean_buffer("fecha;v\n2024-01;1\n2024-02;2\n2024-03;3\n2024-04;4\n");
  const Column* fecha = col_by_name(r, "fecha");
  CB_CHECK(fecha != nullptr && fecha->type == ColumnType::Date);
  CB_CHECK_EQ(fecha->date_grain, DateGrain::Month);
  CB_CHECK(!fecha->stats.ambiguous_date_order);
  CB_CHECK(!has_action(r, ActionKind::AmbiguousDateOrder));
}

CB_TEST(table, a_day_grain_column_without_a_day_over_twelve_still_is_ambiguous) {
  // Y el caso que la advertencia sí existe para: acá hay día, y ninguno pasa
  // de 12, así que las dos lecturas siguen siendo posibles.
  const CleanResult r = clean_buffer(
      "fecha;v\n01/02/2024;1\n03/04/2024;2\n05/06/2024;3\n07/08/2024;4\n");
  const Column* fecha = col_by_name(r, "fecha");
  CB_CHECK(fecha != nullptr && fecha->type == ColumnType::Date);
  CB_CHECK_EQ(fecha->date_grain, DateGrain::Day);
  CB_CHECK(fecha->stats.ambiguous_date_order);
  CB_CHECK(has_action(r, ActionKind::AmbiguousDateOrder));
}

CB_TEST(table, sorts_a_series_that_arrived_out_of_order) {
  const CleanResult r = clean_buffer(
      "fecha;ipc\n2024-03;102,9\n2024-01;100,5\n2024-04;103,4\n2024-02;101,2\n");
  const Column* fecha = col_by_name(r, "fecha");
  CB_CHECK(fecha != nullptr && fecha->type == ColumnType::Date);
  // Las filas salen en orden, y el resto de las columnas las acompaña.
  const Column* ipc = col_by_name(r, "ipc");
  CB_CHECK_NEAR(ipc->values[0], 100.5, 1e-9);
  CB_CHECK_NEAR(ipc->values[1], 101.2, 1e-9);
  CB_CHECK_NEAR(ipc->values[2], 102.9, 1e-9);
  CB_CHECK_NEAR(ipc->values[3], 103.4, 1e-9);
  CB_CHECK(has_action(r, ActionKind::SortedByTime));
  CB_CHECK(r.time_index.found);
  CB_CHECK(r.time_index.sorted_here);
  CB_CHECK(!r.time_index.ordered);
  CB_CHECK_EQ(r.time_index.frequency, TimeFrequency::Monthly);
}

CB_TEST(table, an_ordered_series_is_not_touched) {
  const CleanResult r = clean_buffer(
      "fecha;ipc\n2024-01;100,5\n2024-02;101,2\n2024-03;102,9\n2024-04;103,4\n");
  CB_CHECK(!has_action(r, ActionKind::SortedByTime));
  CB_CHECK(r.time_index.ordered);
  CB_CHECK(!r.time_index.sorted_here);
  CB_CHECK_EQ(r.time_index.missing_periods, static_cast<std::size_t>(0));
}

CB_TEST(table, a_panel_is_never_reordered) {
  // Tres provincias por mes: ordenar solo por fecha mezclaría las unidades y
  // cualquier rezago pasaría a comparar provincias distintas. Se informa y no
  // se toca.
  const CleanResult r = clean_buffer(
      "fecha;provincia;v\n"
      "2024-03;BA;1\n2024-03;CBA;2\n2024-03;SF;3\n"
      "2024-01;BA;4\n2024-01;CBA;5\n2024-01;SF;6\n"
      "2024-02;BA;7\n2024-02;CBA;8\n2024-02;SF;9\n");
  CB_CHECK(!has_action(r, ActionKind::SortedByTime));
  CB_CHECK(!r.time_index.ordered);
  CB_CHECK_EQ(r.time_index.duplicates, static_cast<std::size_t>(6));
  CB_CHECK_EQ(r.time_index.periods_observed, static_cast<std::size_t>(3));
  // Y las filas quedaron donde estaban.
  CB_CHECK_NEAR(col_by_name(r, "v")->values[0], 1.0, 1e-9);
}

CB_TEST(table, two_date_columns_leave_the_index_undecided) {
  const CleanResult r = clean_buffer(
      "alta;baja;v\n2024-03-01;2024-05-01;1\n2024-01-01;2024-02-01;2\n"
      "2024-02-01;2024-04-01;3\n2024-06-01;2024-07-01;4\n");
  CB_CHECK(!r.time_index.found);
  CB_CHECK(r.time_index.ambiguous);
  CB_CHECK(!has_action(r, ActionKind::SortedByTime));
}

CB_TEST(table, gaps_are_counted_by_calendar_not_by_days) {
  // Un mes no son 30 días ni un trimestre 90: contarlos así inventa huecos en
  // febrero y en cada bisiesto. Esta serie mensual no tiene ninguno.
  const CleanResult r = clean_buffer(
      "fecha;v\n2024-01-31;1\n2024-02-29;2\n2024-03-31;3\n2024-04-30;4\n2024-05-31;5\n");
  CB_CHECK_EQ(r.time_index.frequency, TimeFrequency::Monthly);
  CB_CHECK_EQ(r.time_index.missing_periods, static_cast<std::size_t>(0));
  CB_CHECK_EQ(r.time_index.periods_expected, static_cast<std::size_t>(5));
}

CB_TEST(table, a_missing_period_is_found_and_named) {
  const CleanResult r = clean_buffer(
      "fecha;v\n2024-01;1\n2024-02;2\n2024-03;3\n2024-05;5\n2024-06;6\n");
  CB_CHECK_EQ(r.time_index.frequency, TimeFrequency::Monthly);
  CB_CHECK_EQ(r.time_index.missing_periods, static_cast<std::size_t>(1));
  CB_CHECK_EQ(r.time_index.gap_examples.size(), static_cast<std::size_t>(1));
  CB_CHECK_EQ(r.time_index.gap_examples[0], std::string("2024-04"));
}

CB_TEST(table, business_daily_is_not_a_daily_series_with_holes) {
  // Los mismos saltos de tres días, pero todos en fin de semana: no falta
  // nada. Sin esta distinción una serie financiera reportaría un tercio de sus
  // períodos como faltantes.
  std::string csv = "fecha;cierre\n";
  // Lunes 2024-01-01 en adelante, solo días hábiles.
  const char* habiles[] = {"2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05",
                           "2024-01-08", "2024-01-09", "2024-01-10", "2024-01-11", "2024-01-12",
                           "2024-01-15", "2024-01-16"};
  for (std::size_t i = 0; i < 12; ++i) {
    csv += std::string(habiles[i]) + ";" + std::to_string(100 + i) + "\n";
  }
  const CleanResult r = clean_buffer(csv);
  CB_CHECK_EQ(r.time_index.frequency, TimeFrequency::BusinessDaily);
  CB_CHECK_EQ(r.time_index.missing_periods, static_cast<std::size_t>(0));
}

CB_TEST(table, sorting_can_be_turned_off) {
  CleanOptions opts;
  opts.sort_by_time = false;
  const CleanResult r = clean_buffer(
      "fecha;ipc\n2024-03;102,9\n2024-01;100,5\n2024-04;103,4\n2024-02;101,2\n", opts);
  CB_CHECK(!has_action(r, ActionKind::SortedByTime));
  CB_CHECK(!r.time_index.ordered);
  CB_CHECK_NEAR(col_by_name(r, "ipc")->values[0], 102.9, 1e-9);
}

CB_TEST(table, forward_fill_runs_in_time_order_not_file_order) {
  // La razón por la que ordenar va antes de imputar: el arrastre copia el
  // último valor *anterior*, y sobre filas desordenadas "anterior" es el
  // renglón de arriba, que puede ser de seis meses después.
  CleanOptions opts;
  opts.missing = MissingPolicy::Forward;
  const CleanResult r = clean_buffer(
      "fecha;v\n2024-04;40\n2024-01;10\n2024-03;\n2024-02;20\n", opts);
  const Column* v = col_by_name(r, "v");
  CB_CHECK(v != nullptr);
  // Ordenado: 10, 20, (arrastra 20), 40.
  CB_CHECK_NEAR(v->values[0], 10.0, 1e-9);
  CB_CHECK_NEAR(v->values[1], 20.0, 1e-9);
  CB_CHECK_NEAR(v->values[2], 20.0, 1e-9);
  CB_CHECK_NEAR(v->values[3], 40.0, 1e-9);
}

CB_TEST(table, category_spellings_are_unified_and_the_common_one_wins) {
  const CleanResult r = clean_buffer(
      "provincia;ventas\n"
      "Buenos Aires;100\nBuenos Aires;110\nBuenos Aires;120\n"
      "buenos aires;130\nBUENOS  AIRES;140\n"
      "Córdoba;200\nCórdoba;210\nCordoba;220\n"
      "Santa Fe;300\nSanta Fe;310\n");
  const Column* prov = col_by_name(r, "provincia");
  CB_CHECK(prov != nullptr && prov->type == ColumnType::Categorical);
  CB_CHECK_EQ(prov->levels.size(), static_cast<std::size_t>(3));
  // Gana la escritura más frecuente, no la primera ni una forma aplanada.
  CB_CHECK_EQ(prov->levels[0], std::string("Buenos Aires"));
  CB_CHECK_EQ(prov->levels[1], std::string("Córdoba"));
  CB_CHECK_EQ(prov->levels[2], std::string("Santa Fe"));
  CB_CHECK_EQ(prov->stats.unique, static_cast<std::size_t>(3));
  CB_CHECK(has_action(r, ActionKind::UnifiedLevels));
}

CB_TEST(table, spelling_noise_was_turning_categories_into_free_text) {
  // Lo que de verdad cuesta: son las escrituras repetidas las que inflan el
  // conteo de únicos, y con eso la columna cruza el umbral de cardinalidad y se
  // tipa como texto libre. Una columna de texto no genera dummies: no entra a
  // ningún modelo, y nada en la pantalla dice por qué.
  std::string csv = "provincia;ventas\n";
  const char* provincias[] = {"Buenos Aires", "Córdoba", "Santa Fe",  "Mendoza",  "Tucumán",
                              "Salta",        "Chaco",   "Misiones", "Neuquén", "Formosa"};
  const char* sin_tilde[] = {"Buenos aires", "Cordoba", "SANTA FE",  "mendoza",  "Tucuman",
                             "SALTA",        "chaco",   "MISIONES", "Neuquen", "formosa"};
  int v = 100;
  for (std::size_t i = 0; i < 10; ++i) {
    for (int k = 0; k < 5; ++k) {
      csv += std::string(provincias[i]) + ";" + std::to_string(v++) + "\n";
    }
    csv += std::string(sin_tilde[i]) + ";" + std::to_string(v++) + "\n";
  }

  CleanOptions off;
  off.unify_categories = false;
  const CleanResult raw = clean_buffer(csv, off);
  CB_CHECK(col_by_name(raw, "provincia")->type == ColumnType::Text);
  CB_CHECK_EQ(col_by_name(raw, "provincia")->stats.unique, static_cast<std::size_t>(20));

  const CleanResult r = clean_buffer(csv);
  const Column* prov = col_by_name(r, "provincia");
  CB_CHECK(prov->type == ColumnType::Categorical);
  CB_CHECK_EQ(prov->levels.size(), static_cast<std::size_t>(10));
}

// ── Escrituras parecidas ─────────────────────────────────────────────────────

namespace {

// Una columna con `veces` repeticiones de cada nivel dominante y una sola
// aparición de cada errata.
std::string with_typos(const std::vector<std::string>& dominantes,
                       const std::vector<std::string>& erratas, int veces) {
  std::string csv = "provincia;v\n";
  int n = 0;
  for (const std::string& d : dominantes) {
    for (int i = 0; i < veces; ++i) csv += d + ";" + std::to_string(++n) + "\n";
  }
  for (const std::string& e : erratas) csv += e + ";" + std::to_string(++n) + "\n";
  return csv;
}

}  // namespace

CB_TEST(table, similar_spellings_merge_into_the_common_one) {
  const CleanResult r = clean_buffer(with_typos({"Córdoba", "Mendoza"}, {"Cordova"}, 12));
  const Column* prov = col_by_name(r, "provincia");
  CB_CHECK(prov != nullptr);
  CB_CHECK_EQ(prov->levels.size(), static_cast<std::size_t>(2));
  CB_CHECK(has_action(r, ActionKind::MergedSimilarLevels));
  // Aplicadas dejan de ser una sugerencia pendiente: quedan en la acción.
  CB_CHECK(r.fuzzy_matches.empty());
  // Y la fila de la errata apunta al nivel bueno, no a -1.
  std::size_t cordoba = 0;
  for (std::size_t i = 0; i < prov->size(); ++i) {
    if (prov->codes[i] >= 0 &&
        prov->levels[static_cast<std::size_t>(prov->codes[i])] == "Córdoba") {
      ++cordoba;
    }
  }
  CB_CHECK_EQ(cordoba, static_cast<std::size_t>(13));
}

CB_TEST(table, similar_spellings_can_be_left_alone) {
  // Apagado, se detectan igual y se listan: el usuario decide, pero se entera.
  CleanOptions opts;
  opts.fuzzy_categories = false;
  const CleanResult r = clean_buffer(with_typos({"Córdoba", "Mendoza"}, {"Cordova"}, 12), opts);
  CB_CHECK_EQ(col_by_name(r, "provincia")->levels.size(), static_cast<std::size_t>(3));
  CB_CHECK(!has_action(r, ActionKind::MergedSimilarLevels));
  CB_CHECK_EQ(r.fuzzy_matches.size(), static_cast<std::size_t>(1));
  if (r.fuzzy_matches.size() != 1) return;
  CB_CHECK_EQ(r.fuzzy_matches[0].from, std::string("Cordova"));
  CB_CHECK_EQ(r.fuzzy_matches[0].to, std::string("Córdoba"));
  CB_CHECK_EQ(r.fuzzy_matches[0].from_count, static_cast<std::size_t>(1));
  CB_CHECK_EQ(r.fuzzy_matches[0].to_count, static_cast<std::size_t>(12));
}

CB_TEST(table, a_transposition_is_one_edit_not_two) {
  CleanOptions opts;
  opts.fuzzy_categories = false;
  const CleanResult r = clean_buffer(with_typos({"Buenos Aires"}, {"Buenos Aries"}, 12), opts);
  CB_CHECK_EQ(r.fuzzy_matches.size(), static_cast<std::size_t>(1));
  if (r.fuzzy_matches.size() != 1) return;
  CB_CHECK_EQ(r.fuzzy_matches[0].distance, static_cast<std::size_t>(1));
}

CB_TEST(table, two_common_spellings_are_two_categories) {
  // "Salta" y "Malta" están a una edición y son dos lugares. Lo que las salva
  // no es la distancia sino la frecuencia: ninguna es rara.
  const CleanResult r = clean_buffer(with_typos({"Salta", "Malta"}, {}, 12));
  CB_CHECK_EQ(col_by_name(r, "provincia")->levels.size(), static_cast<std::size_t>(2));
  CB_CHECK(r.fuzzy_matches.empty());
  CB_CHECK(!has_action(r, ActionKind::MergedSimilarLevels));
}

CB_TEST(table, short_codes_are_never_compared) {
  // "AR" y "BR" están a una edición y son dos países, y la proporción entre
  // ellos —20 contra 1— pasa el guarda de frecuencia sin problema. Lo único
  // que los salva es el largo mínimo de la clave.
  const CleanResult r = clean_buffer(with_typos({"AR"}, {"BR"}, 20));
  CB_CHECK_EQ(col_by_name(r, "provincia")->levels.size(), static_cast<std::size_t>(2));
  CB_CHECK(r.fuzzy_matches.empty());
}

CB_TEST(table, similarity_does_not_chain) {
  // Que A se parezca a B y B a C no hace que A y C sean lo mismo. Si la
  // dominante elegida es a su vez candidata de otra, la fusión no se hace.
  CleanOptions opts;
  opts.fuzzy_categories = false;
  const CleanResult r =
      clean_buffer(with_typos({"Mendoza"}, {"Mendozaa", "Mendozaaa"}, 30), opts);
  for (const FuzzyMatch& m : r.fuzzy_matches) {
    CB_CHECK_EQ(m.to, std::string("Mendoza"));
  }
}

CB_TEST(table, a_consistent_column_is_left_exactly_as_it_was) {
  const CleanResult r = clean_buffer(
      "region;valor\nnorte;1\nsur;2\nnorte;3\nsur;4\nnorte;5\nsur;6\n");
  const Column* reg = col_by_name(r, "region");
  CB_CHECK(reg != nullptr && reg->type == ColumnType::Categorical);
  CB_CHECK_EQ(reg->levels.size(), static_cast<std::size_t>(2));
  CB_CHECK_EQ(reg->levels[0], std::string("norte"));
  CB_CHECK(!has_action(r, ActionKind::UnifiedLevels));
}

CB_TEST(table, unification_can_be_turned_off) {
  CleanOptions opts;
  opts.unify_categories = false;
  // Doce filas y no seis: con cuatro valores distintos sobre seis, la columna no
  // repite lo suficiente para ser categórica y el caso no probaría nada.
  const std::string csv =
      "provincia;v\nCórdoba;1\nCórdoba;2\nCórdoba;3\nCórdoba;4\nCordoba;5\nCordoba;6\n"
      "Santa Fe;7\nSanta Fe;8\nSanta Fe;9\nSanta Fe;10\nsanta fe;11\nsanta fe;12\n";
  const CleanResult r = clean_buffer(csv, opts);
  CB_CHECK(col_by_name(r, "provincia")->type == ColumnType::Categorical);
  CB_CHECK_EQ(col_by_name(r, "provincia")->levels.size(), static_cast<std::size_t>(4));
  CB_CHECK(!has_action(r, ActionKind::UnifiedLevels));
  // Y el mismo archivo con la unificación puesta: dos niveles.
  CB_CHECK_EQ(col_by_name(clean_buffer(csv), "provincia")->levels.size(),
              static_cast<std::size_t>(2));
}

CB_TEST(table, a_tie_keeps_the_spelling_that_appeared_first) {
  // Con las dos escrituras empatadas el resultado no puede depender del orden
  // en que itere un unordered_map: si dependiera, el WASM y el binario nativo
  // darían distinto y el archivo cambiaría de una corrida a la otra.
  const CleanResult r = clean_buffer("x;v\nCórdoba;1\nCordoba;2\nSalta;3\nSalta;4\n");
  const Column* x = col_by_name(r, "x");
  CB_CHECK(x != nullptr && x->type == ColumnType::Categorical);
  CB_CHECK_EQ(x->levels[0], std::string("Córdoba"));
}

CB_TEST(table, windows_1252_survives_all_the_way_to_the_output) {
  // El archivo que exporta Excel en castellano: acentos y ñ en los nombres de
  // columna y en los niveles, todo en un byte.
  const CleanResult r = clean_buffer(
      "a\xF1o;regi\xF3n;monto\n"
      "2024;C\xF3rdoba;100,5\n"
      "2023;C\xF3rdoba;90,25\n"
      "2022;Neuqu\xE9n;80,00\n"
      "2021;Neuqu\xE9n;70,00\n");
  CB_CHECK_EQ(types(r), std::string("año:numeric,región:categorical,monto:numeric"));
  const Column* region = col_by_name(r, "región");
  CB_CHECK(region != nullptr);
  CB_CHECK_EQ(region->levels.size(), static_cast<std::size_t>(2));
  CB_CHECK_EQ(region->levels[0], std::string("Córdoba"));
  CB_CHECK_EQ(region->levels[1], std::string("Neuquén"));
  CB_CHECK(has_action(r, ActionKind::ConvertedEncoding));
  // Y el CSV que se lleva el usuario ya sale en UTF-8.
  CB_CHECK(to_csv(r).find("Neuquén") != std::string::npos);
}

CB_TEST(table, a_utf8_file_reports_no_conversion) {
  const CleanResult r = clean_buffer("año;región\n2024;Córdoba\n2023;Neuquén\n2022;Córdoba\n");
  CB_CHECK(!has_action(r, ActionKind::ConvertedEncoding));
}

CB_TEST(table, encoding_fix_can_be_turned_off) {
  CleanOptions opts;
  opts.fix_encoding = false;
  const CleanResult r = clean_buffer("a\xF1o;monto\n2024;100\n2023;90\n", opts);
  CB_CHECK(!has_action(r, ActionKind::ConvertedEncoding));
  CB_CHECK_EQ(r.columns[0].name, std::string("a\xF1o"));
}

CB_TEST(table, preamble_is_skipped_and_reported) {
  const CleanResult r = clean_buffer(
      "Reporte de ventas 2024\n"
      "Generado el 03/09/2026\n"
      "\n"
      "fecha;provincia;monto\n"
      "01/03/2024;Buenos Aires;1.234,50\n"
      "02/03/2024;Cordoba;2.000,00\n"
      "03/03/2024;Santa Fe;1.500,00\n"
      "04/03/2024;Mendoza;900,00\n");
  CB_CHECK_EQ(types(r), std::string("fecha:date,provincia:text,monto:numeric"));
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(4));
  CB_CHECK(has_action(r, ActionKind::SkippedPreambleRows));
}

CB_TEST(table, preamble_detection_can_be_turned_off) {
  CleanOptions opts;
  opts.detect_preamble = false;
  const CleanResult r = clean_buffer(
      "Reporte de ventas 2024\n"
      "Generado el 03/09/2026\n"
      "fecha;provincia;monto\n"
      "01/03/2024;Buenos Aires;1.234,50\n"
      "02/03/2024;Cordoba;2.000,00\n"
      "03/03/2024;Santa Fe;1.500,00\n",
      opts);
  CB_CHECK(!has_action(r, ActionKind::SkippedPreambleRows));
}

CB_TEST(table, preamble_can_be_given_by_hand) {
  CleanOptions opts;
  opts.dialect.preamble_rows = 1;
  // Una sola linea de titulo sobre una tabla de dos columnas: el sniffer no
  // tiene con que decidir, el usuario si.
  const CleanResult r = clean_buffer("Serie mensual\nfecha,valor\n2024-01-01,10\n2024-01-02,11\n",
                                     opts);
  CB_CHECK_EQ(types(r), std::string("fecha:date,valor:numeric"));
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(2));
}

CB_TEST(table, footer_row_with_a_label_is_dropped) {
  const CleanResult r = clean_buffer(
      "concepto,monto\n"
      "alquiler,100\n"
      "sueldos,200\n"
      "insumos,300\n"
      "servicios,400\n"
      "TOTAL,1000\n");
  const Column* monto = col_by_name(r, "monto");
  CB_CHECK(monto != nullptr);
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(4));
  CB_CHECK_NEAR(monto->stats.max, 400.0, 1e-9);
  CB_CHECK_NEAR(monto->stats.mean, 250.0, 1e-9);
  CB_CHECK(has_action(r, ActionKind::DroppedFooterRows));
}

CB_TEST(table, footer_row_is_found_by_arithmetic_without_a_label) {
  // La prueba dura: el valor es exactamente la suma de lo que tiene encima. No
  // depende del idioma de la etiqueta, ni de que haya etiqueta.
  const CleanResult r = clean_buffer("anio;ventas\n2020;100\n2021;200\n2022;300\n2023;400\n;1000\n");
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(4));
  CB_CHECK(has_action(r, ActionKind::DroppedFooterRows));
}

CB_TEST(table, trailing_note_is_dropped) {
  const CleanResult r = clean_buffer(
      "fecha;monto\n01/03/2024;100\n02/03/2024;200\n03/03/2024;300\n04/03/2024;400\n"
      "Fuente: INDEC;\n");
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(4));
  CB_CHECK(has_action(r, ActionKind::DroppedFooterRows));
}

CB_TEST(table, a_clean_file_loses_no_footer) {
  const CleanResult r = clean_buffer(
      "fecha;monto\n01/03/2024;100\n02/03/2024;200\n03/03/2024;300\n04/03/2024;400\n");
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(4));
  CB_CHECK(!has_action(r, ActionKind::DroppedFooterRows));
}

CB_TEST(table, footer_can_be_kept) {
  CleanOptions opts;
  opts.drop_footer_rows = false;
  const CleanResult r = clean_buffer(
      "concepto,monto\nalquiler,100\nsueldos,200\ninsumos,300\nservicios,400\nTOTAL,1000\n",
      opts);
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(5));
  CB_CHECK(!has_action(r, ActionKind::DroppedFooterRows));
}

CB_TEST(table, footer_leaves_the_date_column_typed_as_a_date) {
  // En un archivo chico el pie no solo mueve la media: baja a 5/6 la proporcion
  // de celdas que parsean como fecha, por debajo del umbral de 0,9, y la
  // columna entera terminaba tipada como texto. Por eso el pie se saca antes de
  // votar los tipos y no despues.
  const CleanResult r = clean_buffer(
      "fecha;provincia;monto\n"
      "01/03/2024;Buenos Aires;1.234,50\n"
      "02/03/2024;Cordoba;2.000,00\n"
      "03/03/2024;Santa Fe;1.500,00\n"
      "04/03/2024;Mendoza;900,00\n"
      "05/03/2024;Salta;1.100,00\n"
      "TOTAL;;6.734,50\n");
  CB_CHECK_EQ(types(r), std::string("fecha:date,provincia:text,monto:numeric"));
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(5));
}

CB_TEST(table, a_column_of_zeros_is_not_a_footer) {
  // 0 == suma(0,0,0) es aritmetica trivial, no evidencia.
  const CleanResult r = clean_buffer("mes,fallas\n1,0\n2,0\n3,0\n4,0\n");
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(4));
  CB_CHECK(!has_action(r, ActionKind::DroppedFooterRows));
}

CB_TEST(table, an_overflowed_sum_is_not_a_footer) {
  // La suma de las tres filas de arriba desborda a infinito. inf - v tambien es
  // infinito, y "> tolerancia" con una tolerancia que tambien se fue a infinito
  // daba false: la resta parecia "exacta" sin que ninguna cuenta real lo fuera,
  // y la ultima fila se descartaba como si fuera el total.
  const CleanResult r =
      clean_buffer("id,x\n1,1e308\n2,1.1e308\n3,1.2e308\n4,5\n");
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(4));
  CB_CHECK(!has_action(r, ActionKind::DroppedFooterRows));
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

CB_TEST(table, ambiguous_decimal_is_not_reported_for_a_non_numeric_column) {
  // v.numbers.observe() corre sobre toda celda de toda columna para juntar
  // evidencia, sin importar en qué tipo termina la columna. Antes de esto,
  // una columna de texto (mails) con un puñado de valores con forma de
  // "1.234" — y nada que decida coma contra punto — se reportaba como
  // "separador decimal ambiguo" aunque nunca se fue a leer como número. El
  // diagnóstico solo tiene sentido para una columna que terminó siendo
  // Numeric, igual que su vecino de InferredDecimal tres líneas más arriba.
  const CleanResult r = clean_buffer(
      "id;correo\n"
      "1;juan@example.com\n"
      "2;1.234\n"
      "3;maria@example.com\n"
      "4;1.234\n"
      "5;pedro@example.com\n"
      "6;1.234\n");
  const Column* correo = col_by_name(r, "correo");
  CB_CHECK(correo != nullptr);
  CB_CHECK(correo->type != ColumnType::Numeric);
  CB_CHECK(!has_action(r, ActionKind::AmbiguousDecimal));
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

CB_TEST(table, a_control_byte_in_a_cell_is_not_a_field_boundary) {
  // El hash de fila juntaba los campos con \x1f de separador — el mismo byte
  // que el scanner usa como "acá no hay delimitador", elegido justamente
  // porque no aparece en un CSV de texto. Cuando aparece igual, el dato y el
  // marco se confunden: ("ab\x1f", "c") y ("ab", "\x1fc") dan la misma
  // secuencia de bytes, y la segunda fila se descartaba como duplicada de la
  // primera sin serlo. No es la colisión de 1 en 2⁶⁴ que el README asume: es
  // determinística, y silenciosa.
  const CleanResult r = clean_buffer(
      "c1,c2\n"
      "ab\x1f,c\n"
      "ab,\x1f" "c\n");
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(2));
  CB_CHECK(!has_action(r, ActionKind::DroppedDuplicateRows));
}

CB_TEST(table, a_control_byte_does_not_make_two_columns_identical) {
  // El mismo defecto en column_hash, que además lo afirma en el reporte: "es
  // idéntica fila por fila a", sobre columnas que no lo son.
  const CleanResult r = clean_buffer(
      "id,a,b\n"
      "1,ab\x1f,ab\n"
      "2,c,\x1f" "c\n"
      "3,zz,zz\n");
  CB_CHECK_EQ(r.columns.size(), static_cast<std::size_t>(3));
  CB_CHECK(!has_action(r, ActionKind::DroppedDuplicateColumn));
}

CB_TEST(table, identical_rows_and_columns_are_still_caught) {
  // Y el contrapunto: enmarcar los campos no puede costar la detección real.
  const CleanResult r = clean_buffer("a,b\n1,1\n2,2\n1,1\n3,3\n");
  CB_CHECK(has_action(r, ActionKind::DroppedDuplicateRows));
  CB_CHECK(has_action(r, ActionKind::DroppedDuplicateColumn));
}

CB_TEST(table, format_number_does_not_cast_out_of_range_doubles) {
  // El atajo de imprimir como entero evaluaba el cast a long long *antes* de
  // mirar el rango: && corta por la derecha, y el cast está a la izquierda del
  // ==. Con un valor finito pero enorme eso es undefined behavior — lo cazó
  // UBSan, no los tests, porque el resultado salía bien igual por casualidad.
  CB_CHECK_EQ(format_number(1.2345678901234567e+59), std::string("1.2345678901234567e+59"));
  CB_CHECK_EQ(format_number(1e300), std::string("1e+300"));
  CB_CHECK_EQ(format_number(-1e300), std::string("-1e+300"));
  // Y el atajo sigue andando donde sí corresponde.
  CB_CHECK_EQ(format_number(42.0), std::string("42"));
  CB_CHECK_EQ(format_number(-7.0), std::string("-7"));
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

CB_TEST(table, dropping_a_row_does_not_erase_text_kept_before_it) {
  // compact() corria col.text[w] = std::move(col.text[i]) incluso cuando
  // w == i, que es el caso de toda fila conservada antes del primer descarte.
  // Mover un std::string sobre si mismo lo deja vacio (libstdc++ y libc++ las
  // dos), asi que "alfa" y "beta" desaparecian aunque sus filas seguian
  // presentes en la mascara.
  CleanOptions opts;
  opts.missing = MissingPolicy::DropRow;
  const CleanResult r = clean_buffer("txt,v\nalfa,1\nbeta,2\ngamma,\ndelta,4\n", opts);
  CB_CHECK_EQ(r.rows_out, static_cast<std::size_t>(3));
  const Column* txt = col_by_name(r, "txt");
  CB_CHECK(txt != nullptr);
  CB_CHECK_EQ(txt->text[0], std::string("alfa"));
  CB_CHECK_EQ(txt->text[1], std::string("beta"));
  CB_CHECK_EQ(txt->text[2], std::string("delta"));
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

CB_TEST(scan, agrees_with_the_full_pass_on_what_it_reports) {
  const char* csv =
      "fecha;pais;monto;nota\n"
      "01/03/2024;AR;1.234,50;alfa\n"
      "02/03/2024;BR;2.000,00;beta\n"
      "03/03/2024;AR;-;gamma\n"
      "04/03/2024;CL;98,75;delta\n"
      "05/03/2024;BR;abc;epsilon\n"
      "06/03/2024;AR;115,00;zeta\n";

  CleanOptions scan;
  scan.scan_only = true;
  scan.drop_duplicate_rows = false;  // the full pass would use it; scan cannot
  CleanOptions full;
  full.drop_duplicate_rows = false;

  const CleanResult a = clean_buffer(csv, scan);
  const CleanResult b = clean_buffer(csv, full);

  CB_CHECK_EQ(a.rows_out, b.rows_out);
  CB_CHECK_EQ(a.columns.size(), b.columns.size());
  for (std::size_t j = 0; j < a.columns.size() && j < b.columns.size(); ++j) {
    CB_CHECK_EQ(a.columns[j].name, b.columns[j].name);
    CB_CHECK_EQ(static_cast<int>(a.columns[j].type), static_cast<int>(b.columns[j].type));
    CB_CHECK_EQ(a.columns[j].stats.present, b.columns[j].stats.present);
    CB_CHECK_EQ(a.columns[j].stats.missing, b.columns[j].stats.missing);
    CB_CHECK_EQ(a.columns[j].stats.invalid, b.columns[j].stats.invalid);
    if (b.columns[j].stats.has_moments) {
      CB_CHECK_NEAR(a.columns[j].stats.min, b.columns[j].stats.min, 1e-9);
      CB_CHECK_NEAR(a.columns[j].stats.max, b.columns[j].stats.max, 1e-9);
      CB_CHECK_NEAR(a.columns[j].stats.mean, b.columns[j].stats.mean, 1e-9);
      CB_CHECK_NEAR(a.columns[j].stats.sd, b.columns[j].stats.sd, 1e-9);
    }
  }
}

CB_TEST(scan, stores_nothing_per_row) {
  // The whole point: memory must not grow with the row count. Ten times the
  // rows, byte-identical storage.
  std::string small = "a,b\n";
  std::string large = "a,b\n";
  for (int i = 0; i < 50; ++i) small += std::to_string(i) + ",x" + std::to_string(i) + "\n";
  for (int i = 0; i < 5000; ++i) large += std::to_string(i) + ",x" + std::to_string(i) + "\n";

  CleanOptions opts;
  opts.scan_only = true;
  opts.drop_duplicate_rows = false;
  const CleanResult a = clean_buffer(small, opts);
  const CleanResult b = clean_buffer(large, opts);

  CB_CHECK_EQ(a.rows_out, static_cast<std::size_t>(50));
  CB_CHECK_EQ(b.rows_out, static_cast<std::size_t>(5000));
  for (const CleanResult* r : {&a, &b}) {
    for (const Column& col : r->columns) {
      CB_CHECK_EQ(col.values.size(), static_cast<std::size_t>(0));
      CB_CHECK_EQ(col.mask.size(), static_cast<std::size_t>(0));
      CB_CHECK_EQ(col.codes.size(), static_cast<std::size_t>(0));
      CB_CHECK_EQ(col.text.size(), static_cast<std::size_t>(0));
    }
  }
}

CB_TEST(scan, keeps_text_columns_and_reports_no_quantiles) {
  CleanOptions opts;
  opts.scan_only = true;
  const CleanResult r = clean_buffer(
      "id,libre\n1,uno\n2,dos\n3,tres\n4,cuatro\n5,cinco\n6,seis\n", opts);
  // A text column has no unique count in scan mode, so it must not be mistaken
  // for a constant column and dropped.
  const Column* libre = col_by_name(r, "libre");
  CB_CHECK(libre != nullptr);
  CB_CHECK(libre->stats.unique_capped);
  const Column* id = col_by_name(r, "id");
  CB_CHECK(id != nullptr);
  CB_CHECK(id->stats.has_moments);
  CB_CHECK(!id->stats.has_quantiles);
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

CB_TEST(table, forcing_the_decimal_separator_overrides_the_vote) {
  // El caso que motivó la opción: una columna ambigua hereda lo que votó el
  // resto del archivo, y si esa herencia está mal el usuario no tenía forma de
  // corregirla. fallback_decimal no alcanza — solo entra cuando el archivo
  // entero quedó indeciso, y acá "claro" vota coma decisivamente.
  const char* csv = "claro;ambiguo\n1.234,56;100.000\n2.500,10;200.000\n3.000,25;300.000\n";

  const CleanResult heredado = clean_buffer(csv);
  const Column* a = col_by_name(heredado, "ambiguo");
  CB_CHECK(a != nullptr);
  CB_CHECK_NEAR(a->values[0], 100000.0, 1e-6);  // coma decimal ⇒ el punto agrupa

  CleanOptions forzado;
  forzado.force_decimal = '.';
  const CleanResult b = clean_buffer(csv, forzado);
  const Column* amb = col_by_name(b, "ambiguo");
  CB_CHECK(amb != nullptr);
  CB_CHECK_NEAR(amb->values[0], 100.0, 1e-9);  // ahora el punto es decimal
  // Y fuerza toda la tabla, no solo la columna ambigua.
  const Column* claro = col_by_name(b, "claro");
  CB_CHECK(claro != nullptr);
  CB_CHECK_EQ(claro->number_format.decimal, '.');
}

CB_TEST(table, forcing_the_date_order_overrides_the_vote) {
  // 05/03 es ambigua, pero 13/01 fija DD/MM para toda la columna. Forzar MM/DD
  // tiene que ganarle a esa evidencia.
  const char* csv = "fecha,valor\n13/01/2024,1\n05/03/2024,2\n06/04/2024,3\n";
  const CleanResult votado = clean_buffer(csv);
  CB_CHECK_EQ(static_cast<int>(votado.columns[0].date_order), static_cast<int>(DateOrder::DMY));

  CleanOptions forzado;
  forzado.force_date_order = DateOrder::MDY;
  const CleanResult b = clean_buffer(csv, forzado);
  CB_CHECK_EQ(static_cast<int>(b.columns[0].date_order), static_cast<int>(DateOrder::MDY));
}
