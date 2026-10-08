import { assertEquals } from "jsr:@std/assert@1";
import { autorizado, ENCABEZADO, iguales } from "./autorizacion.ts";

const pedido = (clave?: string) => new Request("http://x/", { method: "POST", headers: clave === undefined ? {} : { [ENCABEZADO]: clave } });

Deno.test("solo pasa quien manda la clave exacta, y sin clave configurada no pasa nadie", () => {
  assertEquals(autorizado(pedido("larga-y-al-azar"), "larga-y-al-azar"), true);
  assertEquals(autorizado(pedido("larga-y-al-aza"), "larga-y-al-azar"), false);
  assertEquals(autorizado(pedido("larga-y-al-azarX"), "larga-y-al-azar"), false);
  assertEquals(autorizado(pedido(), "larga-y-al-azar"), false);
  assertEquals(autorizado(pedido(""), ""), false);
  assertEquals(autorizado(pedido("algo"), undefined), false);
  assertEquals([iguales("ñandú", "ñandú"), iguales("ñandú", "nandu")], [true, false]);
});
