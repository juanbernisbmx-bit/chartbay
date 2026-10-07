import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { ClienteHttp, ErrorHttp } from "./http.ts";

type Manejador = (pedido: Request) => Response | Promise<Response>;

async function conServidor(manejador: Manejador, prueba: (base: string, pedidos: string[]) => Promise<void>) {
  const pedidos: string[] = [];
  const servidor = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (pedido) => {
    pedidos.push(new URL(pedido.url).pathname);
    return manejador(pedido);
  });
  try {
    await prueba(`http://127.0.0.1:${servidor.addr.port}`, pedidos);
  } finally {
    await servidor.shutdown();
  }
}

const cliente = (opciones = {}) => new ClienteHttp({ hosts: ["127.0.0.1"], esquemas: ["http"], dormir: async () => {}, ...opciones });

Deno.test("baja el contenido y la fecha que declara el servidor", async () => {
  await conServidor(() => new Response("hola", { headers: { "Last-Modified": "Thu, 10 Sep 2026 18:52:05 GMT", "Content-Type": "text/plain" } }), async (base) => {
    const respuesta = await cliente().get(`${base}/x.xls`);
    assertEquals([respuesta.estado, new TextDecoder().decode(respuesta.contenido), respuesta.tipo], [200, "hola", "text/plain"]);
    assertEquals(respuesta.lastModified?.toISOString(), "2026-09-10T18:52:05.000Z");
  });
});

Deno.test("un 404 vuelve como respuesta y no se reintenta", async () => {
  await conServidor(() => new Response("no", { status: 404 }), async (base, pedidos) => {
    assertEquals((await cliente().get(`${base}/x`)).estado, 404);
    assertEquals(pedidos.length, 1);
  });
});

Deno.test("un error del servidor se reintenta y uno del pedido no", async () => {
  let vez = 0;
  await conServidor(() => (++vez < 3 ? new Response("boom", { status: 503 }) : new Response("ok")), async (base, pedidos) => {
    assertEquals((await cliente().get(`${base}/x`)).estado, 200);
    assertEquals(pedidos.length, 3);
  });
  await conServidor(() => new Response("prohibido", { status: 403 }), async (base, pedidos) => {
    await assertRejects(() => cliente().get(`${base}/x`), ErrorHttp, "respondió HTTP 403");
    assertEquals(pedidos.length, 1);
  });
  await conServidor(() => new Response("boom", { status: 500 }), async (base) => {
    await assertRejects(() => cliente().get(`${base}/x`), ErrorHttp, "tras 3 intentos (HTTP 500)");
  });
});

Deno.test("solo los hosts y esquemas permitidos, también al redirigir", async () => {
  await assertRejects(() => new ClienteHttp().get("http://www.indec.gob.ar/x.xls"), ErrorHttp, "URL no permitida");
  await assertRejects(() => new ClienteHttp().get("https://otro.example/x.xls"), ErrorHttp, "URL no permitida");
  await conServidor((pedido) => new URL(pedido.url).pathname === "/a"
    ? new Response(null, { status: 302, headers: { Location: "/b" } }) : new Response("destino"), async (base, pedidos) => {
    assertEquals(new TextDecoder().decode((await cliente().get(`${base}/a`)).contenido), "destino");
    assertEquals(pedidos, ["/a", "/b"]);
  });
  await conServidor(() => new Response(null, { status: 302, headers: { Location: "https://otro.example/x" } }), async (base) => {
    await assertRejects(() => cliente().get(`${base}/a`), ErrorHttp, "Redirección rechazada");
  });
});

Deno.test("una respuesta más grande que el tope se rechaza", async () => {
  await conServidor(() => new Response("x".repeat(2000)), async (base) => {
    await assertRejects(() => cliente({ maxBytes: 1000 }).get(`${base}/x`), ErrorHttp, "supera 1000 bytes");
  });
});
