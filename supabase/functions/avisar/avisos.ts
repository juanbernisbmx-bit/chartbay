// Los avisos: detectar lo que haya en la base, entregar los pendientes por cada canal y anotar cómo fue. Traduce `procesar` y
// `entregar` de `servicio_datos/avisos.py`; detectar, comprobar que un aviso siga siendo cierto y anotar las entregas son
// funciones de la base (migración 0014), las mismas que usa Python.
import type { AvisoTomado, BaseAvisos, Entrega } from "../_compartido/base.ts";
import { type Canal, ErrorEnvio } from "../_compartido/canales.ts";
import { CanalDiscord } from "../_compartido/discord.ts";
import { CanalSlack } from "../_compartido/slack.ts";

export const RESERVA_SEGUNDOS = 300; // cuánto queda reservado un aviso tomado, por si esta función se cae a mitad de camino

export interface Configuracion {
  canales: Canal[];
  urlRevision: string | null; // la página de revisión de ChartBay, para los enlaces
  recordatorioDias: number; // días hasta el primer recordatorio de un candidato abierto; 0 los apaga
}

export interface Resultado {
  creados: number;
  enviados: number;
  descartados: number;
  fallidos: number; // se agotaron los intentos
  pendientes: number; // siguen esperando un reintento
  ocupado: boolean; // otra entrega tenía avisos reservados
  errores: string[]; // por canal, sin secretos
  sin_canales?: true;
}

/** Los canales que estén configurados; sin ninguno, no se avisa (ni se acumulan avisos). Los errores no repiten secretos. */
export function configuracionDesdeEntorno(env: Record<string, string | undefined>): Configuracion {
  const canales: Canal[] = [];
  if (env.DATOS_AVISOS_SLACK_URL) canales.push(new CanalSlack(env.DATOS_AVISOS_SLACK_URL));
  if (env.DATOS_AVISOS_DISCORD_URL) canales.push(new CanalDiscord(env.DATOS_AVISOS_DISCORD_URL));
  const url = (env.DATOS_REVISION_URL ?? "").trim().replace(/\/+$/, "") || null;
  if (url && !/^https?:\/\//.test(url)) throw new Error("DATOS_REVISION_URL tiene que empezar con https:// (o http:// en una prueba local)");
  const texto = (env.DATOS_AVISOS_RECORDATORIO_DIAS ?? "3").trim();
  if (!/^\d+$/.test(texto) || Number(texto) > 60) {
    throw new Error("DATOS_AVISOS_RECORDATORIO_DIAS tiene que ser un número de días entre 0 (sin recordatorios) y 60");
  }
  return { canales, urlRevision: url, recordatorioDias: Number(texto) };
}

/** La ruta que guarda el aviso (`/candidatos/3`, `/corridas/12`, `/`) como enlace a la página de revisión de ChartBay. */
export function enlace(urlRevision: string | null, ruta: string | null): string | null {
  if (!urlRevision || !ruta) return null;
  const partes = /^\/(candidatos|corridas)\/(\d+)$/.exec(ruta);
  return partes ? `${urlRevision}#${partes[1] === "candidatos" ? "candidato" : "corrida"}=${partes[2]}` : urlRevision;
}

async function entregarUno(aviso: AvisoTomado, canales: Canal[], urlRevision: string | null, errores: string[]) {
  const mensaje = { asunto: aviso.asunto, cuerpo: aviso.cuerpo, enlace: enlace(urlRevision, aviso.ruta) };
  const entregas: Record<string, Entrega> = { ...aviso.entregas };
  let completo = true;
  for (const canal of canales) {
    if (entregas[canal.nombre]?.ok) continue; // ya llegó por este canal en un intento anterior
    try {
      await canal.enviar(mensaje);
      entregas[canal.nombre] = { ok: true, en: new Date().toISOString() };
    } catch (error) {
      // Un canal roto no frena a los demás. De un error inesperado, solo el tipo: su texto podría traer un secreto.
      const texto = error instanceof ErrorEnvio ? error.message : `Falló la entrega (${(error as Error)?.name ?? "Error"})`;
      entregas[canal.nombre] = { ok: false, error: texto };
      errores.push(`${canal.nombre}: ${texto}`);
      completo = false;
    }
  }
  return { entregas, completo };
}

export const PRUEBA = { asunto: "Prueba de avisos de ChartBay", cuerpo: "Si ves este mensaje, el canal funciona. No hay que hacer nada." };

/** Manda un mensaje de prueba por cada canal, con el enlace a la revisión, sin tocar la base: para comprobar un canal o el enlace
 * cuando no hay ningún aviso nuevo. Devuelve, por canal, "ok" o el error (sin secretos). */
export async function probarCanales(configuracion: Configuracion): Promise<Record<string, string>> {
  const resultado: Record<string, string> = {};
  for (const canal of configuracion.canales) {
    try {
      await canal.enviar({ ...PRUEBA, enlace: configuracion.urlRevision });
      resultado[canal.nombre] = "ok";
    } catch (error) {
      resultado[canal.nombre] = error instanceof ErrorEnvio ? error.message : `Falló la entrega (${(error as Error)?.name ?? "Error"})`;
    }
  }
  return resultado;
}

/** Detecta y entrega. Sin canales no hace nada, ni siquiera detecta: si no, al configurar uno se mandaría de golpe lo acumulado. */
export async function avisar(base: BaseAvisos, configuracion: Configuracion, hoy: string): Promise<Resultado> {
  const resultado: Resultado = { creados: 0, enviados: 0, descartados: 0, fallidos: 0, pendientes: 0, ocupado: false, errores: [] };
  if (configuracion.canales.length === 0) return { ...resultado, sin_canales: true };
  resultado.creados = await base.detectar(hoy, configuracion.recordatorioDias);
  const tomados = await base.tomar(hoy, RESERVA_SEGUNDOS);
  resultado.descartados = tomados.descartados;
  resultado.ocupado = tomados.en_curso > 0;
  for (const aviso of tomados.avisos) {
    const { entregas, completo } = await entregarUno(aviso, configuracion.canales, configuracion.urlRevision, resultado.errores);
    const estado = await base.registrarEntrega(aviso.id, entregas, completo);
    if (estado === "enviado") resultado.enviados++;
    else if (estado === "fallido") resultado.fallidos++;
    else if (estado === "pendiente") resultado.pendientes++;
  }
  return resultado;
}
