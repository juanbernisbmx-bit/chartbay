// Lo único de la guía que sobrevive a recargar la página: el modo.
//
// El modo es una preferencia sobre cuánto quiere que le hablen, no un hecho
// del análisis: si no persiste, cada F5 vuelve a poner al estudiante bajo una
// tutela que ya había decidido apagar.
//
// El recorrido y el registro de decisiones NO se guardan a propósito. Son de
// la sesión: restaurarlos mostraría pasos "completados" sobre un dataset que
// ya no está cargado, que es exactamente la clase de desalineación que la
// invalidación por paso existe para evitar.

import type { GuidedMode } from './types';

const MODE_KEY = 'chartbay.guided.mode';

/**
 * Todo acceso va envuelto: en navegación privada, con cookies bloqueadas o
 * con la cuota llena, localStorage existe pero tira al leer o al escribir. Una
 * preferencia no puede tumbar la app.
 */
export function loadStoredMode(): GuidedMode | null {
  try {
    const raw = window.localStorage.getItem(MODE_KEY);
    return raw === 'free' || raw === 'guided' || raw === 'practice' ? raw : null;
  } catch {
    return null;
  }
}

export function storeMode(mode: GuidedMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Se pierde la preferencia hasta la próxima carga. Nada más.
  }
}

/** Solo para tests. */
export function clearStoredMode(): void {
  try {
    window.localStorage.removeItem(MODE_KEY);
  } catch {
    // Ídem.
  }
}
