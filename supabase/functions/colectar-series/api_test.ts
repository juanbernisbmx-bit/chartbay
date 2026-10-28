import { capture, parseExact } from "./api.ts";

function assert(
  condition: unknown,
  message = "No se cumplió la condición",
): asserts condition {
  if (!condition) throw new Error(message);
}
async function rejects(work: Promise<unknown>) {
  let failed = false;
  try {
    await work;
  } catch {
    failed = true;
  }
  assert(failed, "La captura incompatible debería fallar");
}
function response(data: string, count = 1, id = "test"): Response {
  return new Response(
    `{"data":${data},"count":${count},"params":{"ids":"${id}"},"meta":[{"frequency":"month"},{"field":{"id":"${id}","units":"Índice","representation_mode":"value"}}]}`,
  );
}

Deno.test("conserva tokens decimales y ceros sin convertir a double", async () => {
  const parsed = parseExact(
    '{"data":[["2026-01-01",1.000000000000000001]],"count":1,"params":{"ids":"test"}}',
  );
  assert(parsed.data[0][1] === "1.000000000000000001");
  const data = await capture(
    "test",
    (() =>
      Promise.resolve(
        response(
          '[["2026-01-01",1.000000000000000001],["2026-03-01",0],["2026-04-01",null]]',
          3,
        ),
      )) as typeof fetch,
  );
  assert(data.points.length === 2);
  assert(
    data.points[0][1] === "1.000000000000000001" && data.points[1][1] === "0",
  );
  assert(new TextDecoder().decode(data.raw).includes("1.000000000000000001"));
});

Deno.test("rechaza identidad, períodos duplicados y paginación incompleta", async () => {
  await rejects(
    capture(
      "test",
      (() =>
        Promise.resolve(
          response('[["2026-01-01",1]]', 1, "otra"),
        )) as typeof fetch,
    ),
  );
  await rejects(
    capture(
      "test",
      (() =>
        Promise.resolve(
          response('[["2026-01-01",1],["2026-01-01",2]]', 2),
        )) as typeof fetch,
    ),
  );
  let calls = 0;
  await rejects(
    capture(
      "test",
      (() =>
        Promise.resolve(
          ++calls === 1 ? response('[["2026-01-01",1]]', 2) : response("[]", 2),
        )) as typeof fetch,
    ),
  );
  await rejects(
    capture(
      "test",
      (() =>
        Promise.resolve(response('[["2026-01-01",null]]'))) as typeof fetch,
    ),
  );
});

Deno.test("paginar no pierde históricos ni acepta cambios de conteo entre páginas", async () => {
  const dates = (start: number, length: number) =>
    Array.from({ length }, (_, i) => {
      const year = 1900 + Math.floor((start + i) / 12),
        month = (start + i) % 12 + 1;
      return [`${year}-${String(month).padStart(2, "0")}-01`, i];
    });
  const starts: string[] = [];
  const data = await capture(
    "test",
    ((url: string) => {
      const start = new URL(url).searchParams.get("start")!;
      starts.push(start);
      return Promise.resolve(
        response(
          JSON.stringify(start === "0" ? dates(0, 1000) : dates(1000, 1)),
          1001,
        ),
      );
    }) as typeof fetch,
  );
  assert(data.points.length === 1001 && starts.join(",") === "0,1000");
});

Deno.test("rechaza cambios de frecuencia o unidad declarada", async () => {
  await rejects(
    capture(
      "test",
      (() => Promise.resolve(response('[["2026-01-01",1]]'))) as typeof fetch,
      "Pesos",
    ),
  );
  await rejects(capture(
    "test",
    (async () => {
      const original = response('[["2026-01-01",1]]');
      return new Response(
        (await original.text()).replace('"month"', '"quarter"'),
      );
    }) as typeof fetch,
  ));
});
