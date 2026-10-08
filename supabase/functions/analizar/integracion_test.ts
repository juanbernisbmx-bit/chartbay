// El analista de punta a punta contra una base real, con un modelo falso (no hay clave de la API en las pruebas). La maneja
// `servicio_datos/tests/test_funciones_supabase.py`, que deja un candidato con hallazgos, prepara el esquema y el rol de las Edge
// Functions, y después revisa las propuestas que quedaron.
import { assertEquals } from "jsr:@std/assert@1";
import { baseAnalistaPostgres } from "../_compartido/base.ts";
import { analizar } from "./analista.ts";
import type { Modelo } from "./modelo.ts";

const URL_BASE = Deno.env.get("DATOS_ANALIZAR_URL");
const ESQUEMA = Deno.env.get("DATOS_ANALIZAR_ESQUEMA");

Deno.test({
  name: "analista con la base: cada hallazgo queda con una propuesta validada, una sola vez",
  ignore: !(URL_BASE && ESQUEMA),
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const vistos: unknown[] = [];
    const modelo: Modelo = {
      nombre: "claude-de-prueba",
      async dictaminar(pedido) {
        vistos.push(pedido);
        // Cita el primer hecho y uno que no existe, con más confianza de la que corresponde: el validador tiene que bajarla.
        return await Promise.resolve({ clasificacion: "cambio_de_base", accion_sugerida: "investigar", confianza: "alta", hechos_citados: [1, 42],
                                       razonamiento: "La serie no arranca en 100 en dic 2016." });
      },
    };
    const base = baseAnalistaPostgres(URL_BASE!, ESQUEMA!);
    try {
      const primera = await analizar(base, modelo, { limiteMs: 60_000, concurrencia: 3 });
      assertEquals([primera.por_modelo, primera.fallidos, primera.sin_tiempo, vistos.length], [7, 0, 0, 7]);
      const segunda = await analizar(base, modelo, { limiteMs: 60_000 });
      assertEquals([segunda.por_modelo, vistos.length], [0, 7]);
    } finally {
      await base.cerrar();
    }
  },
});
