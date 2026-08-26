import { describe, expect, it } from 'vitest';
import { buildGuidedPlan } from '../../src/guided/planner';
import { invalidatedSteps } from '../../src/guided/invalidation';
import { STEP_DEFINITIONS } from '../../src/guided/steps';
import type { AnalysisContext, SpecSignature, StepKey, TimeSeriesFacts } from '../../src/guided/types';
import type { DoctorFinding, DoctorReport, DoctorCategoryKey, DoctorState } from '../../src/modelDoctor/types';

function sig(over: Partial<SpecSignature> = {}): SpecSignature {
  return {
    dataset: 'ipc.csv', yName: '', xNames: '', form: 'lin-lin', seType: 'classic',
    dropIncomplete: false, restriction: '', transformation: 'original', arimaOrders: '', ...over,
  };
}
function serie(over: Partial<TimeSeriesFacts> = {}): TimeSeriesFacts {
  return {
    dateColumn: 'fecha', valueColumn: 'ipc', transformation: 'original',
    hasResult: true, observations: 78, frequency: 'monthly',
    duplicateDates: 0, invalidDates: 0, arimaOrders: null, ...over,
  };
}
function finding(category: DoctorCategoryKey, state: DoctorState): DoctorFinding {
  return {
    category, state, impact: 'estimation', evidence: 'moderate', confidence: 'medium',
    headlineText: `titular ${category}`,
    detail: {
      evidence: [], conclusion: `conclusión ${category}`, whyItMatters: 'porque sí',
      whatToCheck: [{ text: 'revisar' }], whatItDoesNot: [], confidenceNote: '', theory: [],
    },
    sources: [], appliedRules: [],
  };
}
function report(findings: DoctorFinding[]): DoctorReport {
  return {
    overallState: 'review', headline: findings[0] ?? null, findings,
    coverage: { evaluated: findings.length, applicable: findings.length, skipped: [] },
    limits: [], flow: 'time-series',
  };
}
function ctx(ts: TimeSeriesFacts | null, doctor: DoctorReport | null = null,
             over: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    mode: 'timeseries', engine: 'lite',
    dataset: {
      name: 'ipc.csv', rows: 78, columns: 2, numericColumns: ['ipc'],
      categoricalColumns: [], hasDates: true, missingByColumn: {}, constantColumns: [], warnings: [],
    },
    raw: null,
    spec: {
      yName: '', xNames: [], form: 'lin-lin', seType: 'classic', dropIncomplete: false,
      restriction: '', signature: sig({ transformation: ts?.transformation ?? 'original' }),
    },
    estimatedSignature: null, hasResult: false, timeSeries: ts, doctor,
    session: { mode: 'guided', confirmedType: 'time_series', acknowledged: [], dismissed: [], decisions: [] },
    ...over,
  };
}
const stateOf = (plan: ReturnType<typeof buildGuidedPlan>, key: StepKey) =>
  plan.steps.find(s => s.key === key)?.state;

describe('series de tiempo no es OLS con una columna de fecha', () => {
  it('el recorrido temporal no muestra ningún paso de corte transversal', () => {
    const claves = buildGuidedPlan(ctx(serie())).steps.map(s => s.key);
    for (const k of ['variables', 'specification', 'estimate', 'readCoefficients', 'inference', 'diagnostics']) {
      expect(claves).not.toContain(k);
    }
  });

  it('y el de corte transversal no muestra ninguno temporal', () => {
    const plan = buildGuidedPlan({
      ...ctx(null), mode: 'regression',
      session: { mode: 'guided', confirmedType: 'cross_section', acknowledged: [], dismissed: [], decisions: [] },
    });
    const claves = plan.steps.map(s => s.key);
    for (const k of ['timeIndex', 'stationarity', 'identify', 'arima', 'forecast']) {
      expect(claves).not.toContain(k);
    }
  });

  it('ya no dice que la guía temporal no existe', () => {
    expect(buildGuidedPlan(ctx(serie())).cannotAdvise).toBeUndefined();
  });

  it('sin columnas elegidas, todo lo que sigue queda bloqueado', () => {
    const plan = buildGuidedPlan(ctx(serie({ dateColumn: '', valueColumn: '', hasResult: false })));
    expect(stateOf(plan, 'timeIndex')).toBe('next');
    expect(stateOf(plan, 'stationarity')).toBe('blocked');
  });
});

describe('G07 · el lazo de estacionariedad', () => {
  const noEstacionaria = report([finding('stationarity', 'problem')]);

  it('sobre la serie original propone transformar y volver a testear', () => {
    const plan = buildGuidedPlan(ctx(serie(), noEstacionaria));
    expect(plan.primary!.ruleId).toBe('G07');
    expect(plan.primary!.targetStep).toBe('transform');
  });

  it('declara el costo de diferenciar y la baja potencia del ADF', () => {
    const why = buildGuidedPlan(ctx(serie(), noEstacionaria)).primary!.why;
    expect(why).toMatch(/largo plazo/);
    expect(why).toMatch(/cointegración/);
    expect(why).toMatch(/no rechazar no prueba/);
  });

  it('se calla una vez que la serie analizada ya no es la original', () => {
    const plan = buildGuidedPlan(ctx(serie({ transformation: 'logReturn' }), noEstacionaria));
    expect(plan.primary?.ruleId).not.toBe('G07');
  });

  it('no aparece si Doctor no marcó problema de estacionariedad', () => {
    const plan = buildGuidedPlan(ctx(serie(), report([finding('stationarity', 'ok')])));
    expect(plan.primary?.ruleId).not.toBe('G07');
  });
});

