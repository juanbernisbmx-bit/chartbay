import { describe, expect, it } from 'vitest';
import { buildGuidedPlan, MAX_SECONDARY } from '../../src/guided/planner';
import { STEP_DEFINITIONS } from '../../src/guided/steps';
import type { AnalysisContext, CurrentSpec, DatasetProfile, SpecSignature } from '../../src/guided/types';

function signature(over: Partial<SpecSignature> = {}): SpecSignature {
  return {
    dataset: 'datos.csv', yName: 'salario', xNames: 'educacion|experiencia',
    form: 'lin-lin', seType: 'classic', dropIncomplete: false, restriction: '',
    ...over,
  };
}

function dataset(over: Partial<DatasetProfile> = {}): DatasetProfile {
  return {
    name: 'datos.csv', rows: 140, columns: 4,
    numericColumns: ['salario', 'educacion', 'experiencia'],
    categoricalColumns: [], hasDates: false,
    missingByColumn: {}, constantColumns: [], warnings: [],
    ...over,
  };
}

function spec(over: Partial<CurrentSpec> = {}): CurrentSpec {
  const base = {
    yName: 'salario', xNames: ['educacion', 'experiencia'],
    form: 'lin-lin' as const, seType: 'classic', dropIncomplete: false, restriction: '',
  };
  const merged = { ...base, ...over };
  return { ...merged, signature: signature({ ...merged, xNames: merged.xNames.join('|') }) };
}

function ctx(over: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    mode: 'regression', engine: 'lite',
    dataset: dataset(), raw: null, spec: spec(),
    estimatedSignature: null, hasResult: false, doctor: null,
    session: { mode: 'guided', confirmedType: 'cross_section', acknowledged: [], dismissed: [], decisions: [] },
    ...over,
  };
}

const stateOf = (plan: ReturnType<typeof buildGuidedPlan>, key: string) =>
  plan.steps.find(s => s.key === key)?.state;

describe('planificador · estados de pasos', () => {
  it('sin dataset, solo cargar está disponible y el resto bloqueado', () => {
    const plan = buildGuidedPlan(ctx({ dataset: null, spec: null }));
    expect(stateOf(plan, 'load')).toBe('next');
    expect(stateOf(plan, 'variables')).toBe('blocked');
    expect(stateOf(plan, 'estimate')).toBe('blocked');
  });

  it('un paso bloqueado dice qué le falta', () => {
    const plan = buildGuidedPlan(ctx({ dataset: null, spec: null }));
    const estimar = plan.steps.find(s => s.key === 'estimate')!;
    expect(estimar.unmet.length).toBeGreaterThan(0);
    expect(estimar.unmet[0].describe).toBeTruthy();
  });

  it('hay como máximo un paso en "next"', () => {
    const casos = [
      ctx({ dataset: null, spec: null }),
      ctx(),
      ctx({ hasResult: true, estimatedSignature: signature() }),
      ctx({ hasResult: true, estimatedSignature: signature(), session: { mode: 'guided', confirmedType: 'cross_section', acknowledged: ['readCoefficients'], dismissed: [], decisions: [] } }),
    ];
    for (const c of casos) {
      const n = buildGuidedPlan(c).steps.filter(s => s.state === 'next').length;
      expect(n).toBeLessThanOrEqual(1);
    }
  });

  it('sin confirmar el tipo de análisis, elegir variables queda bloqueado', () => {
    const plan = buildGuidedPlan(ctx({
      session: { mode: 'guided', confirmedType: null, acknowledged: [], dismissed: [], decisions: [] },
    }));
    expect(stateOf(plan, 'analysisType')).toBe('next');
    expect(stateOf(plan, 'variables')).toBe('blocked');
  });

  it('es determinístico: mismo contexto, mismo plan', () => {
    const c = ctx({ hasResult: true, estimatedSignature: signature() });
    expect(JSON.stringify(buildGuidedPlan(c).steps)).toBe(JSON.stringify(buildGuidedPlan(c).steps));
    expect(buildGuidedPlan(c).primary?.id).toBe(buildGuidedPlan(c).primary?.id);
  });

  it('nunca ofrece más secundarias que el presupuesto', () => {
    const plan = buildGuidedPlan(ctx({ hasResult: true, estimatedSignature: signature({ form: 'log-lin' }) }));
    expect(plan.secondary.length).toBeLessThanOrEqual(MAX_SECONDARY);
  });
});

describe('planificador · flujos separados', () => {
  it('en series de tiempo no aparece ningún paso de corte transversal', () => {
    const plan = buildGuidedPlan(ctx({
      mode: 'timeseries',
      session: { mode: 'guided', confirmedType: 'time_series', acknowledged: [], dismissed: [], decisions: [] },
    }));
    const claves = plan.steps.map(s => s.key);
    expect(claves).not.toContain('variables');
    expect(claves).not.toContain('diagnostics');
  });

  it('series de tiempo declara que la guía todavía no existe, en vez de improvisar', () => {
    const plan = buildGuidedPlan(ctx({
      mode: 'timeseries',
      session: { mode: 'guided', confirmedType: 'time_series', acknowledged: [], dismissed: [], decisions: [] },
    }));
    expect(plan.primary).toBeNull();
    expect(plan.cannotAdvise).toBeDefined();
    expect(plan.cannotAdvise!.whatIsMissing).toBeTruthy();
  });
});

describe('planificador · toda recomendación se puede explicar', () => {
  it('cada recomendación emitida trae un porqué', () => {
    const casos = [
      ctx(),
      ctx({ dataset: dataset({ missingByColumn: { educacion: 3 } }) }),
      ctx({ hasResult: true, estimatedSignature: signature({ form: 'log-lin' }) }),
      ctx({ hasResult: true, estimatedSignature: signature() }),
    ];
    for (const c of casos) {
      const plan = buildGuidedPlan(c);
      for (const r of [plan.primary, ...plan.secondary].filter(Boolean)) {
        expect(r!.why.length).toBeGreaterThan(20);
        expect(r!.title).toBeTruthy();
      }
    }
  });

  it('el catálogo de pasos está completo y sin duplicados', () => {
    const claves = STEP_DEFINITIONS.map(s => s.key);
    expect(new Set(claves).size).toBe(claves.length);
    for (const def of STEP_DEFINITIONS) {
      expect(def.prompt.why.length).toBeGreaterThan(20);
      expect(def.appliesTo.length).toBeGreaterThan(0);
    }
  });
});

describe('los dos motores cuentan como estimación', () => {
  it('con resultado, los pasos posteriores dejan de estar bloqueados', () => {
    // El contexto abstrae de qué motor vino: la guía solo pregunta si hay
    // modelo. Antes miraba únicamente el resultado de Lite y una corrida Pro
    // dejaba el recorrido trabado.
    const sinModelo = buildGuidedPlan(ctx({ hasResult: false }));
    const conModelo = buildGuidedPlan(ctx({ hasResult: true, estimatedSignature: signature() }));
    expect(sinModelo.steps.find(s => s.key === 'inference')!.state).toBe('blocked');
    expect(conModelo.steps.find(s => s.key === 'inference')!.state).not.toBe('blocked');
  });
});
