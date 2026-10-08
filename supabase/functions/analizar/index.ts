// Edge Function `analizar`: la llama pg_cron cada hora (ver docs/base-datos-supabase.md, paso 6). Para cada hallazgo sin decidir
// de los candidatos abiertos deja una propuesta del analista (Claude), validada por la base contra los hechos. Solo propone.
//
// Secretos que necesita (`supabase secrets set --env-file ...`, compartidos con las otras funciones):
//   DATOS_CLAVE_CRON           lo que tiene que mandar quien la llama, en el encabezado `x-chartbay-clave`
//   DATOS_DATABASE_URL         la base, con el rol `servicio_datos` (ver `servicio_datos/api_servicio.py`)
//   ANTHROPIC_API_KEY          la clave de la API de Claude. Sin ella solo se proponen los precedentes
//   DATOS_ANALISTA_MODELO      opcional: el modelo (por defecto, claude-opus-5-5)
//   DATOS_MONITOR_ANALIZAR_URL opcional: el latido de Healthchecks de esta función
import { autorizado, responder } from "../_compartido/autorizacion.ts";
import { baseAnalistaPostgres } from "../_compartido/base.ts";
import { latir } from "../_compartido/latido.ts";
import { analizar } from "./analista.ts";
import { modeloClaude } from "./modelo.ts";

// La función tiene 150 s en el plan gratuito. Pasados LIMITE_MS no se empieza ningún hallazgo más, y la consulta en curso tiene
// hasta ESPERA_MS (sin reintento: lo que falle queda para la próxima hora). 90 + 30 deja margen para guardar y responder.
const LIMITE_MS = 90_000;
const ESPERA_MS = 30_000;

Deno.serve(async (pedido) => {
  if (pedido.method !== "POST") return responder({ error: "Usar POST" }, 405);
  if (!autorizado(pedido, Deno.env.get("DATOS_CLAVE_CRON"))) return responder({ error: "No autorizado" }, 401);
  const urlBase = Deno.env.get("DATOS_DATABASE_URL");
  if (!urlBase) return responder({ error: "Falta configurar DATOS_DATABASE_URL" }, 500);
  const monitor = Deno.env.get("DATOS_MONITOR_ANALIZAR_URL");
  const clave = Deno.env.get("ANTHROPIC_API_KEY");
  const modelo = clave ? modeloClaude({ apiKey: clave, modelo: Deno.env.get("DATOS_ANALISTA_MODELO")?.trim(), timeoutMs: ESPERA_MS, maxRetries: 0 }) : null;

  const base = baseAnalistaPostgres(urlBase);
  try {
    const resultado = await analizar(base, modelo, { limiteMs: LIMITE_MS, concurrencia: 3 });
    const falla = resultado.fallidos > 0;
    const avisoMonitor = await latir(monitor, `Analista: ${JSON.stringify(resultado)}`, falla);
    return responder({ ...resultado, ...(modelo ? { modelo: modelo.nombre } : {}), ...(avisoMonitor ? { monitor: avisoMonitor } : {}) }, falla ? 500 : 200);
  } catch (error) {
    const mensaje = `${(error as Error).name}: ${(error as Error).message}`;
    console.error("Analista roto:", mensaje);
    await latir(monitor, `Analista roto: ${mensaje}`, true);
    return responder({ error: mensaje }, 500);
  } finally {
    await base.cerrar();
  }
});
