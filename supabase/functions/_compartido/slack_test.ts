import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { ErrorEnvio } from "./canales.ts";
import { CanalSlack } from "./slack.ts";

type Recibido = { tipo: string | null; cuerpo: { text: string } };

async function conSlack(manejador: () => Response, prueba: (url: string, recibidos: Recibido[]) => Promise<void>) {
  const recibidos: Recibido[] = [];
  const servidor = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (pedido) => {
    recibidos.push({ tipo: pedido.headers.get("content-type"), cuerpo: await pedido.json() });
    return manejador();
  });
  try {
    await prueba(`http://127.0.0.1:${servidor.addr.port}/services/T000/B000/secreto-del-webhook`, recibidos);
  } finally {
    await servidor.shutdown();
  }
}

const local = (url: string) => new CanalSlack(url, { hosts: ["127.0.0.1"], esquemas: ["http:"] });

Deno.test("manda el asunto, el cuerpo escapado y el enlace propio", async () => {
  await conSlack(() => new Response("ok"), async (url, recibidos) => {
    await local(url).enviar({ asunto: "Falló\nla corrida  3", cuerpo: "<!channel> boom & <https://malo.example|clic>", enlace: "https://chartbay.example/r#corrida=3" });
    assertEquals(recibidos[0].tipo, "application/json");
    assertEquals(recibidos[0].cuerpo.text,
      "*Falló la corrida 3*\n&lt;!channel&gt; boom &amp; &lt;https://malo.example|clic&gt;\n<https://chartbay.example/r#corrida=3|Abrir en ChartBay>");
  });
});

Deno.test("sin enlace no agrega la línea y un texto largo se corta", async () => {
  await conSlack(() => new Response("ok"), async (url, recibidos) => {
    await local(url).enviar({ asunto: "a", cuerpo: "x".repeat(5000), enlace: null });
    assertEquals(recibidos[0].cuerpo.text.length, 3500);
    assert(!recibidos[0].cuerpo.text.includes("Abrir"));
  });
});

Deno.test("un error de Slack o de la red se informa sin la URL, que es una credencial", async () => {
  await conSlack(() => new Response("no", { status: 500 }), async (url) => {
    const error = await assertRejects(() => local(url).enviar({ asunto: "a", cuerpo: "b", enlace: null }), ErrorEnvio, "Slack respondió HTTP 500");
    assert(!error.message.includes("secreto"));
  });
  await conSlack(() => new Response(null, { status: 302, headers: { Location: "https://otro.example/" } }), async (url, recibidos) => {
    await assertRejects(() => local(url).enviar({ asunto: "a", cuerpo: "b", enlace: null }), ErrorEnvio, "redirección, que no se sigue");
    assertEquals(recibidos.length, 1);
  });
  const servidor = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, () => new Response("ok"));
  const cerrado = `http://127.0.0.1:${servidor.addr.port}/services/secreto-del-webhook`;
  await servidor.shutdown();
  const error = await assertRejects(() => local(cerrado).enviar({ asunto: "a", cuerpo: "b", enlace: null }), ErrorEnvio, "No se pudo conectar con Slack");
  assert(!error.message.includes("secreto"));
});

Deno.test("solo acepta webhooks de Slack por https, y no repite la URL al rechazarla", () => {
  for (const url of ["http://hooks.slack.com/services/secreto", "https://otro.example/services/secreto", "no es una url secreto"]) {
    const error = assertThrows(() => new CanalSlack(url), Error, "tiene que ser https://hooks.slack.com/");
    assert(!error.message.includes("secreto"));
  }
  new CanalSlack("https://hooks.slack.com/services/T000/B000/xyz");
});
