import { describe, expect, it } from 'vitest';
import { buildGuidedPlan } from '../../src/guided/planner';
import { GUIDED_RULES } from '../../src/guided/rules';
import type { AnalysisContext, CurrentSpec, DatasetProfile, SpecSignature } from '../../src/guided/types';

function signature(over: Partial<SpecSignature> = {}): SpecSignature {
  return {
    dataset: 'datos.csv', yName: 'salario', xNames: 'educacion|experiencia',
    form: 'lin-lin', seType: 'classic', dropIncomplete: false, restriction: '',
    transformation: '', arimaOrders: '',
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
  const m = { ...base, ...over };
  return { ...m, signature: signature({ ...m, xNames: m.xNames.join('|') }) };
}
function ctx(over: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    mode: 'regression', engine: 'lite', dataset: dataset(), raw: null, spec: spec(),
    estimatedSignature: null, hasResult: false, timeSeries: null, doctor: null,
    session: { mode: 'guided', confirmedType: 'cross_section', acknowledged: [], dismissed: [], decisions: [] },
    ...over,
  };
}
const ruleOf = (plan: ReturnType<typeof buildGuidedPlan>) => plan.primary?.ruleId;

describe('G01 · faltantes sin política declarada', () => {
  const conHuecos = ctx({ dataset: dataset({ missingByColumn: { educacion: 3 } }) });

  it('bloquea y nombra la columna con su conteo', () => {
    const plan = buildGuidedPlan(conHuecos);
    expect(ruleOf(plan)).toBe('G01');
    expect(plan.primary!.kind).toBe('blocking');
    expect(plan.blocked).toBe(true);
    expect(plan.primary!.body).toContain('educacion (3)');
  });

  it('ofrece las dos rutas y no elige ninguna', () => {
    const labels = buildGuidedPlan(conHuecos).primary!.actions.map(a => a.label);
    expect(labels.length).toBe(2);
    expect(labels.join(' ')).toMatch(/Excluir/);
    expect(labels.join(' ')).toMatch(/Limpiador/);
  });

  it('se calla cuando el estudiante ya declaró listwise', () => {
    const plan = buildGuidedPlan(ctx({
      dataset: dataset({ missingByColumn: { educacion: 3 } }),
      spec: spec({ dropIncomplete: true }),
    }));
    expect(ruleOf(plan)).not.toBe('G01');
  });

  it('ignora faltantes en columnas que no están en el modelo', () => {
    const plan = buildGuidedPlan(ctx({ dataset: dataset({ missingByColumn: { otra: 9 } }) }));
    expect(ruleOf(plan)).not.toBe('G01');
  });
});

describe('G02 · resultados desactualizados', () => {
  it('avisa cuando la especificación cambió después de estimar', () => {
    const plan = buildGuidedPlan(ctx({
      hasResult: true,
      estimatedSignature: signature({ form: 'log-lin' }),
    }));
    expect(ruleOf(plan)).toBe('G02');
    expect(plan.primary!.body).toContain('la forma funcional');
  });

  it('marca el paso de estimación como requiere revisión, sin re-estimar', () => {
    const plan = buildGuidedPlan(ctx({
      hasResult: true, estimatedSignature: signature({ form: 'log-lin' }),
    }));
    const paso = plan.steps.find(s => s.key === 'estimate')!;
    expect(paso.state).toBe('review');
    expect(paso.reviewReason).toBe('stale');
  });

  it('con solo el tipo de EE cambiado, explica que los coeficientes no se mueven', () => {
    const plan = buildGuidedPlan(ctx({
      hasResult: true, estimatedSignature: signature({ seType: 'HC3' }),
    }));
    expect(ruleOf(plan)).toBe('G02');
    expect(plan.primary!.why).toContain('no mueve los coeficientes');
  });

  it('no se dispara cuando la firma coincide', () => {
    const plan = buildGuidedPlan(ctx({ hasResult: true, estimatedSignature: signature() }));
    expect(ruleOf(plan)).not.toBe('G02');
  });
});

