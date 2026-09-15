// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { borrarSangria, comentar, desindentar, indentar, nuevaLinea } from '../../src/chartpython/ui/editor';

const sel = (text: string, start: number, end = start) => ({ text, start, end });

describe('teclas del editor', () => {
  it('Tab inserta cuatro espacios donde está el cursor', () => {
    expect(indentar(sel('df', 2))).toMatchObject({ text: 'df    ', start: 6 });
  });

  it('Tab con selección sangra todas las líneas', () => {
    const resultado = indentar(sel('a = 1\nb = 2', 0, 11));
    expect(resultado.text).toBe('    a = 1\n    b = 2');
  });

  it('Shift+Tab saca la sangría', () => {
    expect(desindentar(sel('    a = 1', 4)).text).toBe('a = 1');
    expect(desindentar(sel('  a = 1', 2)).text).toBe('a = 1');
  });

  it('Enter hereda la sangría y agrega una después de dos puntos', () => {
    expect(nuevaLinea(sel('    x = 1', 9)).text).toBe('    x = 1\n    ');
    expect(nuevaLinea(sel('for i in rango:', 15)).text).toBe('for i in rango:\n    ');
  });

  it('Backspace borra la sangría entera, no un espacio', () => {
    expect(borrarSangria(sel('        ', 8))?.text).toBe('    ');
    expect(borrarSangria(sel('    x', 5))).toBeNull();
  });

  it('Ctrl+/ comenta y descomenta', () => {
    const comentado = comentar(sel('a = 1\nb = 2', 0, 11));
    expect(comentado.text).toBe('# a = 1\n# b = 2');
    expect(comentar({ ...comentado, start: 0, end: comentado.text.length }).text).toBe('a = 1\nb = 2');
  });
});
