// Lectura estricta de los cuadros XLS del IPC de INDEC: la traducción de `servicio_datos/ipc/parser.py`, con las mismas
// exigencias y los mismos mensajes. Una prueba de Python compara la carga que arman los dos con los archivos reales.
//
// Extrae las series configuradas sin inventar períodos ni valores. El día del encabezado se normaliza al primer día del
// mes y se anota en `notas` cuando difiere. Una forma o un valor que no se puede interpretar aborta la carga.

// @deno-types="https://cdn.sheetjs.com/xlsx-0.20.3/package/types/index.d.ts"
import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
import type { ArchivoFuente } from "./fuente_ipc.ts";
import { comoPython } from "./numeros.ts";

const MAX_FILAS_HASTA_NIVEL = 7;

export class ErrorParseo extends Error {
  override name = "ErrorParseo";
}

export interface SerieLeida {
  serie_id: string;
  archivo: string; // ArchivoFuente.clave
  hoja: string;
  fila_origen: number; // 1-based: la fila "Nivel general" de donde salen los valores
  observaciones: [string, string][]; // [AAAA-MM-01, valor como texto], en orden
  notas: string[];
}

// deno-lint-ignore no-explicit-any
type Celda = any;

const dosDigitos = (n: number) => String(n).padStart(2, "0");

export function leerArchivo(contenido: Uint8Array, nombreArchivo: string, archivo: ArchivoFuente): Record<string, SerieLeida> {
  let libro: XLSX.WorkBook;
  try {
    libro = XLSX.read(contenido, { type: "array", cellNF: true, cellDates: false, dense: true });
  } catch (error) {
    throw new ErrorParseo(`No se pudo abrir la hoja «${archivo.hoja}» de ${nombreArchivo}: ${(error as Error).message}`);
  }
  const hoja = libro.Sheets[archivo.hoja];
  if (!hoja) throw new ErrorParseo(`No se pudo abrir la hoja «${archivo.hoja}» de ${nombreArchivo}: no está en el libro`);
  const fecha1904 = Boolean(libro.Workbook?.WBProps?.date1904);
  const filas: Celda[][] = (hoja as Celda)["!data"] ?? [];
  const rango = XLSX.utils.decode_range(hoja["!ref"] ?? "A1:A1");
  const celda = (f: number, c: number): Celda => filas[f]?.[c];
  const texto = (f: number, c: number) => {
    const valor = celda(f, c)?.v;
    return valor === undefined || valor === null ? "" : String(valor).trim();
  };

  const resultado: Record<string, SerieLeida> = {};
  for (let fila = 0; fila <= rango.e.r; fila++) {
    const rotulo = texto(fila, 0);
    if (!(rotulo in archivo.series)) continue;
    const serieId = archivo.series[rotulo];
    if (serieId in resultado) throw new ErrorParseo(`Rótulo repetido para ${serieId} en ${archivo.hoja}`);
    const candidatas: number[] = [];
    for (let i = fila + 1; i <= Math.min(fila + MAX_FILAS_HASTA_NIVEL, rango.e.r); i++) {
      if (texto(i, 0) === "Nivel general") candidatas.push(i);
    }
    if (candidatas.length !== 1) throw new ErrorParseo(`Se esperaba una fila Nivel general para ${rotulo}; encontradas: ${candidatas.length}`);
    const filaValores = candidatas[0];
    const observaciones: [string, string][] = [];
    const notas: string[] = [];
    for (let columna = 1; columna <= rango.e.c; columna++) {
      const encabezado = celda(fila, columna);
      if (encabezado === undefined || encabezado.t === "z" || encabezado.v === undefined || encabezado.v === "") continue;
      if (encabezado.t !== "n" || !XLSX.SSF.is_date(encabezado.z ?? "")) {
        throw new ErrorParseo(`Encabezado temporal inesperado en ${serieId}, columna ${columna + 1}`);
      }
      const fecha = XLSX.SSF.parse_date_code(encabezado.v, { date1904: fecha1904 });
      if (!fecha || !fecha.y) throw new ErrorParseo(`Fecha Excel inválida en ${serieId}, columna ${columna + 1}`);
      const periodo = `${fecha.y}-${dosDigitos(fecha.m)}-01`;
      if (fecha.d !== 1) {
        notas.push(`Encabezado ${fecha.y}-${dosDigitos(fecha.m)}-${dosDigitos(fecha.d)} interpretado como período mensual ${fecha.y}-${dosDigitos(fecha.m)}`);
      }
      const valor = celda(filaValores, columna);
      if (!valor || valor.t !== "n" || !Number.isFinite(valor.v) || valor.v <= 0) {
        throw new ErrorParseo(`Valor no numérico o no positivo en ${serieId}, ${periodo.slice(0, 7)}`);
      }
      observaciones.push([periodo, comoPython(valor.v)]);
    }

    if (observaciones.length === 0) throw new ErrorParseo(`La serie ${serieId} no contiene observaciones`);
    if (observaciones[0][0] !== "2016-12-01" || Number(observaciones[0][1]) !== 100) {
      throw new ErrorParseo(`La base de referencia de ${serieId} cambió: se espera diciembre de 2016 = 100`);
    }
    for (let i = 1; i < observaciones.length; i++) {
      const [anterior, actual] = [observaciones[i - 1][0], observaciones[i][0]];
      if (meses(actual) - meses(anterior) !== 1) {
        throw new ErrorParseo(`Períodos repetidos, ausentes o desordenados en ${serieId}: ${anterior} a ${actual}`);
      }
    }
    resultado[serieId] = { serie_id: serieId, archivo: archivo.clave, hoja: archivo.hoja, fila_origen: filaValores + 1, observaciones, notas };
  }

  const faltantes = Object.values(archivo.series).filter((id) => !(id in resultado)).sort();
  if (faltantes.length) throw new ErrorParseo(`Faltan series esperadas en ${archivo.hoja}: ${faltantes.join(", ")}`);
  return resultado;
}

function meses(periodo: string): number {
  const [anio, mes] = periodo.split("-").map(Number);
  return anio * 12 + mes;
}