describe('G03 · signo y magnitud antes que significancia', () => {
  it('aparece apenas hay un modelo estimado', () => {
    const plan = buildGuidedPlan(ctx({ hasResult: true, estimatedSignature: signature() }));
    expect(ruleOf(plan)).toBe('G03');
    expect(plan.primary!.targetStep).toBe('readCoefficients');
  });

  it('deja de aparecer cuando el estudiante los revisó', () => {
    const plan = buildGuidedPlan(ctx({
      hasResult: true, estimatedSignature: signature(),
      session: { mode: 'guided', confirmedType: 'cross_section', acknowledged: ['readCoefficients'], dismissed: [], decisions: [] },
    }));
    expect(ruleOf(plan)).not.toBe('G03');
  });
});

describe('G10 · cierre', () => {
  const todoRevisado = ctx({
    hasResult: true, estimatedSignature: signature(),
    session: {
      mode: 'guided', confirmedType: 'cross_section',
      acknowledged: ['readCoefficients', 'inference', 'diagnostics'], dismissed: [], decisions: [],
    },
  });

  it('cierra sin declarar que el modelo es correcto', () => {
    const plan = buildGuidedPlan(todoRevisado);
    expect(ruleOf(plan)).toBe('G10');
    const texto = `${plan.primary!.title} ${plan.primary!.body}`.toLowerCase();
    expect(texto).not.toMatch(/modelo (es )?(bueno|correcto|válido|valido)/);
    expect(texto).not.toMatch(/list[oa] para/);
  });

  it('recuerda que lo no evaluado sigue sin evaluarse', () => {
    expect(buildGuidedPlan(todoRevisado).primary!.why).toMatch(/causalidad|variables omitidas/);
  });
});

describe('contrato general de las reglas', () => {
  it('descartar una recomendación la saca del plan', () => {
    const base = ctx({ hasResult: true, estimatedSignature: signature() });
    expect(ruleOf(buildGuidedPlan(base))).toBe('G03');
    const conDescarte = { ...base, session: { ...base.session, dismissed: ['G03'] } };
    expect(ruleOf(buildGuidedPlan(conDescarte))).not.toBe('G03');
  });

  it('las bloqueantes ganan siempre a las de consejo', () => {
    const plan = buildGuidedPlan(ctx({
      dataset: dataset({ missingByColumn: { educacion: 2 } }),
      hasResult: true, estimatedSignature: signature(),
    }));
    expect(plan.primary!.kind).toBe('blocking');
  });

  it('ninguna regla escribe un umbral estadístico', () => {
    // La evidencia la evalúa Model Doctor. Si acá aparece un p, un α o un VIF,
    // la lógica está en la capa equivocada.
    const fuente = GUIDED_RULES.map(r => `${r.id}`).join(' ');
    expect(fuente).toBeTruthy();
    for (const rule of GUIDED_RULES) {
      const texto = JSON.stringify(rule.when.toString());
      expect(texto).not.toMatch(/0\.05|0\.01|pValue|vif|alpha/i);
    }
  });

  it('los ids de regla son únicos', () => {
    const ids = GUIDED_RULES.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('descartar una recomendación se respeta de verdad', () => {
  function base() {
    return ctx({ hasResult: true, estimatedSignature: signature() });
  }

  it('tras "continuar igualmente" no reaparece el mismo consejo como prompt del paso', () => {
    const antes = buildGuidedPlan(base());
    expect(antes.primary!.ruleId).toBe('G03');
    const titulo = antes.primary!.title;

    const c = base();
    const conDescarte = { ...c, session: { ...c.session, dismissed: ['G03'] } };
    const despues = buildGuidedPlan(conDescarte);

    expect(despues.primary?.title).not.toBe(titulo);
    expect(despues.primary?.targetStep).not.toBe('readCoefficients');
  });

  it('el paso descartado deja de ser el próximo sugerido', () => {
    const c = base();
    const plan = buildGuidedPlan({ ...c, session: { ...c.session, dismissed: ['G03'] } });
    expect(plan.nextStep).not.toBe('readCoefficients');
  });
});
