// Quién puede disparar una función programada: quien manda en el encabezado `x-chartbay-clave` la clave `DATOS_CLAVE_CRON`
// (la tiene pg_cron, en Vault). La clave pública de Supabase la tiene cualquiera, así que no alcanza: las funciones se
// despliegan con `--no-verify-jwt` y se protegen con esto.
export const ENCABEZADO = "x-chartbay-clave";

/** Compara sin cortar en la primera diferencia, para que el tiempo de respuesta no vaya revelando la clave. */
export function iguales(a: string, b: string): boolean {
  const [x, y] = [new TextEncoder().encode(a), new TextEncoder().encode(b)];
  let diferencia = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diferencia |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diferencia === 0;
}

/** Sin clave configurada no autoriza a nadie. */
export function autorizado(pedido: Request, clave: string | undefined): boolean {
  return Boolean(clave) && iguales(pedido.headers.get(ENCABEZADO) ?? "", clave!);
}

export const responder = (cuerpo: unknown, estado = 200) =>
  new Response(JSON.stringify(cuerpo), { status: estado, headers: { "Content-Type": "application/json" } });
