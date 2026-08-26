import { describe, expect, it } from 'vitest';
import { buildGuidedPlan } from '../../src/guided/planner';
import type { AnalysisContext, CurrentSpec, DatasetProfile, SpecSignature } from '../../src/guided/types';
import type { DoctorFinding, DoctorReport, DoctorCategoryKey, DoctorState, DoctorImpact } from '../../src/modelDoctor/types';

function signature(over: Partial<SpecSignature> = {}): SpecSignature {
  return {
    dataset: 'datos.csv', yName: 'salario', xNames: 'educacion|experiencia',
    form: 'lin-lin', seType: 'classic', dropIncomplete: false, restriction: '',
    transformation: '', arimaOrders: '', ...over,
  };
}
function spec(): CurrentSpec {
  return {
    yName: 'salario', xNames: ['educacion', 'experiencia'], form: 'lin-lin',
    seType: 'classic', dropIncomplete: false, restriction: '', signature: signature(),
  };
}
function dataset(): DatasetProfile {
  return {
    name: 'datos.csv', rows: 140, columns: 4,
    numericColumns: ['salario', 'educacion', 'experiencia'], categoricalColumns: [],
    hasDates: false, missingByColumn: {}, constantColumns: [], warnings: [],
  };
}

/** Hallazgo con la forma exacta que emite buildModelDoctor. */
function finding(
  category: DoctorCategoryKey, state: DoctorState, impact: DoctorImpact,
  over: Partial<DoctorFinding> = {}
): DoctorFinding {
  return {
    category, state, impact, evidence: 'moderate', confidence: 'medium',
    headlineText: `titular de ${category}`,
    detail: {
      evidence: [{ label: 'p', value: '0.012' }],
      conclusion: `conclusión de ${category}`,
      whyItMatters: `por qué importa ${category}`,
      whatToCheck: [{ text: `revisar ${category}` }, { text: 'segunda acción' }],
      whatItDoesNot: ['no significa que el modelo esté mal'],
      confidenceNote: 'nota de confianza',
      theory: [{ id: 'errores robustos', label: 'errores robustos' }],
    },
    sources: [], appliedRules: [], ...over,
  };
}

function report(findings: DoctorFinding[]): DoctorReport {
  return {
    overallState: 'review', headline: findings[0] ?? null, findings,
    coverage: { evaluated: findings.length, applicable: findings.length, skipped: [] },
    limits: [], flow: 'cross-section',
  };
}

function ctx(doctor: DoctorReport | null, over: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    mode: 'regression', engine: 'lite', dataset: dataset(), raw: null, spec: spec(),
    estimatedSignature: signature(), hasResult: true, timeSeries: null, doctor,
    session: {
      mode: 'guided', confirmedType: 'cross_section',
      acknowledged: ['readCoefficients'], dismissed: [], decisions: [],
    },
    ...over,
  };
}

describe('G04 · hallazgo con consecuencia sobre la inferencia', () => {
  it('recomienda sobre el paso de inferencia y reutiliza los textos de Doctor', () => {
    const f = finding('heteroskedasticity', 'problem', 'inference');
    const plan = buildGuidedPlan(ctx(report([f])));
    expect(plan.primary!.ruleId).toBe('G04');
    // Los textos no se reescriben: salen tal cual del informe.
    expect(plan.primary!.title).toBe(f.headlineText);
    expect(plan.primary!.why).toBe(f.detail.whyItMatters);
    expect(plan.primary!.actions[0].label).toBe('revisar heteroskedasticity');
    expect(plan.primary!.theory).toContain('errores robustos');
  });

  it('entre varios, manda la consecuencia y no la categoría', () => {
    const plan = buildGuidedPlan(ctx(report([
      finding('multicollinearity', 'problem', 'efficiency'),
      finding('specification', 'problem', 'estimation'),
    ])));
    expect(plan.primary!.sourceCategory).toBe('specification');
  });

  it('un hallazgo de eficiencia no le gana a uno de estimación', () => {
    const plan = buildGuidedPlan(ctx(report([
      finding('specification', 'problem', 'estimation'),
      finding('multicollinearity', 'problem', 'efficiency'),
    ])));
    expect(plan.primary!.impact).toBe('estimation');
  });
});

describe('G05 · no se recomienda lo que ya está atendido', () => {
  it('con la categoría mitigada no aparece ningún consejo de atenderla', () => {
    const plan = buildGuidedPlan(ctx(report([finding('heteroskedasticity', 'mitigated', 'efficiency')])));
    const consejos = [plan.primary, ...plan.secondary].filter(Boolean);
    const atender = consejos.filter(r => r!.sourceCategory === 'heteroskedasticity' && r!.ruleId !== 'G05');
    expect(atender).toHaveLength(0);
  });

  it('lo informa una vez, sin presentarlo como problema', () => {
    const plan = buildGuidedPlan(ctx(report([finding('heteroskedasticity', 'mitigated', 'efficiency')])));
    const g05 = [plan.primary, ...plan.secondary].find(r => r?.ruleId === 'G05');
    expect(g05).toBeDefined();
    expect(g05!.kind).toBe('informational');
  });

  it('mitigado no marca el paso como que requiere revisión', () => {
    const plan = buildGuidedPlan(ctx(report([finding('heteroskedasticity', 'mitigated', 'efficiency')])));
    expect(plan.steps.find(s => s.key === 'diagnostics')!.state).not.toBe('review');
  });
});

