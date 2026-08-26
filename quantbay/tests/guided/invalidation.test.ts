import { describe, expect, it } from 'vitest';
import { buildGuidedPlan } from '../../src/guided/planner';
import { changedFields, describeChanges, invalidatedSteps, onlyInferenceChanged } from '../../src/guided/invalidation';
import type { AnalysisContext, CurrentSpec, DatasetProfile, SpecSignature, StepKey } from '../../src/guided/types';

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
    yName: s.yName, xNames: s.xNames.split('|'), form: s.form as never,
    seType: s.seType, dropIncomplete: s.dropIncomplete, restriction: s.restriction, signature: s,
  };
}
function dataset(): DatasetProfile {
  return {
    name: 'datos.csv', rows: 140, columns: 4,
    numericColumns: ['salario', 'educacion', 'experiencia'], categoricalColumns: [],
    hasDates: false, missingByColumn: {}, constantColumns: [], warnings: [],
  };
}
/** Recorrido con todo revisado, para ver qué sobrevive a cada cambio. */
function ctx(current: Partial<SpecSignature> = {}): AnalysisContext {
  return {
    mode: 'regression', engine: 'lite', dataset: dataset(), raw: null,
    spec: spec(current), estimatedSignature: sig(), hasResult: true, timeSeries: null, doctor: null, comparison: null,
    session: {
      mode: 'guided', confirmedType: 'cross_section',
      acknowledged: ['readCoefficients', 'inference', 'diagnostics'], dismissed: [], decisions: [], estimatedSpecs: [],
    },
  };
}
const stateOf = (c: AnalysisContext, key: StepKey) =>
  buildGuidedPlan(c).steps.find(s => s.key === key)?.state;

describe('detección de cambios', () => {
  it('identifica cada campo por separado', () => {
    expect(changedFields(sig({ form: 'log-lin' }), sig())).toEqual(['form']);
    expect(changedFields(sig({ seType: 'HC3' }), sig())).toEqual(['seType']);
    expect(changedFields(sig({ dropIncomplete: true }), sig())).toEqual(['missingPolicy']);
    expect(changedFields(sig(), sig())).toEqual([]);
  });

  it('acumula varios cambios y los redacta en castellano', () => {
    const cambios = changedFields(sig({ form: 'log-lin', seType: 'HC3' }), sig());
    expect(cambios).toHaveLength(2);
    expect(describeChanges(cambios)).toBe('la forma funcional y el tipo de errores estándar');
  });

  it('reconoce el caso en que solo cambió la inferencia', () => {
    expect(onlyInferenceChanged(['seType'])).toBe(true);
    expect(onlyInferenceChanged(['seType', 'form'])).toBe(false);
    expect(onlyInferenceChanged(['form'])).toBe(false);
  });
});

describe('qué invalida cada cambio', () => {
  it('un dataset nuevo no deja nada en pie', () => {
    const pasos = invalidatedSteps(['dataset']);
    for (const k of ['profile', 'analysisType', 'variables', 'specification', 'estimate',
                     'readCoefficients', 'inference', 'diagnostics', 'conclude'] as StepKey[]) {
      expect(pasos.has(k)).toBe(true);
    }
  });

  it('cambiar Y invalida desde la especificación, pero no el tipo de análisis', () => {
    const pasos = invalidatedSteps(['y']);
    expect(pasos.has('specification')).toBe(true);
    expect(pasos.has('analysisType')).toBe(false);
    expect(pasos.has('profile')).toBe(false);
  });

  it('el tipo de errores estándar NO invalida la lectura de coeficientes', () => {
    // Es el punto pedagógico de toda esta pieza: los coeficientes no se mueven.
    const pasos = invalidatedSteps(['seType']);
    expect(pasos.has('readCoefficients')).toBe(false);
    expect(pasos.has('inference')).toBe(true);
    expect(pasos.has('diagnostics')).toBe(true);
  });

  it('la forma funcional sí invalida la lectura: los coeficientes cambian', () => {
    expect(invalidatedSteps(['form']).has('readCoefficients')).toBe(true);
  });

  it('siempre hay que volver a estimar', () => {
    for (const c of ['dataset', 'missingPolicy', 'y', 'x', 'form', 'seType', 'restriction'] as const) {
      expect(invalidatedSteps([c]).has('estimate')).toBe(true);
    }
  });
});

describe('efecto en el recorrido', () => {
  it('un paso invalidado deja de contar como hecho', () => {
    expect(stateOf(ctx(), 'inference')).toBe('done');
    expect(stateOf(ctx({ form: 'log-lin' }), 'inference')).toBe('review');
  });

  it('con solo los errores estándar cambiados, lo leído sigue valiendo', () => {
    const c = ctx({ seType: 'HC3' });
    expect(stateOf(c, 'readCoefficients')).toBe('done');
    expect(stateOf(c, 'inference')).toBe('review');
  });

  it('el motivo dice que fue por un cambio, no por un hallazgo', () => {
    const paso = buildGuidedPlan(ctx({ form: 'log-lin' })).steps.find(s => s.key === 'inference')!;
    expect(paso.reviewReason).toBe('stale');
  });

  it('sin cambios, nada se invalida', () => {
    const plan = buildGuidedPlan(ctx());
    expect(plan.steps.filter(s => s.reviewReason === 'stale')).toHaveLength(0);
  });

  it('la invalidación no re-estima: solo marca y espera', () => {
    // El plan es un objeto de lectura; no hay ninguna acción automática.
    const plan = buildGuidedPlan(ctx({ form: 'log-lin' }));
    expect(plan.primary!.actions.every(a => typeof a.label === 'string')).toBe(true);
    expect(plan.primary!.ruleId).toBe('G02');
  });
});
