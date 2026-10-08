// El canal de Discord (webhook de un canal privado). Las reglas de `canales.ts`, con lo propio de Discord:
// - El texto va en `content` (hasta 2000 caracteres) y `allowed_mentions` vacío: nadie puede ser mencionado, diga lo que diga.
// - Lo que viene de la base se escapa: no puede armar enlaces con formato (`[texto](url)`), menciones, encabezados ni bloques, y a
//   las direcciones se les rompe el `://` para que Discord no las convierta en enlaces. El único enlace es el de la revisión.
// - Sin vista previa de enlaces (SUPPRESS_EMBEDS): el aviso es el texto, nada más.
import { type Canal, enviarAlWebhook, ErrorEnvio, type Mensaje, unaLinea } from "./canales.ts";

export const LIMITE_DISCORD = 2000;
const SIN_VISTA_PREVIA = 1 << 2; // SUPPRESS_EMBEDS
const RUTA = /^\/api(\/v\d+)?\/webhooks\/\d{1,25}\/[A-Za-z0-9_-]{20,}$/;

/** Que un texto de la base se lea tal cual en Discord: sin formato, sin enlaces armados y sin menciones. */
export function escaparDiscord(texto: string): string {
  return texto
    .replace(/[\\*_~`|<>[\]@]/g, (c) => `\\${c}`) // con los corchetes escapados no se arma un [texto](url)
    .replace(/:\/\//g, "\\://")
    .replace(/^(\s*)([#>+-])/gm, "$1\\$2") // encabezados, citas y listas
    .replace(/^(\s*)(\d+)\./gm, "$1$2\\."); // listas numeradas: Discord escapa signos, no dígitos
}

export class CanalDiscord implements Canal {
  readonly nombre = "discord";
  readonly #url: string;
  readonly #timeoutMs: number;

  constructor(url: string, opciones: { hosts?: string[]; esquemas?: string[]; timeoutMs?: number } = {}) {
    const { hosts = ["discord.com", "discordapp.com"], esquemas = ["https:"], timeoutMs = 10_000 } = opciones;
    let partes: URL | null = null;
    try {
      partes = new URL(url);
    } catch { /* se informa abajo, sin repetir la URL */ }
    if (!partes || !esquemas.includes(partes.protocol) || !hosts.includes(partes.hostname) || !RUTA.test(partes.pathname) ||
        partes.search || partes.hash || partes.username || partes.password) {
      throw new Error("La URL del webhook de Discord tiene que ser https://discord.com/api/webhooks/<id>/<token>, sin nada más");
    }
    this.#url = url;
    this.#timeoutMs = timeoutMs;
  }

  async enviar(mensaje: Mensaje): Promise<void> {
    const titulo = `**${escaparDiscord(unaLinea(mensaje.asunto))}**`;
    const enlace = mensaje.enlace ? `\n[Abrir en ChartBay](${mensaje.enlace.replaceAll(" ", "%20").replaceAll(")", "%29")})` : "";
    let cuerpo = escaparDiscord(mensaje.cuerpo);
    const lugar = LIMITE_DISCORD - titulo.length - enlace.length - 1;
    if (cuerpo.length > lugar) {
      // Se corta el cuerpo y no el enlace; sin dejar una barra suelta que escaparía lo que sigue.
      cuerpo = cuerpo.slice(0, Math.max(0, lugar - 1)).replace(/\\+$/, (barras) => (barras.length % 2 ? barras.slice(0, -1) : barras)) + "…";
    }
    const contenido = `${titulo}\n${cuerpo}${enlace}`.slice(0, LIMITE_DISCORD);
    const respuesta = await enviarAlWebhook("Discord", this.#url, { content: contenido, allowed_mentions: { parse: [] }, flags: SIN_VISTA_PREVIA },
                                            this.#timeoutMs);
    if (respuesta.status !== 204 && respuesta.status !== 200) throw new ErrorEnvio(`Discord respondió HTTP ${respuesta.status}`);
  }
}
