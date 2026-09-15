/**
 * El editor de las celdas es un `<textarea>`: sin dependencias nuevas, pero con
 * lo mínimo que hace usable escribir Python —sangría con Tab, sangría heredada
 * al saltar de línea y comentar con Ctrl+/—. Las funciones trabajan sobre
 * `{ text, start, end }` para poder probarlas sin navegador.
 */
export const SANGRIA = '    ';

export interface Seleccion { text: string; start: number; end: number }

function limites(s: Seleccion): { desde: number; hasta: number } {
  const desde = s.text.lastIndexOf('\n', s.start - 1) + 1;
  const fin = s.text.indexOf('\n', s.end);
  return { desde, hasta: fin === -1 ? s.text.length : fin };
}

function porLineas(s: Seleccion, cambiar: (linea: string) => string): Seleccion {
  const { desde, hasta } = limites(s);
  const original = s.text.slice(desde, hasta);
  const lineas = original.split('\n').map(cambiar);
  const nuevo = lineas.join('\n');
  const delta = nuevo.length - original.length;
  const primera = lineas[0].length - original.split('\n')[0].length;
  return {
    text: s.text.slice(0, desde) + nuevo + s.text.slice(hasta),
    start: Math.max(desde, s.start + primera),
    end: s.end + delta,
  };
}

export function indentar(s: Seleccion): Seleccion {
  if (s.start === s.end) {
    return { text: s.text.slice(0, s.start) + SANGRIA + s.text.slice(s.end), start: s.start + SANGRIA.length, end: s.start + SANGRIA.length };
  }
  return porLineas(s, linea => SANGRIA + linea);
}

export function desindentar(s: Seleccion): Seleccion {
  return porLineas(s, linea => (linea.startsWith(SANGRIA) ? linea.slice(SANGRIA.length) : linea.replace(/^\s{1,3}/, '')));
}

/** Python vive de la sangría: se hereda la de la línea y se agrega una tras `:`. */
export function nuevaLinea(s: Seleccion): Seleccion {
  const desde = s.text.lastIndexOf('\n', s.start - 1) + 1;
  const linea = s.text.slice(desde, s.start);
  const sangria = /^[ \t]*/.exec(linea)?.[0] ?? '';
  const extra = /:\s*$/.test(linea) ? SANGRIA : '';
  const insercion = '\n' + sangria + extra;
  const posicion = s.start + insercion.length;
  return { text: s.text.slice(0, s.start) + insercion + s.text.slice(s.end), start: posicion, end: posicion };
}

/** Backspace sobre la sangría borra los cuatro espacios juntos. */
export function borrarSangria(s: Seleccion): Seleccion | null {
  if (s.start !== s.end || s.start < SANGRIA.length) return null;
  const desde = s.text.lastIndexOf('\n', s.start - 1) + 1;
  const previo = s.text.slice(desde, s.start);
  if (previo.length === 0 || previo.trim() !== '' || previo.length % SANGRIA.length !== 0) return null;
  const posicion = s.start - SANGRIA.length;
  return { text: s.text.slice(0, posicion) + s.text.slice(s.start), start: posicion, end: posicion };
}

export function comentar(s: Seleccion): Seleccion {
  const { desde, hasta } = limites(s);
  const lineas = s.text.slice(desde, hasta).split('\n');
  const todasComentadas = lineas.every(linea => !linea.trim() || /^\s*#\s?/.test(linea));
  return porLineas(s, linea => {
    if (!linea.trim()) return linea;
    return todasComentadas ? linea.replace(/^(\s*)#\s?/, '$1') : linea.replace(/^(\s*)/, '$1# ');
  });
}

export function ajustarAlto(area: HTMLTextAreaElement): void {
  area.style.height = 'auto';
  area.style.height = `${area.scrollHeight + 2}px`;
}

function aplicar(area: HTMLTextAreaElement, resultado: Seleccion | null): boolean {
  if (!resultado) return false;
  area.value = resultado.text;
  area.setSelectionRange(resultado.start, resultado.end);
  ajustarAlto(area);
  return true;
}

/** Devuelve true si la tecla se usó acá y el evento no tiene que seguir. */
export function manejarTecla(area: HTMLTextAreaElement, evento: KeyboardEvent): boolean {
  const seleccion: Seleccion = { text: area.value, start: area.selectionStart, end: area.selectionEnd };
  if (evento.key === 'Tab') return aplicar(area, evento.shiftKey ? desindentar(seleccion) : indentar(seleccion));
  if (evento.key === 'Enter' && !evento.shiftKey && !evento.ctrlKey && !evento.metaKey && !evento.altKey) {
    return aplicar(area, nuevaLinea(seleccion));
  }
  if (evento.key === 'Backspace') return aplicar(area, borrarSangria(seleccion));
  if (evento.key === '/' && (evento.ctrlKey || evento.metaKey)) return aplicar(area, comentar(seleccion));
  return false;
}
