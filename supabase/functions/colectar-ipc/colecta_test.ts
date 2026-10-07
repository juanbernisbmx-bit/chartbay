import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { Base, Descarga } from "../_compartido/base.ts";
import { ErrorNegocio } from "../_compartido/base.ts";
import { ErrorHttp, type Respuesta } from "../_compartido/http.ts";
import { ErrorParseo, type SerieLeida } from "../_compartido/parser_ipc.ts";
import { colectarIpc, esXls } from "./colecta.ts";

const BASE_URL = "https://www.indec.gob.ar/ftp/cuadros/economia/";
const HOY = "2026-10-06";
const MODIFICADO = new Date("2026-09-10T18:52:05Z");

function xls(semilla: string): Uint8Array {
  const contenido = new Uint8Array(12_000).fill(semilla.charCodeAt(0));
  contenido.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  return contenido;
}
const pagina = () => ({ estado: 200, contenido: new TextEncoder().encode("<html>no existe</html>"), tipo: "text/html", lastModified: null });
const archivo = (semilla: string): Respuesta => ({ estado: 200, contenido: xls(semilla), tipo: "application/vnd.ms-excel", lastModified: MODIFICADO });

class BaseFalsa implements Base {
  corridas = new Map<number, { estado: string; error?: string | null; resumen: Record<string, unknown> }>();
  descargas: Descarga[] = [];
  conocidas = new Map<string, string>();
  ocupada = false;
  cargas: { corrida: number; hoy: string; carga: Record<string, unknown> }[] = [];
  respuestaCarga: Record<string, unknown> | Error = { estado: "con_candidato", candidato_id: 7, hallazgos: 3 };
  async asegurarFuente() {}
  async abrirCorrida() {
    if (this.ocupada) return null;
    const id = this.corridas.size + 1;
    this.corridas.set(id, { estado: "en_curso", resumen: {} });
    return id;
  }
  async ultimaDescarga(url: string) {
    return this.conocidas.get(url) ?? null;
  }
  async registrarDescarga(descarga: Descarga) {
    this.descargas.push(descarga);
    return this.descargas.length;
  }
  async anotarCorrida(corrida: number, resumen: Record<string, unknown>) {
    Object.assign(this.corridas.get(corrida)!.resumen, resumen);
  }
  async cerrarCorrida(corrida: number, estado: string, error: string | null = null, resumen: Record<string, unknown> | null = null) {
    const c = this.corridas.get(corrida)!;
    if (c.estado !== "en_curso") return false;
    Object.assign(c, { estado, error });
    Object.assign(c.resumen, resumen ?? {});
    return true;
  }
  async cargarCandidato(corrida: number, hoy: string, carga: Record<string, unknown>) {
    this.cargas.push({ corrida, hoy, carga });
    if (this.respuestaCarga instanceof Error) throw this.respuestaCarga;
    this.corridas.get(corrida)!.estado = String(this.respuestaCarga.estado);
    return this.respuestaCarga;
  }
  async cerrar() {}
}

function serie(id: string, clave: string): SerieLeida {
  return { serie_id: id, archivo: clave, hoja: "h", fila_origen: 5, observaciones: [["2016-12-01", "100.0"]], notas: [] };
}

type Leer = (contenido: Uint8Array, nombre: string, archivo: { clave: string }) => Record<string, SerieLeida>;
const leerFalso: Leer = (_c, _n, a) => {
  const id = a.clave === "nacional" ? "ipc_ng_nacional" : "ipc_ng_gba";
  return { [id]: serie(id, a.clave) };
};

function escenario(respuestas: Record<string, Respuesta | Error>, opciones: { leer?: Leer } = {}) {
  const base = new BaseFalsa();
  const guardados = new Map<string, Uint8Array>();
  const pedidos: string[] = [];
  const dependencias = {
    base,
    almacen: { async guardar(ruta: string, contenido: Uint8Array) { guardados.set(ruta, contenido); } },
    http: {
      async get(url: string) {
        pedidos.push(url.replace(BASE_URL, ""));
        const r = respuestas[url.replace(BASE_URL, "")];
        if (r instanceof Error) throw r;
        return r ?? pagina();
      },
    },
    hoy: HOY,
    leer: opciones.leer ?? leerFalso,
  };
  return { base, guardados, pedidos, dependencias };
}

const PUBLICADO = { "sh_ipc_09_26.xls": archivo("n"), "sh_ipc_aperturas.xls": archivo("a") };

