import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/chartpython/ui/markdown';

const md = (fuente: string): HTMLElement => {
  const caja = document.createElement('div');
  caja.appendChild(renderMarkdown(fuente));
  return caja;
};

describe('markdown de las celdas de texto', () => {
  it('arma títulos, listas y citas', () => {
    const caja = md('# Título\n\n- uno\n- dos\n\n> nota');
    expect(caja.querySelector('h1')?.textContent).toBe('Título');
    expect(caja.querySelectorAll('ul li')).toHaveLength(2);
    expect(caja.querySelector('blockquote')?.textContent).toContain('nota');
  });

  it('respeta el código sin interpretarlo', () => {
    const caja = md('```python\nprint("<b>hola</b>")\n```\n\ntexto con `x = 1`');
    expect(caja.querySelector('pre code')?.textContent).toBe('print("<b>hola</b>")');
    expect(caja.querySelector('p code')?.textContent).toBe('x = 1');
    expect(caja.querySelector('b')).toBeNull();
  });

  it('nunca ejecuta HTML escrito en la celda', () => {
    const caja = md('<script>robar()</script> y <img src=x onerror="robar()">');
    expect(caja.querySelector('script')).toBeNull();
    expect(caja.querySelector('img')).toBeNull();
    expect(caja.textContent).toContain('<script>robar()</script>');
  });

  it('sólo enlaza http, https y mailto', () => {
    const caja = md('[bien](https://ejemplo.com) y [mal](javascript:robar())');
    const enlaces = caja.querySelectorAll('a');
    expect(enlaces).toHaveLength(1);
    expect(enlaces[0].getAttribute('href')).toBe('https://ejemplo.com');
    expect(caja.textContent).toContain('mal');
  });

  it('arma tablas de pipes con encabezado', () => {
    const caja = md('| año | pbi |\n| --- | --- |\n| 2024 | 3,1 |\n| 2025 | 2,4 |');
    expect(caja.querySelectorAll('thead th')).toHaveLength(2);
    expect(caja.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(caja.querySelector('tbody td')?.textContent).toBe('2024');
  });

  it('marca negrita y cursiva', () => {
    const caja = md('**fuerte** y *suave*');
    expect(caja.querySelector('strong')?.textContent).toBe('fuerte');
    expect(caja.querySelector('em')?.textContent).toBe('suave');
  });
});
