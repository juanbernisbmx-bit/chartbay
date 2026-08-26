// localStorage para los tests de preferencias de la guía.
//
// El jsdom de este proyecto no expone window.localStorage: leerlo tira
// TypeError. Eso no es un problema del código —persistence.ts envuelve cada
// acceso justamente porque en navegación privada o con la cuota llena pasa lo
// mismo— pero sí impide observar que la preferencia se guardó.
//
// Se inyecta uno de memoria para los tests que verifican la persistencia, y
// uno que tira para los que verifican que la guía sigue funcionando sin ella.

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function install(storage: FakeStorage): void {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
}

/** Almacenamiento que funciona. Se vacía en cada llamada. */
export function useMemoryStorage(): void {
  const data = new Map<string, string>();
  install({
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
  });
}

/** Almacenamiento que tira en todo, como el de una ventana privada. */
export function useBrokenStorage(): void {
  const fail = (): never => { throw new DOMException('denegado', 'SecurityError'); };
  install({ getItem: fail, setItem: fail, removeItem: fail });
}
