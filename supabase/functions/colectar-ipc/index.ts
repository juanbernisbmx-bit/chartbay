// Edge Function `colectar-ipc`: la llama pg_cron dos veces por día (ver docs/base-datos-supabase.md, paso 3).
//
// Secretos que necesita (`supabase secrets set --env-file ...`, compartidos con `avisar`):
//   DATOS_CLAVE_CRON           lo que tiene que mandar quien la llama, en el encabezado `x-chartbay-clave`. Sin eso no hace
//                              nada: la clave pública de Supabase la tiene cualquiera, así que no alcanza para disparar una colecta.
//   DATOS_DATABASE_URL         la base, con el rol `servicio_datos` (solo ejecuta las funciones del esquema `servicio`; ver
//                              `servicio_datos/api_servicio.py`). Nunca la del administrador ni la `SUPABASE_DB_URL` de Supabase.
//   DATOS_MONITOR_COLECTA_URL  opcional: el latido de Healthchecks de esta función
//   DATOS_CLAVE_SERVIDOR       opcional: una clave secreta del proyecto (`sb_secret_…`) para Storage, si el proyecto apagó la
//                              vieja `service_role`. Nunca la publicable.
// y usa los que Supabase pone solo: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (para el bucket privado `economia-crudos`).
import { almacenSupabase } from "../_compartido/almacen.ts";
import { autorizado, responder } from "../_compartido/autorizacion.ts";
import { basePostgres } from "../_compartido/base.ts";
import { hoyEnArgentina } from "../_compartido/fechas.ts";
import { ClienteHttp } from "../_compartido/http.ts";
import { latir } from "../_compartido/latido.ts";
import { colectarIpc } from "./colecta.ts";

Deno.serve(async (pedido) => {
  if (pedido.method !== "POST") return responder({ error: "Usar POST" }, 405);
  if (!autorizado(pedido, Deno.env.get("DATOS_CLAVE_CRON"))) return responder({ error: "No autorizado" }, 401);
  const urlBase = Deno.env.get("DATOS_DATABASE_URL"), urlSupabase = Deno.env.get("SUPABASE_URL");
  const claveServidor = Deno.env.get("DATOS_CLAVE_SERVIDOR") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!urlBase || !urlSupabase || !claveServidor) return responder({ error: "Falta configurar DATOS_DATABASE_URL o las variables de Supabase" }, 500);

  const base = basePostgres(urlBase);
  try {
    const resultado = await colectarIpc({ base, almacen: almacenSupabase(urlSupabase, claveServidor), http: new ClienteHttp(), hoy: hoyEnArgentina() });
    const falla = resultado.estado === "fallida";
    const avisoMonitor = await latir(Deno.env.get("DATOS_MONITOR_COLECTA_URL"), `Colecta del IPC: ${JSON.stringify(resultado)}`, falla);
    return responder({ ...resultado, ...(avisoMonitor ? { monitor: avisoMonitor } : {}) }, falla ? 500 : 200);
  } catch (error) {
    const mensaje = `${(error as Error).name}: ${(error as Error).message}`;
    console.error("Colecta del IPC rota:", mensaje);
    await latir(Deno.env.get("DATOS_MONITOR_COLECTA_URL"), `Colecta del IPC rota: ${mensaje}`, true);
    return responder({ estado: "fallida", error: mensaje }, 500);
  } finally {
    await base.cerrar();
  }
});
