// Lo que comparten los canales de aviso (Slack, Discord). Dos reglas para todos:
// - La URL del webhook es una credencial: no sale nunca en un error, un log ni un mensaje.
// - Lo que va en un aviso viene de la base (errores de descarga, nombres de fuente) y no es de confianza: cada canal lo escapa
//   para que no pueda armar enlaces ni menciones.

/** No se pudo entregar. El mensaje no contiene secretos. */
export class ErrorEnvio extends Error {
  override name = "ErrorEnvio";
}

export interface Mensaje {
  asunto: string;
  cuerpo: string;
  enlace: string | null; // armado por la función con la dirección de la revisión, no por la base: es de confianza
}

export interface Canal {
  nombre: string; // el nombre con el que se anota cada entrega (`aviso.entregas`)
  enviar(mensaje: Mensaje): Promise<void>;
}

export const unaLinea = (texto: string) => texto.replace(/\s+/g, " ").trim();

/** Manda el pedido sin seguir redirecciones y traduce cualquier falla a un ErrorEnvio que no repite la URL. */
export async function enviarAlWebhook(servicio: string, url: string, cuerpo: unknown, timeoutMs: number): Promise<Response> {
  let respuesta: Response;
  try {
    respuesta = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo),
      redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Solo el tipo: el texto del error puede traer la URL.
    throw new ErrorEnvio(`No se pudo conectar con ${servicio} (${(error as Error).name})`);
  }
  await respuesta.body?.cancel();
  if (respuesta.status >= 300 && respuesta.status < 400) throw new ErrorEnvio(`${servicio} respondió con una redirección, que no se sigue`);
  return respuesta;
}