describe('G06 · diagnóstico que no se pudo evaluar', () => {
  it('recomienda conseguirlo citando el motivo de Doctor', () => {
    const f = finding('heteroskedasticity', 'insufficient', 'inference', {
      insufficientReason: 'sample_too_small',
      detail: {
        evidence: [], conclusion: 'la muestra es demasiado chica para este test',
        whyItMatters: 'sin el test no se puede afirmar ni descartar',
        whatToCheck: [{ text: 'conseguir más observaciones' }],
        whatItDoesNot: [], confidenceNote: '', theory: [],
      },
    });
    const plan = buildGuidedPlan(ctx(report([f])));
    const g06 = [plan.primary, ...plan.secondary].find(r => r?.ruleId === 'G06');
    expect(g06).toBeDefined();
    expect(g06!.body).toBe('la muestra es demasiado chica para este test');
  });

  it('lo no aplicable no genera ninguna recomendación', () => {
    const plan = buildGuidedPlan(ctx(report([finding('multicollinearity', 'not_applicable', 'efficiency')])));
    const consejos = [plan.primary, ...plan.secondary].filter(Boolean);
    expect(consejos.some(r => r!.sourceCategory === 'multicollinearity')).toBe(false);
  });

  it('lo que está en ok tampoco genera nada', () => {
    const plan = buildGuidedPlan(ctx(report([finding('residuals', 'ok', 'reading')])));
    const consejos = [plan.primary, ...plan.secondary].filter(Boolean);
    expect(consejos.some(r => r!.sourceCategory === 'residuals')).toBe(false);
  });
});

describe('los hallazgos marcan el paso que les corresponde', () => {
  it('un problema de inferencia deja ese paso en requiere revisión', () => {
    const plan = buildGuidedPlan(ctx(report([finding('inference', 'problem', 'inference')])));
    const paso = plan.steps.find(s => s.key === 'inference')!;
    expect(paso.state).toBe('review');
    expect(paso.reviewReason).toBe('doctor_finding');
  });

  it('el motivo distingue el hallazgo del desactualizado', () => {
    const plan = buildGuidedPlan(ctx(report([finding('heteroskedasticity', 'problem', 'inference')])));
    expect(plan.steps.find(s => s.key === 'diagnostics')!.reviewReason).toBe('doctor_finding');
  });

  it('si la especificación cambió, gana el desactualizado sobre el hallazgo', () => {
    // Un diagnóstico de un modelo superado no puede pedir que lo atiendas:
    // primero hay que volver a estimar. El motivo lo refleja.
    const plan = buildGuidedPlan(ctx(report([finding('heteroskedasticity', 'problem', 'inference')]), {
      estimatedSignature: signature({ form: 'log-lin' }),
    }));
    expect(plan.steps.find(s => s.key === 'estimate')!.reviewReason).toBe('stale');
    expect(plan.steps.find(s => s.key === 'diagnostics')!.reviewReason).toBe('stale');
    expect(plan.primary!.ruleId).toBe('G02');
  });
});

describe('sin informe la guía sigue funcionando', () => {
  it('el plan es válido y el paso de diagnósticos queda pendiente', () => {
    const plan = buildGuidedPlan(ctx(null));
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps.find(s => s.key === 'diagnostics')!.state).toMatch(/pending|next/);
  });
});

describe('prioridad entre detectado y faltante', () => {
  it('un problema detectado le gana a un diagnóstico que falta', () => {
    // Aunque la categoría faltante sea de estimación y la detectada de
    // inferencia: conseguir un diagnóstico no es más urgente que atender uno
    // que ya encontró algo.
    const plan = buildGuidedPlan(ctx(report([
      finding('specification', 'insufficient', 'estimation'),
      finding('heteroskedasticity', 'problem', 'inference'),
    ])));
    expect(plan.primary!.ruleId).toBe('G04');
    expect(plan.primary!.sourceCategory).toBe('heteroskedasticity');
  });

  it('una recomendación por diagnóstico faltante no declara consecuencia', () => {
    const plan = buildGuidedPlan(ctx(report([finding('specification', 'insufficient', 'estimation')])));
    const g06 = [plan.primary, ...plan.secondary].find(r => r?.ruleId === 'G06');
    expect(g06!.impact).toBeUndefined();
  });
});
