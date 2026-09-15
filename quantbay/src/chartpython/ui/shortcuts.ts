/**
 * Atajos con los dos modos de Jupyter: en modo edición se escribe dentro de la
 * celda y en modo comando las teclas sueltas operan sobre el notebook. Son
 * funciones puras sobre la tecla para poder probarlas sin DOM; las secuencias
 * de dos teclas (`dd`, `00`) se resuelven con el parámetro `pendiente`.
 */
export type Accion =
  | 'ejecutar' | 'ejecutar-y-seguir' | 'ejecutar-e-insertar'
  | 'insertar-arriba' | 'insertar-abajo' | 'borrar' | 'deshacer-borrado'
  | 'a-codigo' | 'a-markdown' | 'subir' | 'bajar'
  | 'anterior' | 'siguiente' | 'editar' | 'comando'
  | 'guardar' | 'reiniciar' | 'interrumpir';

export interface Pulsacion {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

const conModificador = (tecla: Pulsacion): boolean => Boolean(tecla.ctrlKey || tecla.metaKey || tecla.altKey);

/** Las tres formas de ejecutar de Jupyter valen en los dos modos. */
export function accionDeEjecucion(tecla: Pulsacion): Accion | null {
  if (tecla.key !== 'Enter') return null;
  if (tecla.altKey) return 'ejecutar-e-insertar';
  if (tecla.ctrlKey || tecla.metaKey) return 'ejecutar';
  if (tecla.shiftKey) return 'ejecutar-y-seguir';
  return null;
}

export function accionDeEdicion(tecla: Pulsacion): Accion | null {
  const ejecucion = accionDeEjecucion(tecla);
  if (ejecucion) return ejecucion;
  if (tecla.key === 'Escape') return 'comando';
  if (tecla.key.toLowerCase() === 's' && (tecla.ctrlKey || tecla.metaKey)) return 'guardar';
  return null;
}

export function accionDeComando(tecla: Pulsacion, pendiente = ''): { accion: Accion | null; pendiente: string } {
  const ejecucion = accionDeEjecucion(tecla);
  if (ejecucion) return { accion: ejecucion, pendiente: '' };
  if (tecla.key.toLowerCase() === 's' && (tecla.ctrlKey || tecla.metaKey)) return { accion: 'guardar', pendiente: '' };
  if (conModificador(tecla)) return { accion: null, pendiente: '' };

  const key = tecla.key;
  if (pendiente === 'd' && key === 'd') return { accion: 'borrar', pendiente: '' };
  if (pendiente === '0' && key === '0') return { accion: 'reiniciar', pendiente: '' };
  if (pendiente === 'i' && key === 'i') return { accion: 'interrumpir', pendiente: '' };
  if (key === 'd' || key === '0' || key === 'i') return { accion: null, pendiente: key };

  const simples: Record<string, Accion> = {
    a: 'insertar-arriba',
    b: 'insertar-abajo',
    z: 'deshacer-borrado',
    y: 'a-codigo',
    m: 'a-markdown',
    Enter: 'editar',
    ArrowUp: 'anterior',
    ArrowDown: 'siguiente',
    k: 'anterior',
    j: 'siguiente',
  };
  const conMayus: Record<string, Accion> = { ArrowUp: 'subir', ArrowDown: 'bajar' };
  if (tecla.shiftKey && conMayus[key]) return { accion: conMayus[key], pendiente: '' };
  const accion = simples[key] ?? simples[key.toLowerCase()] ?? null;
  return { accion, pendiente: '' };
}