describe('G08 · pronóstico sobre base dudosa', () => {
  const conArima = serie({ transformation: 'difference', arimaOrders: { p: 1, d: 1, q: 1 } });

  it('acompaña con una salvedad en vez de bloquear', () => {
    const plan = buildGuidedPlan(ctx(conArima, report([finding('arimaResiduals', 'problem')])));
    const g08 = [plan.primary, ...plan.secondary].find(r => r?.ruleId === 'G08');
    expect(g08).toBeDefined();
    expect(g08!.kind).toBe('advisory');
    expect(plan.blocked).toBe(false);
  });

  it('explica que lo que se rompe son los intervalos, no la proyección', () => {
    const plan = buildGuidedPlan(ctx(conArima, report([finding('arimaResiduals', 'problem')])));
    const g08 = [plan.primary, ...plan.secondary].find(r => r?.ruleId === 'G08')!;
    expect(g08.why).toMatch(/incertidumbre|intervalos|calibrad/);
  });

  it('sin ARIMA estimado no dice nada', () => {
    const plan = buildGuidedPlan(ctx(serie(), report([finding('arimaResiduals', 'problem')])));
    expect([plan.primary, ...plan.secondary].some(r => r?.ruleId === 'G08')).toBe(false);
  });
});

describe('invalidación temporal', () => {
  it('transformar reabre la estacionariedad y tira todo lo que cuelga', () => {
    const pasos = invalidatedSteps(['transformation']);
    expect(pasos.has('stationarity')).toBe(true);
    expect(pasos.has('identify')).toBe(true);
    expect(pasos.has('forecast')).toBe(true);
    // El índice temporal sobrevive: la fecha no cambió.
    expect(pasos.has('timeIndex')).toBe(false);
  });

  it('cambiar los órdenes no reabre la estacionariedad', () => {
    const pasos = invalidatedSteps(['arimaOrders']);
    expect(pasos.has('stationarity')).toBe(false);
    expect(pasos.has('identify')).toBe(false);
    expect(pasos.has('arima')).toBe(true);
    expect(pasos.has('arimaResiduals')).toBe(true);
  });
});

describe('catálogo', () => {
  it('cada paso temporal declara teoría y un porqué', () => {
    for (const def of STEP_DEFINITIONS.filter(d => d.appliesTo.includes('time_series'))) {
      expect(def.prompt.why.length).toBeGreaterThan(20);
    }
  });
});

describe('las reglas especializadas le ganan a la genérica', () => {
  it('la estacionariedad la explica G07, no el texto genérico de Doctor', () => {
    // Sin esta precedencia, G04 gana por impacto (estimación) y se pierde
    // todo lo que G07 sabe del dominio: el lazo de re-testear, el costo de
    // diferenciar, la poca potencia del ADF.
    const plan = buildGuidedPlan(ctx(serie(), report([finding('stationarity', 'problem')])));
    expect(plan.primary!.ruleId).toBe('G07');
    expect([plan.primary, ...plan.secondary].some(r => r?.ruleId === 'G04')).toBe(false);
  });

  it('pero una categoría sin regla propia la sigue tomando G04', () => {
    const plan = buildGuidedPlan(ctx(serie(), report([finding('sample', 'problem')])));
    expect([plan.primary, ...plan.secondary].some(r => r?.ruleId === 'G04')).toBe(true);
  });
});

describe('un solo detector de desactualizado', () => {
  it('cambiar la transformación reabre la estacionariedad en el recorrido', () => {
    // Regresión: había dos comparadores de firma con listas de campos
    // distintas. G02 detectaba el cambio de transformación y el paso quedaba
    // en verde al mismo tiempo.
    const plan = buildGuidedPlan(ctx(serie({ transformation: 'logReturn' }), null, {
      hasResult: true,
      estimatedSignature: sig({ transformation: 'original' }),
    }));
    const paso = plan.steps.find(s => s.key === 'stationarity')!;
    expect(paso.state).toBe('review');
    expect(paso.reviewReason).toBe('stale');
    expect(plan.primary!.ruleId).toBe('G02');
  });

  it('el índice temporal sobrevive a transformar', () => {
    const plan = buildGuidedPlan(ctx(serie({ transformation: 'difference' }), null, {
      hasResult: true,
      estimatedSignature: sig({ transformation: 'original' }),
    }));
    expect(plan.steps.find(s => s.key === 'timeIndex')!.reviewReason).toBeUndefined();
  });
});
