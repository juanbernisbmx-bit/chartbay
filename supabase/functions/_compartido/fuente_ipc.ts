// Fuente INDEC_IPC: dónde están los archivos, cómo se llaman y qué trae cada uno. Es la traducción de
// `servicio_datos/ipc/fuente.py`; una prueba de Python compara las dos.
//
// Lo aprendido de INDEC (verificado el 2026-10-06):
// - `sh_ipc_MM_AA.xls` lleva el mes de PUBLICACIÓN, no el del dato.
// - `sh_ipc_aperturas.xls` tiene nombre fijo y se pisa en cada publicación.
// - Un archivo que no existe NO da 404: INDEC responde 200 con una página HTML. Hay que mirar el contenido.
// - El `Last-Modified` dice cuándo cambió el archivo en el servidor, no cuándo se publicó oficialmente.

export const FUENTE_ID = "INDEC_IPC";
export const FUENTE_NOMBRE = "INDEC";
export const URL_BASE = "https://www.indec.gob.ar/ftp/cuadros/economia/";
export const URL_PUBLICACION = "https://www.indec.gob.ar/indec/web/Nivel4-Tema-3-5-31";
export const HOST = "www.indec.gob.ar";

export const REGIONES: Record<string, string> = {
  "Región GBA": "ipc_ng_gba",
  "Región Pampeana": "ipc_ng_pampeana",
  "Región Noroeste": "ipc_ng_noa",
  "Región Noreste": "ipc_ng_nea",
  "Región Cuyo": "ipc_ng_cuyo",
  "Región Patagonia": "ipc_ng_patagonia",
};

export interface Definicion {
  nombre: string;
  tema: string;
  nivel: string;
  territorio: string;
  clasificacion: string;
  frecuencia: string;
  unidad: string;
  base: string;
}

const BASE_INDICE = "Diciembre 2016=100; serie original";
const TERRITORIOS: Record<string, string> = {
  ipc_ng_gba: "Gran Buenos Aires",
  ipc_ng_pampeana: "Pampeana",
  ipc_ng_nea: "Noreste",
  ipc_ng_noa: "Noroeste",
  ipc_ng_cuyo: "Cuyo",
  ipc_ng_patagonia: "Patagonia",
};

function definicion(nombre: string, nivel: string, territorio: string, clasificacion: string): Definicion {
  return { nombre, tema: "Precios", nivel, territorio, clasificacion, frecuencia: "Mensual", unidad: "Índice", base: BASE_INDICE };
}

// Lo que la tabla `serie` necesita antes de guardar observaciones.
export const DEFINICIONES: Record<string, Definicion> = {
  ipc_ng_nacional: definicion("IPC nivel general - Argentina", "Nacional", "Argentina", "Total nacional IPC"),
  ...Object.fromEntries(Object.entries(TERRITORIOS).map(([id, territorio]) =>
    [id, definicion(`IPC nivel general - ${territorio}`, "Regional", territorio, "Regiones IPC de INDEC")])),
};

export interface ArchivoFuente {
  clave: string;
  hoja: string;
  series: Record<string, string>; // rótulo de la primera columna -> id de serie
  nombres: string[]; // del más nuevo al más viejo
}

/** `sh_ipc_MM_AA.xls` del mes de `hoy` (AAAA-MM-DD) hacia atrás, el más nuevo primero. */
export function nombresNacional(hoy: string, mesesAtras = 3): string[] {
  let [anio, mes] = hoy.split("-").map(Number);
  const nombres: string[] = [];
  for (let i = 0; i < mesesAtras; i++) {
    nombres.push(`sh_ipc_${String(mes).padStart(2, "0")}_${String(anio % 100).padStart(2, "0")}.xls`);
    mes -= 1;
    if (mes === 0) [anio, mes] = [anio - 1, 12];
  }
  return nombres;
}

export function archivos(hoy: string): ArchivoFuente[] {
  return [
    { clave: "nacional", hoja: "Índices IPC Cobertura Nacional", series: { "Total nacional": "ipc_ng_nacional" }, nombres: nombresNacional(hoy) },
    { clave: "aperturas", hoja: "Índices aperturas", series: REGIONES, nombres: ["sh_ipc_aperturas.xls"] },
  ];
}

export function urlsCandidatas(archivo: ArchivoFuente): string[] {
  return archivo.nombres.map((nombre) => URL_BASE + nombre);
}
