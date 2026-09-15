import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '../../src/chartpython/ui/sanitize';

const html = (fuente: string): HTMLElement => {
  const caja = document.createElement('div');
  caja.appendChild(sanitizeHtml(fuente));
  return caja;
};

describe('saneador de salidas HTML', () => {
  it('conserva la tabla de un DataFrame de pandas', () => {
    const tabla = '<div><style scoped>.dataframe {}</style><table border="1" class="dataframe">'
      + '<thead><tr style="text-align: right;"><th></th><th>a</th></tr></thead>'
      + '<tbody><tr><th>0</th><td>1</td></tr></tbody></table></div>';
    const caja = html(tabla);
    expect(caja.querySelectorAll('tr')).toHaveLength(2);
    expect(caja.querySelector('td')?.textContent).toBe('1');
    expect(caja.querySelector('table')?.className).toBe('cp-tabla');
    expect(caja.querySelector('table')?.getAttribute('border')).toBeNull();
    expect(caja.textContent).not.toContain('.dataframe {}');
  });

  it('no deja pasar scripts ni manejadores', () => {
    const caja = html('<p onclick="robar()">hola</p><script>robar()</script><img src=x onerror="robar()">');
    expect(caja.querySelector('script')).toBeNull();
    expect(caja.querySelector('img')).toBeNull();
    expect(caja.querySelector('p')?.getAttribute('onclick')).toBeNull();
    expect(caja.textContent).toContain('hola');
    expect(caja.innerHTML).not.toContain('robar');
  });

  it('descarta enlaces con esquemas peligrosos y protege los que quedan', () => {
    const caja = html('<a href="javascript:robar()">uno</a><a href="https://chartbay.onrender.com">dos</a>');
    const enlaces = caja.querySelectorAll('a');
    expect(enlaces).toHaveLength(1);
    expect(enlaces[0].getAttribute('href')).toBe('https://chartbay.onrender.com');
    expect(enlaces[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(caja.textContent).toContain('uno');
  });

  it('tira iframes y objetos con todo su contenido', () => {
    const caja = html('<iframe src="https://ejemplo.com"><p>adentro</p></iframe><object data="x"></object><p>afuera</p>');
    expect(caja.querySelector('iframe')).toBeNull();
    expect(caja.querySelector('object')).toBeNull();
    expect(caja.textContent).toBe('afuera');
  });

  it('corta una salida con demasiados nodos', () => {
    const caja = html('<p>x</p>'.repeat(8000));
    expect(caja.textContent).toContain('salida recortada');
  });
});
