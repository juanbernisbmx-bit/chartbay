// El analista: para cada hallazgo sin decidir de los candidatos abiertos, deja una propuesta fundada en hechos. Traduce
// `servicio_datos/agente/analista.py`; elegir los hallazgos, los precedentes, los hechos, el validador y el guardado son
// funciones de la base (migración 0015). Lo único que escribe es `propuesta`: la decisión sigue siendo de una persona.
//
// 1. Lo que tiene un precedente (una persona ya decidió sobre un hallazgo idéntico) se propone sin consultar al modelo.
// 2. El resto va al modelo, de a unos pocos a la vez, y lo que contesta se le entrega a la base, que lo valida y lo guarda.
//
// Es seguro correrlo muchas veces: lo que ya tiene propuesta no vuelve, y lo que no llegó a analizarse (por tiempo o porque la
// API falló) queda para la próxima. Si la API falla varias veces seguidas, corta en vez de gastar el tiempo en cada hallazgo.
import type { BaseAnalista, ParaElModelo } from "../_compartido/base.ts";
import { type Modelo, ModeloNoDisponible } from "./modelo.ts";

export const MAX_FALLOS_SEGUIDOS = 3;

export interface Resultado {
  por_precedente: number; // repiten lo que una persona decidió antes sobre algo idéntico
  por_modelo: number; // salieron del modelo y pasaron el validador con hechos citados
  sin_respaldo: number; // el modelo contestó, pero nada que los hechos sostengan: quedan "requiere revisión humana"
  omitidos: number; // ya tenían propuesta, una persona decidió mientras tanto o el candidato se cerró
  fallidos: number; // la API no contestó: se reintentan en la próxima corrida
  sin_tiempo: number; // quedaron para la próxima porque se acabó el tiempo
  sin_modelo?: number; // no hay modelo configurado: solo se propone por precedente
  abortado?: string;
}

export interface Opciones {
  limiteMs: number; // tiempo para consultar al modelo; la Edge Function tiene un tope de duración
  concurrencia?: number;
  maxHallazgos?: number;
  reloj?: () => number;
}

export async function analizar(base: BaseAnalista, modelo: Modelo | null, opciones: Opciones): Promise<Resultado> {
  const reloj = opciones.reloj ?? Date.now;
  const inicio = reloj();
  const resultado: Resultado = { por_precedente: 0, por_modelo: 0, sin_respaldo: 0, omitidos: 0, fallidos: 0, sin_tiempo: 0 };
  resultado.por_precedente = await base.proponerPorPrecedentes();
  const pendientes = await base.hallazgosParaElModelo(opciones.maxHallazgos ?? 50);
  if (modelo === null) return { ...resultado, sin_modelo: pendientes.length };

  let siguiente = 0, fallosSeguidos = 0;
  const uno = async (h: ParaElModelo) => {
    let respuesta: unknown;
    try {
      respuesta = await modelo.dictaminar(h.pedido);
      fallosSeguidos = 0;
    } catch (error) {
      if (!(error instanceof ModeloNoDisponible)) throw error;
      resultado.fallidos++;
      if (++fallosSeguidos >= MAX_FALLOS_SEGUIDOS && !resultado.abortado) {
        resultado.abortado = `${error.message}; se corta tras ${fallosSeguidos} fallos seguidos.`;
      }
      return;
    }
    const guardada = await base.proponer(h.hallazgo_id, respuesta, modelo.nombre, h.hechos);
    if (guardada === "por_modelo") resultado.por_modelo++;
    else if (guardada === "sin_respaldo") resultado.sin_respaldo++;
    else resultado.omitidos++;
  };
  const trabajador = async () => {
    while (siguiente < pendientes.length && !resultado.abortado) {
      if (reloj() - inicio >= opciones.limiteMs) return;
      await uno(pendientes[siguiente++]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opciones.concurrencia ?? 3) }, trabajador));
  resultado.sin_tiempo = resultado.abortado ? 0 : pendientes.length - siguiente;
  return resultado;
}
