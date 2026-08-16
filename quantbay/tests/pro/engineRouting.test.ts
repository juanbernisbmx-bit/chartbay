import { describe, expect, it } from 'vitest';
import { resolveEngineAction } from '../../src/pro/engineRouting';
import { appState } from '../../src/app/state';

describe('engineRouting', () => {
  it('Lite sigue siendo la versión por defecto', () => {
    expect(appState.activeVersion).toBe('lite');
  });

  it('Lite usa el flujo TypeScript existente', () => {
    expect(resolveEngineAction('lite')).toBe('lite');
  });

  it('Pro apunta al runner Pyodide, no al bloqueo genérico', () => {
    expect(resolveEngineAction('pro')).toBe('pro_pyodide');
  });

});
