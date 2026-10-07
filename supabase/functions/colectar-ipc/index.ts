// Edge Function `colectar-ipc`: la llama pg_cron dos veces por día (ver docs/base-datos-supabase.md, paso 3).
//
// Secretos que necesita (`supabase secrets set ...`):
//   COLECTA_CLAVE         lo que tiene que mandar quien la llama, en el encabezado `x-chartbay-clave`. Sin eso no hace nada:
//                         la clave pública de Supabase la tiene cualquiera, así que no alcanza para disparar una colecta.
//   DATOS_DATABASE_URL    la base, con el rol `datos_escritura` (no el administrador)
//   DATOS_MONITOR_URL     opcional: la dirección de latido del monitor externo (Healthchecks)
// y usa los que Supabase pone solo: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (para el bucket privado `crudo`).
import { almacenSupabase } from "../_compartido/almacen.ts";
import { basePostgres } from "../_compartido/base.ts";
import { hoyEnArgentina } from "../_compartido/fechas.ts";
import { ClienteHttp } from "../_compartido/http.ts";
import { latir } from "../_compartido/latido.ts";
import { colectarIpc } from "./colecta.ts";

function iguales(a: string, b: string): boolean {
  const [x, y] = [new TextEncoder().encode(a), new TextEncoder().encode(b)];
  let diferencia = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diferencia |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diferencia === 0;
}

const responder = (cuerpo: unknown, estado = 200) =>
  new Response(JSON.stringify(cuerpo), { status: estado, headers: { "Content-Type": "application/json" } });

Deno.serve(async (pedido) => {
  if (pedido.method !== "POST") return responder({ error: "Usar POST" }, 405);
  const clave = Deno.env.get("COLECTA_CLAVE");
  if (!clave || !iguales(pedido.headers.get("x-chartbay-clave") ?? "", clave)) return responder({ error: "No autorizado" }, 401);
  const urlBase = Deno.env.get("DATOS_DATABASE_URL"), urlSupabase = Deno.env.get("SUPABASE_URL"), claveServicio = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!urlBase || !urlSupabase || !claveServicio) return responder({ error: "Falta configurar DATOS_DATABASE_URL o las variables de Supabase" }, 500);

  const base = basePostgres(urlBase);
  try {
    const resultado = await colectarIpc({ base, almacen: almacenSupabase(urlSupabase, claveServicio), http: new ClienteHttp(), hoy: hoyEnArgentina() });
    const falla = resultado.estado === "fallida";
    const avisoMonitor = await latir(Deno.env.get("DATOS_MONITOR_URL"), `Colecta del IPC: ${JSON.stringify(resultado)}`, falla);
    return responder({ ...resultado, ...(avisoMonitor ? { monitor: avisoMonitor } : {}) }, falla ? 500 : 200);
  } catch (error) {
    const mensaje = `${(error as Error).name}: ${(error as Error).message}`;
    console.error("Colecta del IPC rota:", mensaje);
    await latir(Deno.env.get("DATOS_MONITOR_URL"), `Colecta del IPC rota: ${mensaje}`, true);
    return responder({ estado: "fallida", error: mensaje }, 500);
  } finally {
    await base.cerrar();
  }
});
