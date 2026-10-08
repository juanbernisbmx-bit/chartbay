// El canal de Slack (webhook entrante): la traducción de `CanalSlack` de `servicio_datos/canales.py`, con las mismas reglas.
// - La URL del webhook es una credencial: no sale nunca en un error, un log ni un mensaje.
// - Lo que va en un aviso viene de la base (errores de descarga, nombres de fuente) y no es de confianza: se escapa para que no
//   pueda armar enlaces ni menciones (`<!channel>`).

/** No se pudo entregar. El mensaje no contiene secretos. */
export class ErrorEnvio extends Error {
  override name = "ErrorEnvio";
}

export interface Mensaje {
  asunto: string;
  cuerpo: string;
  enlace: string | null;
}

export interface Canal {
  nombre: string;
  enviar(mensaje: Mensaje): Promise<void>;
}

/** Slack interpreta &, < y >: sin escaparlos, un texto podría armar un enlace o un @channel. */
export const escaparSlack = (texto: string) => texto.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const unaLinea = (texto: string) => texto.replace(/\s+/g, " ").trim();

export class CanalSlack implements Canal {
  readonly nombre = "slack";
  readonly #url: string;
  readonly #timeoutMs: number;

  constructor(url: string, opciones: { hosts?: string[]; esquemas?: string[]; timeoutMs?: number } = {}) {
    const { hosts = ["hooks.slack.com"], esquemas = ["https:"], timeoutMs = 10_000 } = opciones;
    let partes: URL | null = null;
    try {
      partes = new URL(url);
    } catch { /* se informa abajo, sin repetir la URL */ }
    if (!partes || !esquemas.includes(partes.protocol) || !hosts.includes(partes.hostname)) {
      throw new Error("La URL del webhook de Slack tiene que ser https://hooks.slack.com/...");
    }
    this.#url = url;
    this.#timeoutMs = timeoutMs;
  }

  async enviar(mensaje: Mensaje): Promise<void> {
    let texto = `*${escaparSlack(unaLinea(mensaje.asunto))}*\n${escaparSlack(mensaje.cuerpo)}`;
    if (mensaje.enlace) texto += `\n<${mensaje.enlace}|Abrir en ChartBay>`;
    let respuesta: Response;
    try {
      respuesta = await fetch(this.#url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: texto.slice(0, 3500) }),
        redirect: "manual", signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      // Solo el tipo: el texto del error puede traer la URL.
      throw new ErrorEnvio(`No se pudo conectar con Slack (${(error as Error).name})`);
    }
    await respuesta.body?.cancel();
    if (respuesta.status >= 300 && respuesta.status < 400) throw new ErrorEnvio("Slack respondió con una redirección, que no se sigue");
    if (respuesta.status !== 200) throw new ErrorEnvio(`Slack respondió HTTP ${respuesta.status}`);
  }
}
