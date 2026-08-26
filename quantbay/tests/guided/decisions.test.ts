import { beforeEach, describe, expect, it } from 'vitest';
import {
  confirmAnalysisType,
  dismissRecommendation,
  getSession,
  noteSpecChange,
  recordEstimation,
  resetForNewDataset,
  resetSessionForTests,
  restoreGuidedPreferences,
  seedSpecBaseline,
  setMode,
} from '../../src/guided/session';
import {
  buildDecisionLogText,
  clockOf,
  describeChange,
  describeEstimation,
  describeSpecChanges,
} from '../../src/guided/decisionLog';
import { clearStoredMode, loadStoredMode } from '../../src/guided/persistence';
import type { CurrentSpec, SpecSignature } from '../../src/guided/types';

function sig(over: Partial<SpecSignature> = {}): SpecSignature {
  return {
    dataset: 'datos.csv', yName: 'salario', xNames: 'educacion|experiencia',
    form: 'lin-lin', seType: 'classic', dropIncomplete: false, restriction: '',
    transformation: '', arimaOrders: '', ...over,
  };
}

function spec(over: Partial<SpecSignature> = {}): CurrentSpec {
  const s = sig(over);
  return {
    yName: s.yName, xNames: s.xNames === '' ? [] : s.xNames.split('|'), form: s.form,
    seType: s.seType, dropIncomplete: s.dropIncomplete, restriction: s.restriction, signature: s,
  };
}

const kinds = () => getSession().decisions.map(d => d.kind);
const summaries = () => getSession().decisions.map(d => d.summary);

beforeEach(() => {
  resetSessionForTests();
  clearStoredMode();
});

describe('redacción de las decisiones', () => {
  it('nombra el campo junto al valor nuevo', () => {
    expect(describeChange('form', sig({ form: 'log-lin' }))).toBe('la forma funcional (log-lin)');
    expect(describeChange('x', sig({ xNames: 'educacion|edad' })))
      .toBe('las variables X (educacion, edad)');
    expect(describeChange('missingPolicy', sig({ dropIncomplete: true })))
      .toBe('la política de faltantes (descartar filas incompletas)');
  });

  it('nombra explícitamente la ausencia en vez de dejar el paréntesis vacío', () => {
    expect(describeChange('restriction', sig())).toBe('la restricción (sin restricción)');
    expect(describeChange('arimaOrders', sig())).toBe('los órdenes del ARIMA (sin ARIMA)');
    expect(describeChange('x', sig({ xNames: '' }))).toBe('las variables X (ninguna)');
  });

  it('une varios cambios en una sola frase', () => {
    expect(describeSpecChanges(['form', 'seType'], sig({ form: 'log-lin', seType: 'HC3' })))
      .toBe('la forma funcional (log-lin) y el tipo de errores estándar (HC3)');
  });

  it('escribe la estimación en la notación del modelo', () => {
    expect(describeEstimation(sig())).toBe('Estimaste salario ~ educacion + experiencia · lin-lin');
  });

  it('distingue el flujo de series por la transformación', () => {
    expect(describeEstimation(sig({ transformation: 'difference' })))
      .toBe('Analizaste la serie (difference)');
    expect(describeEstimation(sig({ transformation: 'original', arimaOrders: '1,0,1' })))
      .toBe('Analizaste la serie (original) con ARIMA(1,0,1)');
  });
});

describe('registro de cambios de especificación', () => {
  it('no anota nada mientras no haya línea de base', () => {
    noteSpecChange(spec({ form: 'log-lin' }));
    expect(getSession().decisions).toHaveLength(0);
  });

  it('separa la decisión de modelo de la decisión de estimación', () => {
    seedSpecBaseline(spec());
    noteSpecChange(spec({ xNames: 'educacion', seType: 'HC3' }));
    expect(kinds()).toEqual(['choose_variables', 'set_spec']);
    expect(summaries()[0]).toBe('Cambiaste las variables X (educacion)');
    expect(summaries()[1]).toBe('Cambiaste el tipo de errores estándar (HC3)');
  });

  it('mide cada cambio contra el anterior y no contra el original', () => {
    seedSpecBaseline(spec());
    noteSpecChange(spec({ form: 'log-lin' }));
    noteSpecChange(spec({ form: 'log-lin' }));
    expect(kinds()).toEqual(['set_spec']);
    noteSpecChange(spec({ form: 'log-log' }));
    expect(summaries()[1]).toBe('Cambiaste la forma funcional (log-log)');
  });

  it('no confunde cambiar de dataset con cambiar el modelo', () => {
    seedSpecBaseline(spec());
    noteSpecChange(spec({ dataset: 'otro.csv', yName: 'precio', xNames: 'm2' }));
    expect(getSession().decisions).toHaveLength(0);
  });

  it('no lee el salto entre corte transversal y series como una transformación', () => {
    seedSpecBaseline(spec());
    noteSpecChange(spec({ transformation: 'original' }));
    expect(getSession().decisions).toHaveLength(0);
    // Y desde ahí sí registra las transformaciones reales de la serie.
    noteSpecChange(spec({ transformation: 'difference' }));
    expect(summaries()).toEqual(['Cambiaste la transformación de la serie (difference)']);
  });

  it('deja la estimación como nueva línea de base', () => {
    seedSpecBaseline(spec());
    recordEstimation(sig({ form: 'log-lin' }));
    noteSpecChange(spec({ form: 'log-lin' }));
    expect(kinds()).toEqual(['estimate']);
  });
});

