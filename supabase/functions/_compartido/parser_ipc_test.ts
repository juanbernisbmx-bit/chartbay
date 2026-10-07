import { assertEquals, assertThrows } from "jsr:@std/assert@1";
// @deno-types="https://cdn.sheetjs.com/xlsx-0.20.3/package/types/index.d.ts"
import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
import { archivos } from "./fuente_ipc.ts";
import { ErrorParseo, leerArchivo } from "./parser_ipc.ts";

const NACIONAL = archivos("2026-10-06")[0];
const fechaExcel = (anio: number, mes: number, dia = 1) => (Date.UTC(anio, mes - 1, dia) - Date.UTC(1899, 11, 30)) / 86_400_000;

// Un .xls (BIFF8) con la forma del cuadro nacional: rótulo con encabezados de fecha y, abajo, la fila "Nivel general".
function libro(encabezados: (number | string | null)[], valores: (number | string | null)[], extra: (string | null)[][] = []): Uint8Array {
  const hoja: XLSX.WorkSheet = {};
  const poner = (f: number, c: number, celda: XLSX.CellObject) => (hoja[XLSX.utils.encode_cell({ r: f, c })] = celda);
  poner(0, 0, { t: "s", v: "Título del cuadro" });
  poner(2, 0, { t: "s", v: "Total nacional" });
  encabezados.forEach((e, i) => e !== null && poner(2, i + 1, typeof e === "number" ? { t: "n", v: e, z: "mmm-yy" } : { t: "s", v: e }));
  poner(4, 0, { t: "s", v: "Nivel general" });
  valores.forEach((v, i) => v !== null && poner(4, i + 1, typeof v === "number" ? { t: "n", v } : { t: "s", v }));
  extra.forEach((fila, i) => fila.forEach((v, c) => v !== null && poner(5 + i, c, { t: "s", v })));
  hoja["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 5 + extra.length, c: Math.max(encabezados.length, valores.length) } });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, hoja, NACIONAL.hoja);
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "biff8" }));
}

const BASE = [fechaExcel(2016, 12), fechaExcel(2017, 1), fechaExcel(2017, 2)];

Deno.test("lee la serie, anota el día normalizado y escribe los valores como Python", () => {
  const serie = leerArchivo(libro([...BASE.slice(0, 2), fechaExcel(2017, 2, 26)], [100, 101.5859, 103]), "x.xls", NACIONAL).ipc_ng_nacional;
  assertEquals(serie.observaciones, [["2016-12-01", "100.0"], ["2017-01-01", "101.5859"], ["2017-02-01", "103.0"]]);
  assertEquals(serie.notas, ["Encabezado 2017-02-26 interpretado como período mensual 2017-02"]);
  assertEquals([serie.fila_origen, serie.archivo, serie.hoja], [5, "nacional", NACIONAL.hoja]);
});

Deno.test("lo que no se puede interpretar aborta con el mismo mensaje que Python", () => {
  const casos: [Uint8Array, string][] = [
    [libro([...BASE.slice(0, 2), "marzo"], [100, 101, 102]), "Encabezado temporal inesperado en ipc_ng_nacional, columna 4"],
    [libro(BASE, [100, 101, -1]), "Valor no numérico o no positivo en ipc_ng_nacional, 2017-02"],
    [libro(BASE, [100, "s/d", 102]), "Valor no numérico o no positivo en ipc_ng_nacional, 2017-01"],
    [libro(BASE, [101, 102, 103]), "La base de referencia de ipc_ng_nacional cambió"],
    [libro([BASE[0], BASE[2]], [100, 101]), "Períodos repetidos, ausentes o desordenados en ipc_ng_nacional: 2016-12-01 a 2017-02-01"],
    [libro(BASE, [100, 101, 102], [["Nivel general"]]), "Se esperaba una fila Nivel general para Total nacional; encontradas: 2"],
    [libro([], []), "La serie ipc_ng_nacional no contiene observaciones"],
  ];
  for (const [contenido, mensaje] of casos) assertThrows(() => leerArchivo(contenido, "x.xls", NACIONAL), ErrorParseo, mensaje);
  assertThrows(() => leerArchivo(libro(BASE, [100, 101, 102]), "x.xls", archivos("2026-10-06")[1]), ErrorParseo, "No se pudo abrir la hoja «Índices aperturas»");
  assertThrows(() => leerArchivo(new TextEncoder().encode("<html>no existe</html>"), "x.xls", NACIONAL), ErrorParseo);
});

const ORIGINALES = Deno.env.get("DATOS_IPC_ORIGINALES_DIR");
Deno.test({
  name: "lee los archivos reales de INDEC",
  ignore: !ORIGINALES,
  fn() {
    const [nacional, aperturas] = archivos("2026-10-06");
    const series = {
      ...leerArchivo(Deno.readFileSync(`${ORIGINALES}/sh_ipc_09_26.xls`), "sh_ipc_09_26.xls", nacional),
      ...leerArchivo(Deno.readFileSync(`${ORIGINALES}/sh_ipc_aperturas.xls`), "sh_ipc_aperturas.xls", aperturas),
    };
    assertEquals(Object.keys(series).length, 7);
    assertEquals(Object.values(series).reduce((n, s) => n + s.observaciones.length, 0), 819);
  },
});
