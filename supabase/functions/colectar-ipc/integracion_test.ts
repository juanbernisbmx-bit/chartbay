// La colecta de punta a punta contra una base real, con los .xls reales de INDEC servidos por un HTTP falso y un Storage en
// memoria. La maneja `servicio_datos/tests/test_funciones_supabase.py`, que prepara el esquema y después revisa la base.
import { assertEquals } from "jsr:@std/assert@1";
import { basePostgres } from "../_compartido/base.ts";
import type { Respuesta } from "../_compartido/http.ts";
import { colectarIpc } from "./colecta.ts";

const URL_BASE = Deno.env.get("DATOS_COLECTA_URL");
const ESQUEMA = Deno.env.get("DATOS_COLECTA_ESQUEMA");
const ORIGINALES = Deno.env.get("DATOS_IPC_ORIGINALES_DIR");

Deno.test({
  name: "colecta con los archivos reales: la primera deja un candidato y la segunda no cambia nada",
  ignore: !(URL_BASE && ESQUEMA && ORIGINALES),
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const base = basePostgres(URL_BASE!, { searchPath: `${ESQUEMA}, public` });
    const guardados = new Map<string, Uint8Array>();
    const http = {
      async get(url: string): Promise<Respuesta> {
        const nombre = url.split("/").pop()!;
        if (nombre === "sh_ipc_10_26.xls") return { estado: 200, contenido: new TextEncoder().encode("<html>no existe</html>"), tipo: "text/html", lastModified: null };
        return { estado: 200, contenido: Deno.readFileSync(`${ORIGINALES}/${nombre}`), tipo: "application/vnd.ms-excel", lastModified: new Date("2026-09-10T18:52:05Z") };
      },
    };
    const dependencias = { base, almacen: { async guardar(ruta: string, contenido: Uint8Array) { guardados.set(ruta, contenido); } }, http, hoy: "2026-10-06" };
    try {
      const primera = await colectarIpc(dependencias);
      assertEquals(primera.estado, "con_candidato");
      assertEquals(guardados.size, 2);
      const segunda = await colectarIpc(dependencias);
      assertEquals(segunda.estado, "sin_cambios");
    } finally {
      await base.cerrar();
    }
  },
});
