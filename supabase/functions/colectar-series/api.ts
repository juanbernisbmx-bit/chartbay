// Lectura acotada de la API oficial, sin redondear los tokens numéricos del JSON.
export interface Job {
  id: string;
  upstream_id: string;
  token: string;
  unit?: string;
}
export interface Capture {
  points: string[][];
  raw: Uint8Array;
  url: string;
}
type Payload = {
  data: Array<[string, string | null]>;
  count: string;
  params: { ids: string };
  meta?: Array<
    {
      frequency?: string;
      field?: { id?: string; units?: string; representation_mode?: string };
    }
  >;
};

export function parseExact(text: string): Payload {
  // El contexto de JSON.parse conserva el token original, antes de convertirlo a double.
  const parse = JSON.parse as unknown as (
    text: string,
    reviver: (
      key: string,
      value: unknown,
      context: { source?: string },
    ) => unknown,
  ) => Payload;
  return parse(text, (_key, value, context) => {
    if (typeof value !== "number") return value;
    if (!context?.source) {
      throw new Error("El runtime no permite conservar decimales del JSON");
    }
    return context.source;
  });
}

export async function capture(
  upstream: string,
  get: typeof fetch = fetch,
  expectedUnit?: string,
): Promise<Capture> {
  if (!/^[A-Za-z0-9_.-]+$/.test(upstream)) {
    throw new Error("Identificador no válido");
  }
  let offset = 0, total = -1;
  const points: string[][] = [], pages: unknown[] = [];
  let previous = "";
  let firstUrl = "";
  do {
    const params = new URLSearchParams({
      ids: upstream,
      format: "json",
      metadata: "simple",
      limit: "1000",
      start: String(offset),
      sort: "asc",
    });
    const url = `https://apis.datos.gob.ar/series/api/series/?${params}`;
    if (!firstUrl) firstUrl = url;
    const response = await get(url, {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`API oficial: HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Respuesta vacía");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 500000) {
          throw new Error("La página excede el límite de descarga");
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const body = new Uint8Array(bytes);
    let position = 0;
    for (const chunk of chunks) {
      body.set(chunk, position);
      position += chunk.length;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const payload = parseExact(text);
    const count = Number(payload.count);
    if (
      !Array.isArray(payload.data) || !Number.isInteger(count) || count < 1 ||
      count > 5000 || payload.params?.ids !== upstream ||
      payload.meta?.[0]?.frequency !== "month" ||
      payload.meta?.[1]?.field?.id !== upstream ||
      payload.meta?.[1]?.field?.representation_mode !== "value" ||
      (expectedUnit && payload.meta?.[1]?.field?.units !== expectedUnit) ||
      (total >= 0 && total !== count)
    ) {
      throw new Error("Respuesta incompleta o identidad incompatible");
    }
    total = count;
    if (!payload.data.length || offset + payload.data.length > total) {
      throw new Error("Paginación incompleta");
    }
    for (const row of payload.data) {
      if (
        !Array.isArray(row) || row.length !== 2 ||
        !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(row[0]) || row[0] <= previous
      ) {
        throw new Error("Los períodos no son mensuales, únicos y ordenados");
      }
      previous = row[0];
      if (row[1] !== null) {
        if (
          typeof row[1] !== "string" ||
          !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(row[1])
        ) throw new Error("Valor inválido");
        points.push([row[0], row[1]]);
      }
    }
    // Guardar el JSON original de cada página como texto conserva sus decimales.
    pages.push({ url, body: text });
    offset += payload.data.length;
  } while (offset < total);
  if (!points.length) throw new Error("La serie no tiene valores disponibles");
  const raw = new TextEncoder().encode(
    JSON.stringify({ upstream_id: upstream, pages }),
  );
  if (raw.length > 1048576) {
    throw new Error("La captura excede el límite de archivo");
  }
  return { points, raw, url: firstUrl };
}
