import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { ErrorEnvio } from "./canales.ts";
import { CanalDiscord, escaparDiscord, LIMITE_DISCORD } from "./discord.ts";

type Recibido = { ruta: string; tipo: string | null; cuerpo: { content: string; allowed_mentions: unknown; flags: number } };
const TOKEN = "token-secreto-del-webhook-abcdefghij";

async function conDiscord(manejador: () => Response, prueba: (url: string, recibidos: Recibido[]) => Promise<void>) {
  const recibidos: Recibido[] = [];
  const servidor = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (pedido) => {
    recibidos.push({ ruta: new URL(pedido.url).pathname, tipo: pedido.headers.get("content-type"), cuerpo: await pedido.json() });
    return manejador();
  });
  try {
    await prueba(`http://127.0.0.1:${servidor.addr.port}/api/webhooks/123456789012345678/${TOKEN}`, recibidos);
  } finally {
    await servidor.shutdown();
  }
}

const local = (url: string) => new CanalDiscord(url, { hosts: ["127.0.0.1"], esquemas: ["http:"] });
const listo = () => new Response(null, { status: 204 }); // lo que contesta Discord a un webhook

Deno.test("manda el asunto en negrita, el cuerpo y el enlace propio, sin menciones ni vista previa", async () => {
  await conDiscord(listo, async (url, recibidos) => {
    await local(url).enviar({ asunto: "Candidato 3\npara  revisar", cuerpo: "Respecto de lo publicado: 42 períodos nuevos.", enlace: "https://chartbay.example/r#candidato=3" });
    assertEquals(recibidos[0].tipo, "application/json");
    assertEquals(recibidos[0].cuerpo, {
      content: "**Candidato 3 para revisar**\nRespecto de lo publicado: 42 períodos nuevos.\n[Abrir en ChartBay](https://chartbay.example/r#candidato=3)",
      allowed_mentions: { parse: [] }, flags: 4,
    });
  });
});

Deno.test("lo que viene de la base no puede mencionar, armar enlaces ni dar formato", async () => {
  const hostil = "@everyone <@123> <#456> [clic](https://malo.example) **negrita** `código` ||spoiler|| ~tachado~ _it_\n# Título\n> cita\n- lista\n2. otra";
  await conDiscord(listo, async (url, recibidos) => {
    await local(url).enviar({ asunto: "Falló la corrida [x](https://malo.example)", cuerpo: hostil, enlace: null });
    const contenido = recibidos[0].cuerpo.content;
    assertEquals(recibidos[0].cuerpo.allowed_mentions, { parse: [] });
    assert(!/(^|[^\\])\[[^\]]*\]\(/.test(contenido), contenido); // ningún [texto](url) sin escapar
    assert(!/(^|[^\\])https?:\/\//.test(contenido), contenido); // ninguna dirección que Discord convierta en enlace
    assert(!/(^|[^\\])[@<]/.test(contenido), contenido);
    for (const marca of ["\\@everyone", "\\<\\@123\\>", "\\*\\*negrita\\*\\*", "\\`código\\`", "\\|\\|spoiler\\|\\|", "\\~tachado\\~", "\\_it\\_",
                         "\n\\# Título", "\n\\> cita", "\n\\- lista", "\n2\\. otra", "https\\://malo.example"]) {
      assert(contenido.includes(marca), `${marca} en ${contenido}`);
    }
    assert(contenido.startsWith("**Falló la corrida \\[x\\](https\\://malo.example)**"), contenido);
  });
});

Deno.test("un texto largo se corta en el cuerpo: entra en el límite y el enlace queda entero", async () => {
  await conDiscord(listo, async (url, recibidos) => {
    const enlace = "https://chartbay.example/r#corrida=9";
    await local(url).enviar({ asunto: "a", cuerpo: "*".repeat(5000), enlace }); // cada * se escapa: el doble de largo
    const contenido = recibidos[0].cuerpo.content;
    assert(contenido.length <= LIMITE_DISCORD, String(contenido.length));
    assert(contenido.endsWith(`…\n[Abrir en ChartBay](${enlace})`), contenido.slice(-80));
    assert(!/(^|[^\\])(\\\\)*\\…/.test(contenido), "una barra suelta escaparía el corte");
  });
});

Deno.test("200 o 204 es entregado; un error, un límite o una redirección es una entrega fallida, sin la URL", async () => {
  await conDiscord(() => new Response("{}", { status: 200 }), async (url) => {
    await local(url).enviar({ asunto: "a", cuerpo: "b", enlace: null });
  });
  for (const estado of [400, 401, 404, 429, 500]) {
    await conDiscord(() => new Response("no", { status: estado }), async (url) => {
      const error = await assertRejects(() => local(url).enviar({ asunto: "a", cuerpo: "b", enlace: null }), ErrorEnvio, `Discord respondió HTTP ${estado}`);
      assert(!error.message.includes(TOKEN));
    });
  }
  await conDiscord(() => new Response(null, { status: 302, headers: { Location: "https://otro.example/" } }), async (url, recibidos) => {
    await assertRejects(() => local(url).enviar({ asunto: "a", cuerpo: "b", enlace: null }), ErrorEnvio, "redirección, que no se sigue");
    assertEquals(recibidos.length, 1);
  });
  const servidor = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, () => new Response(null, { status: 204 }));
  const cerrado = `http://127.0.0.1:${servidor.addr.port}/api/webhooks/1/${TOKEN}`;
  await servidor.shutdown();
  const error = await assertRejects(() => local(cerrado).enviar({ asunto: "a", cuerpo: "b", enlace: null }), ErrorEnvio, "No se pudo conectar con Discord");
  assert(!error.message.includes(TOKEN));
});

Deno.test("solo acepta webhooks de Discord, y no repite la URL al rechazarla", () => {
  for (const url of [`http://discord.com/api/webhooks/1/${TOKEN}`, `https://otro.example/api/webhooks/1/${TOKEN}`, "https://discord.com/api/webhooks/1/corto",
                     `https://discord.com/api/webhooks/1/${TOKEN}?wait=true`, `https://discord.com/api/webhooks/1/${TOKEN}/slack`,
                     `https://usuario:${TOKEN}@discord.com/api/webhooks/1/${TOKEN}`, `https://hooks.slack.com/services/${TOKEN}`, `no es una url ${TOKEN}`]) {
    const error = assertThrows(() => new CanalDiscord(url), Error, "tiene que ser https://discord.com/api/webhooks/");
    assert(!error.message.includes(TOKEN), url);
  }
  for (const url of [`https://discord.com/api/webhooks/123456789012345678/${TOKEN}`, `https://discordapp.com/api/webhooks/1/${TOKEN}`,
                     `https://discord.com/api/v10/webhooks/1/${TOKEN}`]) {
    assertEquals(new CanalDiscord(url).nombre, "discord");
  }
});

Deno.test("escapar deja leer el texto tal cual", () => {
  assertEquals(escaparDiscord("ipc_ng_nacional varió 25.00% en 2026-03"), "ipc\\_ng\\_nacional varió 25.00% en 2026-03");
  assertEquals(escaparDiscord("1. uno\n  - dos\n#tres"), "1\\. uno\n  \\- dos\n\\#tres");
  assertEquals(escaparDiscord("a \\ b"), "a \\\\ b");
});
