// Cliente HTTP de la colecta: solo los hosts permitidos, con reintentos y tope de tamaño. Traduce
// `servicio_datos/cliente_http.py`: un 404 vuelve como respuesta; el resto de los fallos, como ErrorHttp.
import { HOST } from "./fuente_ipc.ts";

export const USER_AGENT = "ChartBay-datos/0.2 (colector de series oficiales)";
export const MAX_BYTES = 40 * 1024 * 1024;

export class ErrorHttp extends Error {
  override name = "ErrorHttp";
}

export interface Respuesta {
  estado: number;
  contenido: Uint8Array;
  tipo: string;
  lastModified: Date | null;
}

export interface OpcionesHttp {
  hosts?: string[];
  esquemas?: string[];
  timeoutMs?: number;
  reintentos?: number;
  esperaMs?: number;
  maxBytes?: number;
  dormir?: (ms: number) => Promise<void>;
}

export class ClienteHttp {
  private readonly hosts: string[];
  private readonly esquemas: string[];
  private readonly timeoutMs: number;
  private readonly reintentos: number;
  private readonly esperaMs: number;
  private readonly maxBytes: number;
  private readonly dormir: (ms: number) => Promise<void>;

  constructor(opciones: OpcionesHttp = {}) {
    this.hosts = opciones.hosts ?? [HOST];
    this.esquemas = opciones.esquemas ?? ["https"];
    this.timeoutMs = opciones.timeoutMs ?? 30_000;
    this.reintentos = opciones.reintentos ?? 3;
    this.esperaMs = opciones.esperaMs ?? 1_000;
    this.maxBytes = opciones.maxBytes ?? MAX_BYTES;
    this.dormir = opciones.dormir ?? ((ms) => new Promise((listo) => setTimeout(listo, ms)));
  }

  validar(url: string): void {
    let partes: URL;
    try {
      partes = new URL(url);
    } catch {
      throw new ErrorHttp(`URL no permitida: ${url}`);
    }
    if (!this.esquemas.includes(partes.protocol.replace(":", "")) || !this.hosts.includes(partes.hostname)) {
      throw new ErrorHttp(`URL no permitida: ${url}`);
    }
  }

  async get(url: string): Promise<Respuesta> {
    this.validar(url);
    let ultimo = "";
    for (let intento = 0; intento < this.reintentos; intento++) {
      if (intento) await this.dormir(this.esperaMs * 2 ** (intento - 1));
      let respuesta: Response;
      try {
        respuesta = await this.pedir(url);
      } catch (error) {
        if (error instanceof ErrorHttp) throw error;
        ultimo = `${(error as Error).name}: ${(error as Error).message}`;
        continue;
      }
      if (respuesta.status === 404) {
        await respuesta.body?.cancel();
        return { estado: 404, contenido: new Uint8Array(), tipo: "", lastModified: null };
      }
      if (respuesta.status >= 400 && respuesta.status < 500) {
        await respuesta.body?.cancel();
        throw new ErrorHttp(`${url} respondió HTTP ${respuesta.status}`);
      }
      if (respuesta.status >= 500) {
        await respuesta.body?.cancel();
        ultimo = `HTTP ${respuesta.status}`;
        continue;
      }
      try {
        return { estado: respuesta.status, contenido: await this.leer(url, respuesta), tipo: respuesta.headers.get("content-type") ?? "",
                 lastModified: fecha(respuesta.headers.get("last-modified")) };
      } catch (error) {
        if (error instanceof ErrorHttp) throw error;
        ultimo = `${(error as Error).name}: ${(error as Error).message}`;
      }
    }
    throw new ErrorHttp(`No se pudo bajar ${url} tras ${this.reintentos} intentos (${ultimo})`);
  }

  // Sigue redirecciones solo hacia lo permitido: un archivo de INDEC no puede terminar viniendo de otro lado.
  private async pedir(url: string): Promise<Response> {
    let actual = url;
    for (let saltos = 0; saltos < 5; saltos++) {
      const respuesta = await fetch(actual, {
        redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "identity" },
      });
      if (respuesta.status < 300 || respuesta.status >= 400) return respuesta;
      await respuesta.body?.cancel();
      const destino = respuesta.headers.get("location");
      if (!destino) return respuesta;
      const nueva = new URL(destino, actual).toString();
      try {
        this.validar(nueva);
      } catch (error) {
        throw new ErrorHttp(`Redirección rechazada: ${(error as Error).message}`);
      }
      actual = nueva;
    }
    throw new ErrorHttp(`Demasiadas redirecciones desde ${url}`);
  }

  private async leer(url: string, respuesta: Response): Promise<Uint8Array> {
    const partes: Uint8Array[] = [];
    let total = 0;
    for await (const parte of respuesta.body ?? []) {
      total += parte.length;
      if (total > this.maxBytes) throw new ErrorHttp(`La respuesta de ${url} supera ${this.maxBytes} bytes`);
      partes.push(parte);
    }
    const todo = new Uint8Array(total);
    let desde = 0;
    for (const parte of partes) {
      todo.set(parte, desde);
      desde += parte.length;
    }
    return todo;
  }
}

function fecha(valor: string | null): Date | null {
  if (!valor) return null;
  const resultado = new Date(valor);
  return Number.isNaN(resultado.getTime()) ? null : resultado;
}
