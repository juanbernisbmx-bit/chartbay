// Edge Function `avisar`: la llama pg_cron cada hora (ver docs/base-datos-supabase.md, paso 5). Detecta lo que merece un aviso
// (un candidato para revisar, una corrida fallida, un dato que no llegó, la colecta parada...) y lo manda por Discord o Slack.
//
// Secretos que necesita (`supabase secrets set --env-file ...`, compartidos con `colectar-ipc`):
//   DATOS_CLAVE_CRON                lo que tiene que mandar quien la llama, en el encabezado `x-chartbay-clave`
//   DATOS_DATABASE_URL              la base, con el rol `servicio_datos` (ver `servicio_datos/api_servicio.py`)
//   DATOS_AVISOS_DISCORD_URL        el webhook de un canal de Discord (https://discord.com/api/webhooks/...)
//   DATOS_AVISOS_SLACK_URL          o el de Slack (https://hooks.slack.com/...). Sin ninguno no avisa ni acumula avisos
//   DATOS_REVISION_URL              la página de revisión de ChartBay, para los enlaces
//   DATOS_AVISOS_RECORDATORIO_DIAS  opcional: días hasta el primer recordatorio de un candidato abierto (3); 0 los apaga
//   DATOS_MONITOR_AVISAR_URL        opcional: el latido de Healthchecks de esta función (no el de la colecta: si fuera el
//                                   mismo, que esta ande taparía que la otra se cayó)
import { autorizado, responder } from "../_compartido/autorizacion.ts";
import { baseAvisosPostgres } from "../_compartido/base.ts";
import { hoyEnArgentina } from "../_compartido/fechas.ts";
import { latir } from "../_compartido/latido.ts";
import { avisar, type Configuracion, configuracionDesdeEntorno } from "./avisos.ts";

Deno.serve(async (pedido) => {
  if (pedido.method !== "POST") return responder({ error: "Usar POST" }, 405);
  if (!autorizado(pedido, Deno.env.get("DATOS_CLAVE_CRON"))) return responder({ error: "No autorizado" }, 401);
  const monitor = Deno.env.get("DATOS_MONITOR_AVISAR_URL");
  let configuracion: Configuracion;
  try {
    configuracion = configuracionDesdeEntorno(Deno.env.toObject());
  } catch (error) { // el mensaje no trae secretos: ver configuracionDesdeEntorno
    const mensaje = `Error de configuración: ${(error as Error).message}`;
    await latir(monitor, `Avisos: ${mensaje}`, true);
    return responder({ error: mensaje }, 500);
  }
  if (configuracion.canales.length === 0) {
    // No es un error de la función, pero nadie se entera de nada: que el monitor lo diga.
    await latir(monitor, "Avisos: no hay ningún canal configurado", true);
    return responder({ sin_canales: true });
  }
  const urlBase = Deno.env.get("DATOS_DATABASE_URL");
  if (!urlBase) return responder({ error: "Falta configurar DATOS_DATABASE_URL" }, 500);

  const base = baseAvisosPostgres(urlBase);
  try {
    const resultado = await avisar(base, configuracion, hoyEnArgentina());
    const falla = resultado.errores.length > 0 || resultado.fallidos > 0;
    const avisoMonitor = await latir(monitor, `Avisos: ${JSON.stringify(resultado)}`, falla);
    return responder({ ...resultado, ...(avisoMonitor ? { monitor: avisoMonitor } : {}) }, falla ? 500 : 200);
  } catch (error) {
    const mensaje = `${(error as Error).name}: ${(error as Error).message}`;
    console.error("Avisos rotos:", mensaje);
    await latir(monitor, `Avisos rotos: ${mensaje}`, true);
    return responder({ error: mensaje }, 500);
  } finally {
    await base.cerrar();
  }
});