describe('modo libre', () => {
  it('persiste la elección y la restaura en la carga siguiente', () => {
    setMode('free');
    expect(loadStoredMode()).toBe('free');

    resetSessionForTests();
    expect(getSession().mode).toBe('guided');
    restoreGuidedPreferences();
    expect(getSession().mode).toBe('free');
  });

  it('restaurar no cuenta como una decisión nueva', () => {
    setMode('free');
    resetSessionForTests();
    restoreGuidedPreferences();
    expect(getSession().decisions).toHaveLength(0);
  });

  it('anota apagar y volver a encender la guía, y no el ruido intermedio', () => {
    setMode('free');
    setMode('free');
    setMode('guided');
    expect(kinds()).toEqual(['set_mode', 'set_mode']);
    expect(summaries()[0]).toContain('modo libre');
    expect(summaries()[1]).toContain('modo guiado');
  });

  it('sobrevive a cargar un dataset nuevo', () => {
    setMode('free');
    resetForNewDataset('otro.csv');
    expect(getSession().mode).toBe('free');
  });
});

describe('exportación del registro', () => {
  it('cuenta la sesión en orden cronológico', () => {
    resetForNewDataset('datos.csv');
    confirmAnalysisType('cross_section', 'cross_section');
    recordEstimation(sig());

    const text = buildDecisionLogText(getSession(), {
      dataset: 'datos.csv', analysisType: 'cross_section', mode: 'guided', generatedAt: 0,
    });
    const load = text.indexOf('Cargaste datos.csv');
    const type = text.indexOf('Confirmaste corte transversal');
    const estimate = text.indexOf('Estimaste salario');
    expect(load).toBeGreaterThan(-1);
    expect(load).toBeLessThan(type);
    expect(type).toBeLessThan(estimate);
    expect(text).toContain('1. ');
    expect(text).toContain('Dataset: datos.csv');
    expect(text).toContain('Tipo de análisis: corte transversal');
    expect(text).toContain('Modo: guiado');
  });

  it('lista aparte lo que el estudiante decidió no atender', () => {
    dismissRecommendation('G03', 'Los residuos muestran heterocedasticidad');
    const text = buildDecisionLogText(getSession(), {
      dataset: 'datos.csv', analysisType: null, mode: 'free', generatedAt: 0,
    });
    expect(text).toContain('## Recomendaciones que decidiste no atender');
    expect(text).toContain('Continuaste sin atender: Los residuos muestran heterocedasticidad');
    expect(text).toContain('Tipo de análisis: sin confirmar');
  });

  it('omite la sección de omisiones cuando no hubo ninguna', () => {
    resetForNewDataset('datos.csv');
    const text = buildDecisionLogText(getSession(), {
      dataset: 'datos.csv', analysisType: null, mode: 'guided', generatedAt: 0,
    });
    expect(text).not.toContain('no atender');
  });

  it('no dictamina sobre el análisis: solo documenta lo que se hizo', () => {
    resetForNewDataset('datos.csv');
    const text = buildDecisionLogText(getSession(), {
      dataset: null, analysisType: null, mode: 'guided', generatedAt: 0,
    });
    expect(text).toContain('No certifica que el modelo esté bien');
    expect(text.toLowerCase()).not.toContain('correcto el modelo');
    expect(text).toContain('ninguno cargado');
  });

  it('aguanta una sesión vacía', () => {
    const text = buildDecisionLogText(getSession(), {
      dataset: null, analysisType: null, mode: 'guided', generatedAt: 0,
    });
    expect(text).toContain('Todavía no hay decisiones registradas');
  });
});

describe('reloj del registro', () => {
  it('usa hh:mm:ss con relleno de ceros', () => {
    const at = new Date(2026, 7, 26, 9, 5, 3).getTime();
    expect(clockOf(at)).toBe('09:05:03');
  });
});
