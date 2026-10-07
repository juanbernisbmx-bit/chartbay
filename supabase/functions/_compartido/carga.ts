// La carga que espera `cargar_candidato` en la base (migración 0011): lo mismo que arma `servicio_datos/carga.py`.
import { DEFINICIONES } from "./fuente_ipc.ts";
import type { SerieLeida } from "./parser_ipc.ts";

export function cargaDe(series: Record<string, SerieLeida>, descargados: Iterable<string>) {
  return {
    series: Object.values(series).map((s) => ({
      serie_id: s.serie_id, archivo: s.archivo, hoja: s.hoja, fila_origen: s.fila_origen, observaciones: s.observaciones, notas: s.notas,
    })),
    definiciones: DEFINICIONES,
    descargados: [...new Set(descargados)].sort(),
  };
}
