import { beforeEach, describe, expect, it } from 'vitest';
import { appState } from '../../src/app/state';
import { renderGuided } from '../../src/ui/guidedView';
import {
  getSession, resetForNewDataset, resetSessionForTests, restoreGuidedPreferences, setMode,
} from '../../src/guided/session';
import { clearStoredMode } from '../../src/guided/persistence';
import { useMemoryStorage } from './memoryStorage';

const panel = () => document.getElementById('qb-guided')?.innerHTML ?? '';

beforeEach(() => {
  useMemoryStorage();
  document.body.innerHTML = '<section id="qb-guided" style="display:none"></section>';
  appState.csvData = null;
  appState.lastResult = null;
  appState.lastTimeSeriesResult = null;
  appState.activeMode = 'regression';
  appState.activeVersion = 'lite';
  resetSessionForTests();
  clearStoredMode();
});

describe('registro de decisiones en el panel', () => {
  it('no ocupa lugar mientras no haya nada que contar', () => {
    renderGuided();
    expect(panel()).not.toContain('Registro de decisiones');
  });

  it('muestra las decisiones con su cantidad y las más recientes arriba', () => {
    resetForNewDataset('datos.csv');
    setMode('free');
    renderGuided();

    const html = panel();
    expect(html).toContain('Registro de decisiones · 2');
    // Texto del registro, no el del botón de modo: ese sale en el encabezado y
    // haría pasar la comparación de orden por el motivo equivocado.
    expect(html.indexOf('Pasaste a modo libre')).toBeLessThan(html.indexOf('Cargaste datos.csv'));
  });

  it('sigue disponible en modo libre, donde es lo único que queda', () => {
    setMode('free');
    resetForNewDataset('datos.csv');
    renderGuided();

    const html = panel();
    // Sin riel de pasos: eso es lo que define el modo libre.
    expect(html).not.toContain('qb-g-steps');
    expect(html).toContain('Registro de decisiones');
    expect(html).toContain('Descargar registro');
  });

  it('escapa el nombre del dataset en vez de inyectarlo', () => {
    resetForNewDataset('<img src=x onerror=alert(1)>.csv');
    renderGuided();

    const html = panel();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});

describe('modo libre restaurado', () => {
  it('dibuja el modo guardado y no el de por defecto', () => {
    setMode('free');
    // Como si fuera una recarga: el estado en memoria se pierde, la
    // preferencia no.
    resetSessionForTests();
    restoreGuidedPreferences();
    renderGuided();

    expect(getSession().mode).toBe('free');
    // El selector marca el modo activo; los otros dos quedan como botones.
    expect(panel()).toContain('class="qb-g-mode is-active" aria-current="true">libre<');
    expect(panel()).toContain('data-guided-mode="practice"');
  });
});
