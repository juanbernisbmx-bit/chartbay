// Los avisos de punta a punta contra una base real y un Slack y un Discord locales. La maneja `servicio_datos/tests/test_funciones_supabase.py`,
// que deja un candidato abierto, prepara el esquema y el rol de las Edge Functions, y después revisa la bandeja de la base.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { baseAvisosPostgres } from "../_compartido/base.ts";
import { CanalDiscord } from "../_compartido/discord.ts";
import { CanalSlack } from "../_compartido/slack.ts";
import { avisar } from "./avisos.ts";

const URL_BASE = Deno.env.get("DATOS_AVISAR_URL");
const ESQUEMA = Deno.env.get("DATOS_AVISAR_ESQUEMA");

Deno.test({
  name: "avisos con la base: el candidato abierto llega a Slack y a Discord una sola vez",
  ignore: !(URL_BASE && ESQUEMA),
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Los dos canales a la vez, cada uno con su servidor local.
    const recibidos: string[] = [], deDiscord: { content: string; allowed_mentions: unknown }[] = [];
    const slack = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (pedido) => {
      recibidos.push((await pedido.json()).text);
      return new Response("ok");
    });
    const discord = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (pedido) => {
      deDiscord.push(await pedido.json());
      return new Response(null, { status: 204 });
    });
    const base = baseAvisosPostgres(URL_BASE!, ESQUEMA!);
    const canales = [
      new CanalSlack(`http://127.0.0.1:${slack.addr.port}/services/x`, { hosts: ["127.0.0.1"], esquemas: ["http:"] }),
      new CanalDiscord(`http://127.0.0.1:${discord.addr.port}/api/webhooks/1/token-de-prueba-abcdefghijk`, { hosts: ["127.0.0.1"], esquemas: ["http:"] }),
    ];
    const configuracion = { canales, urlRevision: "https://chartbay.example/base-de-datos/revision", recordatorioDias: 3 };
    try {
      const primera = await avisar(base, configuracion, "2026-10-06");
      assertEquals([primera.creados, primera.enviados, primera.errores], [1, 1, []]);
      const segunda = await avisar(base, configuracion, "2026-10-06");
      assertEquals([segunda.creados, segunda.enviados], [0, 0]);
      assertEquals([recibidos.length, deDiscord.length], [1, 1]);
      assertStringIncludes(recibidos[0], "para revisar (INDEC_IPC)*");
      assertStringIncludes(recibidos[0], "|Abrir en ChartBay>");
      assertStringIncludes(deDiscord[0].content, "para revisar (INDEC\\_IPC)**");
      assertStringIncludes(deDiscord[0].content, "[Abrir en ChartBay](https://chartbay.example/base-de-datos/revision#candidato=");
      assertEquals(deDiscord[0].allowed_mentions, { parse: [] });
    } finally {
      await base.cerrar();
      await slack.shutdown();
      await discord.shutdown();
    }
  },
});
