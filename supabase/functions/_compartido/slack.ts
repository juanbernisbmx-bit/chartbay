// El canal de Slack (webhook entrante): la traducción de `CanalSlack` de `servicio_datos/canales.py`, con las mismas reglas (ver
// `canales.ts`). Slack arma enlaces y menciones con `<...>`: escapando &, < y > no se puede.
import { type Canal, enviarAlWebhook, ErrorEnvio, type Mensaje, unaLinea } from "./canales.ts";

export { type Canal, ErrorEnvio, type Mensaje } from "./canales.ts";

/** Slack interpreta &, < y >: sin escaparlos, un texto podría armar un enlace o un @channel. */
export const escaparSlack = (texto: string) => texto.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

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
    const respuesta = await enviarAlWebhook("Slack", this.#url, { text: texto.slice(0, 3500) }, this.#timeoutMs);
    if (respuesta.status !== 200) throw new ErrorEnvio(`Slack respondió HTTP ${respuesta.status}`);
  }
}