Deno.test("con archivos nuevos guarda los originales, registra las descargas y le pasa la carga a la base", async () => {
  const { base, guardados, pedidos, dependencias } = escenario(PUBLICADO);
  const resultado = await colectarIpc(dependencias);
  assertEquals(resultado, { estado: "con_candidato", corrida: 1, candidato_id: 7, hallazgos: 3 });
  assertEquals(pedidos, ["sh_ipc_10_26.xls", "sh_ipc_09_26.xls", "sh_ipc_aperturas.xls"]); // el de octubre todavía es una página HTML
  assertEquals(base.descargas.map((d) => [d.url.replace(BASE_URL, ""), d.estado, d.bytes]), [["sh_ipc_09_26.xls", "nueva", 12_000], ["sh_ipc_aperturas.xls", "nueva", 12_000]]);
  for (const d of base.descargas) {
    assertEquals(d.rutaCrudo, `${d.sha256!.slice(0, 2)}/${d.sha256}.xls`);
    assert(guardados.has(d.rutaCrudo!));
  }
  const { carga } = base.cargas[0];
  assertEquals(carga.descargados, ["aperturas", "nacional"]);
  assertEquals((carga.series as { serie_id: string }[]).map((s) => s.serie_id), ["ipc_ng_nacional", "ipc_ng_gba"]);
  assertEquals((base.corridas.get(1)!.resumen.archivos as { publicada_en: string }[])[0].publicada_en, "2026-09-10T18:52:05+00:00");
});

Deno.test("si los dos archivos son los ya conocidos cierra sin cambios y no lee nada", async () => {
  const { base, dependencias } = escenario(PUBLICADO);
  let lecturas = 0;
  const leer = dependencias.leer;
  dependencias.leer = (c, n, a) => (lecturas++, leer(c, n, a));
  await colectarIpc(dependencias);
  for (const d of base.descargas) base.conocidas.set(d.url, d.sha256!);
  lecturas = 0;
  assertEquals((await colectarIpc(dependencias)).estado, "sin_cambios");
  assertEquals([base.corridas.get(2)!.estado, lecturas, base.cargas.length], ["sin_cambios", 0, 1]);
  assertEquals(base.descargas.slice(2).map((d) => d.estado), ["identica", "identica"]);
});

Deno.test("si ya hay una corrida en curso no hace nada", async () => {
  const { base, pedidos, dependencias } = escenario(PUBLICADO);
  base.ocupada = true;
  assertEquals((await colectarIpc(dependencias)).estado, "ocupado");
  assertEquals(pedidos, []);
});

Deno.test("un error de red en el mes nuevo no cae en silencio al anterior", async () => {
  const { base, pedidos, dependencias } = escenario({ ...PUBLICADO, "sh_ipc_10_26.xls": new ErrorHttp("No se pudo bajar tras 3 intentos (HTTP 500)") });
  const resultado = await colectarIpc(dependencias);
  assertEquals([resultado.estado, pedidos], ["fallida", ["sh_ipc_10_26.xls"]]);
  assertEquals(base.descargas.map((d) => [d.url.replace(BASE_URL, ""), d.estado]), [["sh_ipc_10_26.xls", "fallida"]]);
  assertEquals(base.corridas.get(1)!.estado, "fallida");
});

Deno.test("si ningún nombre candidato es un .xls la corrida falla y lo dice", async () => {
  const { base, dependencias } = escenario({ "sh_ipc_aperturas.xls": archivo("a") });
  const resultado = await colectarIpc(dependencias);
  assertEquals(resultado.error, "Ninguna de 3 URL candidata de «nacional» devolvió un archivo XLS");
  assertEquals(base.corridas.get(1)!.error, resultado.error);
});

Deno.test("un archivo que no se puede leer cierra la corrida como fallida, con el motivo", async () => {
  const { base, dependencias } = escenario(PUBLICADO, { leer: () => { throw new ErrorParseo("Faltan series esperadas en Índices aperturas: ipc_ng_cuyo"); } });
  const resultado = await colectarIpc(dependencias);
  assertEquals(resultado.error, "No se pudo leer lo descargado: Faltan series esperadas en Índices aperturas: ipc_ng_cuyo");
  assertEquals([base.corridas.get(1)!.estado, base.cargas.length], ["fallida", 0]);
});

Deno.test("si la base rechaza la carga la corrida falla; otro error de la base se propaga y la cierra igual", async () => {
  const uno = escenario(PUBLICADO);
  uno.base.respuestaCarga = new ErrorNegocio("carga_invalida", "Un período aparece más de una vez en una serie");
  assertEquals((await colectarIpc(uno.dependencias)).error, "La base rechazó lo leído: Un período aparece más de una vez en una serie");
  const otro = escenario(PUBLICADO);
  otro.base.respuestaCarga = new Error("se cortó la conexión");
  await assertRejects(() => colectarIpc(otro.dependencias), Error, "se cortó la conexión");
  assertEquals(otro.base.corridas.get(1)!.estado, "fallida");
  assertEquals(otro.base.corridas.get(1)!.error, "Error: se cortó la conexión");
});

Deno.test("solo un contenedor OLE2 de tamaño razonable cuenta como .xls", () => {
  assert(esXls(xls("n")));
  assert(!esXls(xls("n").slice(0, 9_000)));
  assert(!esXls(new TextEncoder().encode("<html>" + "x".repeat(20_000))));
});
