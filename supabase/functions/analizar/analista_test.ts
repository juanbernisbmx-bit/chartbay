import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { BaseAnalista, Guardada, Hecho, ParaElModelo } from "../_compartido/base.ts";
import { analizar, MAX_FALLOS_SEGUIDOS } from "./analista.ts";
import { type Modelo, ModeloNoDisponible } from "./modelo.ts";

function hallazgo(id: number): ParaElModelo {
  const hechos: Hecho[] = [{ id: 1, texto: `Hecho del hallazgo ${id}`, etiquetas: ["valor"] }];
  return { hallazgo_id: id, candidato_id: 7, pedido: { hallazgo: { regla: "salto_mensual" }, hechos: [{ id: 1, texto: `Hecho del hallazgo ${id}` }] }, hechos };
}

class BaseFalsa implements BaseAnalista {
  propuestas: { hallazgo: number; respuesta: unknown; modelo: string; hechos: Hecho[] }[] = [];
  pedidos: number[] = [];
  constructor(readonly pendientes: ParaElModelo[], readonly precedentes = 0, readonly guardar: (h: number) => Guardada = () => "por_modelo") {}
  async proponerPorPrecedentes() {
    return await Promise.resolve(this.precedentes);
  }
  async hallazgosParaElModelo(limite: number) {
    this.pedidos.push(limite);
    return await Promise.resolve(this.pendientes);
  }
  async proponer(hallazgo: number, respuesta: unknown, modelo: string, hechos: Hecho[]) {
    this.propuestas.push({ hallazgo, respuesta, modelo, hechos });
    return await Promise.resolve(this.guardar(hallazgo));
  }
  async cerrar() {}
}

class ModeloFalso implements Modelo {
  readonly nombre = "claude-falso";
  pedidos: unknown[] = [];
  constructor(readonly responder: (pedido: unknown, n: number) => unknown = () => ({ clasificacion: "dato_real" })) {}
  async dictaminar(pedido: unknown) {
    this.pedidos.push(pedido);
    const respuesta = this.responder(pedido, this.pedidos.length);
    if (respuesta instanceof Error) throw respuesta;
    return await Promise.resolve(respuesta);
  }
}

Deno.test("primero los precedentes; después cada hallazgo al modelo, y lo que dice va a la base con los hechos que vio", async () => {
  const base = new BaseFalsa([hallazgo(1), hallazgo(2)], 3, (h) => (h === 1 ? "por_modelo" : "sin_respaldo"));
  const modelo = new ModeloFalso((pedido) => ({ eco: pedido }));
  const resultado = await analizar(base, modelo, { limiteMs: 60_000, maxHallazgos: 20 });
  assertEquals(base.pedidos, [20]);
  assertEquals(modelo.pedidos, [hallazgo(1).pedido, hallazgo(2).pedido]);
  assertEquals(base.propuestas.map((p) => [p.hallazgo, p.modelo, p.respuesta, p.hechos]),
    [[1, "claude-falso", { eco: hallazgo(1).pedido }, hallazgo(1).hechos], [2, "claude-falso", { eco: hallazgo(2).pedido }, hallazgo(2).hechos]]);
  assertEquals(resultado, { por_precedente: 3, por_modelo: 1, sin_respaldo: 1, omitidos: 0, fallidos: 0, sin_tiempo: 0 });
});

Deno.test("una respuesta inservible también va a la base, que la deja para una persona", async () => {
  const base = new BaseFalsa([hallazgo(1)], 0, () => "sin_respaldo");
  const resultado = await analizar(base, new ModeloFalso(() => null), { limiteMs: 60_000 });
  assertEquals([base.propuestas[0].respuesta, resultado.sin_respaldo], [null, 1]);
});

Deno.test("sin modelo solo propone por precedente y dice cuántos quedaron", async () => {
  const base = new BaseFalsa([hallazgo(1), hallazgo(2)], 1);
  assertEquals(await analizar(base, null, { limiteMs: 60_000 }),
    { por_precedente: 1, por_modelo: 0, sin_respaldo: 0, omitidos: 0, fallidos: 0, sin_tiempo: 0, sin_modelo: 2 });
  assertEquals(base.propuestas, []);
});

Deno.test("si la API falla no guarda nada de ese hallazgo, y tras varios fallos seguidos corta", async () => {
  const base = new BaseFalsa([1, 2, 3, 4, 5, 6].map(hallazgo));
  const modelo = new ModeloFalso((_, n) => (n === 1 ? { clasificacion: "dato_real" } : new ModeloNoDisponible("La API de Claude falló (InternalServerError, HTTP 500)")));
  const resultado = await analizar(base, modelo, { limiteMs: 60_000, concurrencia: 1 });
  assertEquals([resultado.por_modelo, resultado.fallidos, base.propuestas.length, modelo.pedidos.length], [1, MAX_FALLOS_SEGUIDOS, 1, 1 + MAX_FALLOS_SEGUIDOS]);
  assertEquals(resultado.abortado, `La API de Claude falló (InternalServerError, HTTP 500); se corta tras ${MAX_FALLOS_SEGUIDOS} fallos seguidos.`);
});

Deno.test("un fallo suelto no corta", async () => {
  const base = new BaseFalsa([1, 2, 3].map(hallazgo));
  const resultado = await analizar(base, new ModeloFalso((_, n) => (n === 2 ? new ModeloNoDisponible("x") : {})), { limiteMs: 60_000, concurrencia: 1 });
  assertEquals([resultado.por_modelo, resultado.fallidos, resultado.abortado], [2, 1, undefined]);
});

Deno.test("pasado el límite no empieza ninguno más y dice cuántos quedaron para la próxima", async () => {
  let ahora = 0;
  const base = new BaseFalsa([1, 2, 3, 4].map(hallazgo));
  const modelo = new ModeloFalso(() => {
    ahora += 40;
    return {};
  });
  const resultado = await analizar(base, modelo, { limiteMs: 100, concurrencia: 1, reloj: () => ahora });
  assertEquals([resultado.por_modelo, resultado.sin_tiempo], [3, 1]);
});

Deno.test("varios a la vez, sin repetir ninguno", async () => {
  const base = new BaseFalsa([1, 2, 3, 4, 5, 6, 7].map(hallazgo));
  const resultado = await analizar(base, new ModeloFalso(), { limiteMs: 60_000, concurrencia: 3 });
  assertEquals(base.propuestas.map((p) => p.hallazgo).sort(), [1, 2, 3, 4, 5, 6, 7]);
  assertEquals(resultado.por_modelo, 7);
});

Deno.test("lo que no guardó porque ya tenía propuesta o se decidió cuenta como omitido; un error que no es de la API se propaga", async () => {
  const base = new BaseFalsa([hallazgo(1)], 0, () => "omitido");
  assertEquals((await analizar(base, new ModeloFalso(), { limiteMs: 60_000 })).omitidos, 1);
  await assertRejects(() => analizar(new BaseFalsa([hallazgo(1)]), new ModeloFalso(() => new TypeError("bug")), { limiteMs: 60_000 }), TypeError, "bug");
});
