// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { accionDeComando, accionDeEdicion } from '../../src/chartpython/ui/shortcuts';

describe('atajos de teclado', () => {
  it('las tres formas de ejecutar de Jupyter valen en los dos modos', () => {
    expect(accionDeEdicion({ key: 'Enter', shiftKey: true })).toBe('ejecutar-y-seguir');
    expect(accionDeEdicion({ key: 'Enter', ctrlKey: true })).toBe('ejecutar');
    expect(accionDeEdicion({ key: 'Enter', altKey: true })).toBe('ejecutar-e-insertar');
    expect(accionDeComando({ key: 'Enter', shiftKey: true }).accion).toBe('ejecutar-y-seguir');
  });

  it('Enter solo escribe en edición y entra a editar en comando', () => {
    expect(accionDeEdicion({ key: 'Enter' })).toBeNull();
    expect(accionDeComando({ key: 'Enter' }).accion).toBe('editar');
  });

  it('D D borra y una D sola espera la segunda', () => {
    const primera = accionDeComando({ key: 'd' });
    expect(primera).toEqual({ accion: null, pendiente: 'd' });
    expect(accionDeComando({ key: 'd' }, primera.pendiente).accion).toBe('borrar');
    expect(accionDeComando({ key: 'a' }, 'd').accion).toBe('insertar-arriba');
  });

  it('0 0 reinicia e I I interrumpe', () => {
    expect(accionDeComando({ key: '0' }, '0').accion).toBe('reiniciar');
    expect(accionDeComando({ key: 'i' }, 'i').accion).toBe('interrumpir');
  });

  it('las letras de Jupyter hacen lo mismo que en Jupyter', () => {
    const accion = (key: string) => accionDeComando({ key }).accion;
    expect(accion('a')).toBe('insertar-arriba');
    expect(accion('b')).toBe('insertar-abajo');
    expect(accion('m')).toBe('a-markdown');
    expect(accion('y')).toBe('a-codigo');
    expect(accion('z')).toBe('deshacer-borrado');
    expect(accion('j')).toBe('siguiente');
    expect(accion('k')).toBe('anterior');
  });

  it('Shift con las flechas mueve la celda', () => {
    expect(accionDeComando({ key: 'ArrowUp', shiftKey: true }).accion).toBe('subir');
    expect(accionDeComando({ key: 'ArrowDown', shiftKey: true }).accion).toBe('bajar');
    expect(accionDeComando({ key: 'ArrowDown' }).accion).toBe('siguiente');
  });

  it('un atajo del navegador no se roba', () => {
    expect(accionDeComando({ key: 'r', ctrlKey: true }).accion).toBeNull();
    expect(accionDeComando({ key: 's', metaKey: true }).accion).toBe('guardar');
    expect(accionDeEdicion({ key: 'Escape' })).toBe('comando');
  });
});
