import postgres from "npm:postgres@3.4.5";
import { autorizado, responder } from "../_compartido/autorizacion.ts";
import { almacenSupabase, sha256Hex } from "../_compartido/almacen.ts";
import { capture, type Job } from "./api.ts";

Deno.serve(async (request) => {
  if (request.method !== "POST") return responder({ error: "Usar POST" }, 405);
  if (!autorizado(request, Deno.env.get("DATOS_CLAVE_CRON"))) {
    return responder({ error: "No autorizado" }, 401);
  }
  const db = Deno.env.get("DATOS_DATABASE_URL"),
    url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("DATOS_CLAVE_SERVIDOR") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!db || !url || !key) {
    return responder({ error: "Falta configuración del servicio" }, 500);
  }
  const sql = postgres(db, {
    prepare: false,
    max: 1,
    connect_timeout: 10,
    idle_timeout: 2,
    onnotice: () => {},
  });
  const store = almacenSupabase(url, key);
  const results: unknown[] = [];
  try {
    const [row] = await sql`select servicio_series.tomar(2) as plan`;
    const plan = row.plan as { bloqueada?: string; trabajos: Job[] };
    if (plan.bloqueada) {
      return responder({ estado: "bloqueada", motivo: plan.bloqueada }, 503);
    }
    // Dos trabajos por invocación; cada uno admite hasta cinco páginas de 10 s.
    // El cron se ejecuta cada dos minutos: capacidad de 1.440 consultas/día.
    for (const job of plan.trabajos) {
      try {
        const data = await capture(job.upstream_id, fetch, job.unit);
        const hash = await sha256Hex(data.raw);
        const path = `series-api/${hash}.json`;
        await store.guardar(path, data.raw, "application/json");
        const provenance = {
          upstream_id: job.upstream_id,
          sha256: hash,
          bytes: data.raw.length,
          ruta: path,
          url: data.url,
        };
        const [result] =
          await sql`select servicio_series.cargar(${job.id},${job.token}::uuid,${
            sql.json(data.points)
          },${sql.json(provenance)}) as resultado`;
        await sql`select servicio_series.terminar(${job.id},${job.token}::uuid)`;
        results.push({ id: job.id, ...result.resultado });
      } catch (reason) {
        console.error("Fallo de serie", job.id, (reason as Error).message);
        await sql`select servicio_series.terminar(${job.id},${job.token}::uuid,${
          (reason as Error).message.slice(0, 500)
        })`;
        results.push({ id: job.id, estado: "fallida" });
      }
    }
    return responder({ resultados: results });
  } catch {
    return responder({
      error: "No se pudo ejecutar el lote; las reservas vencen automáticamente",
    }, 500);
  } finally {
    await sql.end({ timeout: 2 });
  }
});
