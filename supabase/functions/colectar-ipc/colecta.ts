// La colecta del IPC: baja los archivos de INDEC, guarda los originales y le deja a la base el resto (`cargar_candidato`).
// Traduce `servicio_datos/colector.py` y la parte de `pipeline.py` anterior a la carga. Termina en uno de cuatro estados:
// - `sin_cambios`: nada nuevo (archivos idénticos a los conocidos, o nuevos pero con los mismos datos que lo publicado);
// - `con_candidato`: hay un candidato abierto esperando revisión;
// - `fallida`: algo se rompió; la corrida queda cerrada como fallida, nunca a medias;
// - `ocupado`: ya había otra corrida en curso.
import { type Almacen, rutaCrudo, sha256Hex } from "../_compartido/almacen.ts";
import { type Base, ErrorNegocio } from "../_compartido/base.ts";
import { cargaDe } from "../_compartido/carga.ts";
import { isoUtc } from "../_compartido/fechas.ts";
import { type ArchivoFuente, archivos, FUENTE_ID, FUENTE_NOMBRE, URL_PUBLICACION, urlsCandidatas } from "../_compartido/fuente_ipc.ts";
import { ErrorHttp, type Respuesta } from "../_compartido/http.ts";
import { ErrorParseo, leerArchivo, type SerieLeida } from "../_compartido/parser_ipc.ts";

export const VENCIMIENTO_SEGUNDOS = 6 * 3600;
const MAGIA_XLS = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // contenedor OLE2 de los .xls
const MIN_BYTES_XLS = 10_000;
const TIPO_XLS = "application/vnd.ms-excel";

export interface Dependencias {
  base: Base;
  almacen: Almacen;
  http: { get(url: string): Promise<Respuesta> };
  hoy: string; // AAAA-MM-DD
  vencimientoSegundos?: number;
  leer?: (contenido: Uint8Array, nombre: string, archivo: ArchivoFuente) => Record<string, SerieLeida>;
}

export interface Resultado {
  estado: "sin_cambios" | "con_candidato" | "fallida" | "ocupado";
  corrida: number | null;
  candidato_id?: number;
  hallazgos?: number;
  error?: string;
}

interface Registrada {
  clave: string;
  url: string;
  sha256: string;
  estado: "nueva" | "identica";
  publicadaEn: Date | null;
  contenido: Uint8Array;
}

class ErrorColecta extends Error {
  constructor(readonly url: string, mensaje: string) {
    super(mensaje);
  }
}

export function esXls(contenido: Uint8Array): boolean {
  return contenido.length >= MIN_BYTES_XLS && MAGIA_XLS.every((byte, i) => contenido[i] === byte);
}

// El primer candidato que sea de verdad un .xls, del más nuevo al más viejo. INDEC contesta 200 con una página HTML a los
// archivos que todavía no existen: el criterio es el contenido. Un error de red NO pasa al candidato siguiente: caer al mes
// anterior ocultaría que hay una publicación nueva.
async function buscar(http: Dependencias["http"], archivo: ArchivoFuente): Promise<{ url: string; respuesta: Respuesta }> {
  let url = "";
  for (url of urlsCandidatas(archivo)) {
    let respuesta: Respuesta;
    try {
      respuesta = await http.get(url);
    } catch (error) {
      throw new ErrorColecta(url, (error as Error).message);
    }
    if (respuesta.estado === 200 && esXls(respuesta.contenido)) return { url, respuesta };
  }
  throw new ErrorColecta(url, `Ninguna de ${archivo.nombres.length} URL candidata de «${archivo.clave}» devolvió un archivo XLS`);
}

function resumen(registradas: Registrada[]) {
  return {
    archivos: registradas.map((r) => ({
      clave: r.clave, url: r.url, estado: r.estado, sha256: r.sha256, publicada_en: r.publicadaEn ? isoUtc(r.publicadaEn) : null,
    })),
  };
}

export async function colectarIpc(d: Dependencias): Promise<Resultado> {
  const leer = d.leer ?? leerArchivo;
  await d.base.asegurarFuente(FUENTE_ID, FUENTE_NOMBRE, URL_PUBLICACION);
  const corrida = await d.base.abrirCorrida(FUENTE_ID, d.vencimientoSegundos ?? VENCIMIENTO_SEGUNDOS);
  if (corrida === null) return { estado: "ocupado", corrida: null, error: "Ya hay una corrida en curso para esta fuente" };

  const registradas: Registrada[] = [];
  try {
    const archivosDeHoy = archivos(d.hoy);
    for (const archivo of archivosDeHoy) {
      let encontrado: { url: string; respuesta: Respuesta };
      try {
        encontrado = await buscar(d.http, archivo);
      } catch (error) {
        if (!(error instanceof ErrorColecta)) throw error;
        await d.base.registrarDescarga({ corrida, url: error.url, estado: "fallida", error: error.message });
        await d.base.cerrarCorrida(corrida, "fallida", error.message, resumen(registradas));
        return { estado: "fallida", corrida, error: error.message };
      }
      const { url, respuesta } = encontrado;
      const sha256 = await sha256Hex(respuesta.contenido);
      const ruta = rutaCrudo(sha256);
      await d.almacen.guardar(ruta, respuesta.contenido, TIPO_XLS);
      const estado = (await d.base.ultimaDescarga(url)) === sha256 ? "identica" : "nueva";
      await d.base.registrarDescarga({ corrida, url, estado, sha256, bytes: respuesta.contenido.length, rutaCrudo: ruta, publicadaEn: respuesta.lastModified });
      registradas.push({ clave: archivo.clave, url, sha256, estado, publicadaEn: respuesta.lastModified, contenido: respuesta.contenido });
    }

    if (registradas.every((r) => r.estado === "identica")) {
      await d.base.cerrarCorrida(corrida, "sin_cambios", null, resumen(registradas));
      return { estado: "sin_cambios", corrida };
    }
    await d.base.anotarCorrida(corrida, resumen(registradas));

    // El parser rechaza lo que no puede interpretar: es un problema de los datos, no un bug.
    let series: Record<string, SerieLeida> = {};
    try {
      for (const r of registradas) {
        const archivo = archivosDeHoy.find((a) => a.clave === r.clave)!;
        for (const [id, serie] of Object.entries(leer(r.contenido, r.url.split("/").pop()!, archivo))) {
          if (id in series) throw new ErrorParseo(`La serie ${id} aparece en más de un archivo de la corrida`);
          series = { ...series, [id]: serie };
        }
      }
    } catch (error) {
      if (!(error instanceof ErrorParseo)) throw error;
      const mensaje = `No se pudo leer lo descargado: ${error.message}`;
      await d.base.cerrarCorrida(corrida, "fallida", mensaje);
      return { estado: "fallida", corrida, error: mensaje };
    }

    try {
      const cargado = await d.base.cargarCandidato(corrida, d.hoy, cargaDe(series, registradas.map((r) => r.clave)));
      return {
        estado: cargado.estado as Resultado["estado"], corrida,
        ...(cargado.candidato_id !== undefined ? { candidato_id: Number(cargado.candidato_id), hallazgos: Number(cargado.hallazgos) } : {}),
      };
    } catch (error) {
      if (!(error instanceof ErrorNegocio && error.codigo === "carga_invalida")) throw error;
      const mensaje = `La base rechazó lo leído: ${error.message}`;
      await d.base.cerrarCorrida(corrida, "fallida", mensaje);
      return { estado: "fallida", corrida, error: mensaje };
    }
  } catch (error) {
    // Un fallo inesperado no puede dejar la corrida en curso: bloquearía la fuente hasta el vencimiento.
    const mensaje = `${(error as Error).name}: ${(error as Error).message}`;
    await d.base.cerrarCorrida(corrida, "fallida", mensaje).catch(() => false);
    throw error;
  }
}

export { ErrorHttp };
