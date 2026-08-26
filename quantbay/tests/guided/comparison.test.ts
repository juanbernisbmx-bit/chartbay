import { beforeEach, describe, expect, it } from 'vitest';
import { buildGuidedPlan } from '../../src/guided/planner';
import { GUIDED_RULES } from '../../src/guided/rules';
import { STEP_DEFINITIONS } from '../../src/guided/steps';
import { recordEstimation, resetForNewDataset, resetSessionForTests, getSession } from '../../src/guided/session';
import type {
  AnalysisContext, ComparisonFacts, CurrentSpec, DatasetProfile, SpecSignature, StepKey,
} from '../../src/guided/types';

function sig(over: Partial<SpecSignature> = {}): SpecSignature {
  return {
    dataset: 'datos.csv', yName: 'salario', xNames: 'educacion|experiencia',
    form: 'lin-lin', seType: 'classic', dropIncomplete: false, restriction: '',
    transformation: '', arimaOrders: '', ...over,
  };
}
function spec(): CurrentSpec {
  const s = sig();
  return {
    yName: s.yName, xNames: s.xNames.split('|'), form: s.form,
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

function facts(over: Partial<ComparisonFacts> = {}): ComparisonFacts {
  return {
    saved: 0, currentUnsaved: true, level: null,
    blocking: [], cautions: [], significanceFlips: [], ...over,
  };
}

/** Recorrido con un modelo estimado. `estimatedSpecs` simula lo ya probado. */
function ctx(over: Partial<AnalysisContext> = {}, estimatedSpecs: string[] = ['a']): AnalysisContext {
  return {
    mode: 'regression', engine: 'lite', dataset: dataset(), raw: null, spec: spec(),
    estimatedSignature: sig(), hasResult: true, timeSeries: null, doctor: null,
    comparison: null,
    session: {
      mode: 'guided', confirmedType: 'cross_section', acknowledged: [], dismissed: [],
      decisions: [], estimatedSpecs,
    },
    ...over,
  };
}

const ruleIds = (c: AnalysisContext) => {
  const plan = buildGuidedPlan(c);
  return [plan.primary, ...plan.secondary].filter(Boolean).map(r => r!.ruleId);
};
const recOf = (c: AnalysisContext, id: string) => {
  const plan = buildGuidedPlan(c);
  return [plan.primary, ...plan.secondary].find(r => r?.ruleId === id) ?? null;
};
const stateOf = (c: AnalysisContext, key: StepKey) =>
  buildGuidedPlan(c).steps.find(s => s.key === key)?.state;

describe('el paso de contraste', () => {
  it('está en los dos flujos y es opcional: contrastar una sola cosa no enseña nada', () => {
    const def = STEP_DEFINITIONS.find(s => s.key === 'compare')!;
    expect(def.kind).toBe('optional');
    expect(def.appliesTo).toEqual(['cross_section', 'time_series']);
    expect(stateOf(ctx(), 'compare')).toBe('optional');
  });

  it('queda bloqueado mientras no haya un modelo estimado', () => {
    expect(stateOf(ctx({ hasResult: false, estimatedSignature: null }), 'compare')).toBe('blocked');
  });

  it('nunca se convierte en el próximo paso sugerido', () => {
    // Es opcional: aparece por recomendación, no porque el riel lo empuje.
    const plan = buildGuidedPlan(ctx({ comparison: facts({ saved: 2, level: 'direct' }) }));
    expect(plan.nextStep).not.toBe('compare');
  });

  it('no se completa por haber tocado el botón: hace falta que existan dos guardadas', () => {
    const conAck = (comparison: ComparisonFacts | null) => ctx({
      comparison,
      session: {
        mode: 'guided', confirmedType: 'cross_section', acknowledged: ['compare'],
        dismissed: [], decisions: [], estimatedSpecs: ['a'],
      },
    });
    expect(stateOf(conAck(facts({ saved: 1 })), 'compare')).toBe('optional');
    expect(stateOf(conAck(facts({ saved: 2, level: 'direct' })), 'compare')).toBe('done');
  });
});

describe('G11 · especificaciones que se pisan sin dejar rastro', () => {
  it('avisa cuando se probó más de una y no quedó ninguna guardada', () => {
    const rec = recOf(ctx({ comparison: facts() }, ['a', 'b']), 'G11');
    expect(rec).toBeTruthy();
    expect(rec!.title).toContain('2');
    expect(rec!.targetStep).toBe('compare');
    expect(rec!.actions[0].focus).toBe('qb-comparison-save');
  });

  it('se calla con una sola especificación probada', () => {
    expect(ruleIds(ctx({ comparison: facts() }, ['a']))).not.toContain('G11');
  });

  it('se calla una vez que hay dos guardadas: ya no se pierde nada', () => {
    const c = ctx({ comparison: facts({ saved: 2, level: 'direct' }) }, ['a', 'b']);
    expect(ruleIds(c)).not.toContain('G11');
  });

  it('sigue avisando con una sola guardada, y lo dice distinto', () => {
    const rec = recOf(ctx({ comparison: facts({ saved: 1 }) }, ['a', 'b']), 'G11');
    expect(rec).toBeTruthy();
    expect(rec!.body).toContain('una guardada');
  });

  it('nombra el p-hacking en vez de sugerir que se elija la corrida que guste', () => {
    const rec = recOf(ctx({ comparison: facts() }, ['a', 'b']), 'G11');
    expect(rec!.why).toContain('no se replican');
  });
});

describe('G12 · comparabilidad dictaminada por el motor', () => {
  const bloqueado = facts({
    saved: 2, level: 'incompatible',
    blocking: ['La variable dependiente no es la misma en todos los modelos.'],
  });
  const cautela = facts({
    saved: 2, level: 'caution',
    cautions: ['La cantidad de observaciones difiere entre modelos.'],
  });

  it('reproduce el motivo del motor sin reescribirlo', () => {
    const rec = recOf(ctx({ comparison: bloqueado }), 'G12');
    expect(rec!.body).toBe('La variable dependiente no es la misma en todos los modelos.');
  });

  it('distingue bloqueado de cautela en el título y en el porqué', () => {
    const bloqueada = recOf(ctx({ comparison: bloqueado }), 'G12')!;
    const conCautela = recOf(ctx({ comparison: cautela }), 'G12')!;
    expect(bloqueada.title).toContain('no se pueden comparar');
    expect(bloqueada.why).toContain('no los vuelve comparables');
    expect(conCautela.title).toContain('cautela');
    expect(conCautela.body).toBe('La cantidad de observaciones difiere entre modelos.');
  });

  it('no dice nada cuando la comparación es directa', () => {
    expect(ruleIds(ctx({ comparison: facts({ saved: 2, level: 'direct' }) }))).not.toContain('G12');
  });

  it('no dice nada con menos de dos guardadas', () => {
    expect(ruleIds(ctx({ comparison: facts({ saved: 1 }) }))).not.toContain('G12');
  });
});

describe('G13 · la significancia depende de la especificación', () => {
  const flip = facts({ saved: 2, level: 'direct', significanceFlips: ['educacion'] });

  it('nombra el coeficiente que cruza el umbral', () => {
    const rec = recOf(ctx({ comparison: flip }), 'G13')!;
    expect(rec.body).toContain('educacion');
    expect(rec.body).toContain('5%');
  });

  it('concuerda el texto cuando son varios', () => {
    const varios = facts({ saved: 2, level: 'direct', significanceFlips: ['educacion', 'edad'] });
    const rec = recOf(ctx({ comparison: varios }), 'G13')!;
    expect(rec.title).toContain('coeficientes que cambian');
    expect(rec.body).toContain('cruzan');
  });

  it('lo explica como fragilidad de la conclusión, no como menú', () => {
    expect(recOf(ctx({ comparison: flip }), 'G13')!.why).toContain('p-hacking');
  });

  it('la comparabilidad se lee antes que el cambio de significancia', () => {
    // Si los modelos no están en la misma escala, un cambio de significancia
    // entre ellos no significa nada: G12 tiene que enmarcar primero.
    const ambas = facts({
      saved: 2, level: 'caution',
      cautions: ['Las formas funcionales difieren.'],
      significanceFlips: ['educacion'],
    });
    const ids = ruleIds(ctx({ comparison: ambas }));
    expect(ids.indexOf('G12')).toBeLessThan(ids.indexOf('G13'));
  });

  it('sin cambios de significancia no aparece', () => {
    expect(ruleIds(ctx({ comparison: facts({ saved: 2, level: 'direct' }) }))).not.toContain('G13');
  });
});

describe('el contraste no corona ganadores', () => {
  const escenarios = [
    facts({ saved: 2, level: 'direct' }),
    facts({ saved: 2, level: 'caution', cautions: ['Difieren las formas funcionales.'] }),
    facts({ saved: 2, level: 'incompatible', blocking: ['Cambia la variable dependiente.'] }),
    facts({ saved: 2, level: 'direct', significanceFlips: ['educacion'] }),
  ];

  it('ninguna recomendación elige un modelo ni invoca el R² como criterio', () => {
    for (const comparison of escenarios) {
      for (const rec of [buildGuidedPlan(ctx({ comparison })).primary, ...buildGuidedPlan(ctx({ comparison })).secondary]) {
        if (!rec) continue;
        const texto = `${rec.title} ${rec.body} ${rec.why}`.toLowerCase();
        for (const prohibido of ['mejor modelo', 'peor modelo', 'ganador', 'r² más alto', 'quedate con']) {
          expect(texto).not.toContain(prohibido);
        }
      }
    }
  });

  it('las reglas de contraste explican, no sentencian', () => {
    for (const id of ['G11', 'G12', 'G13']) {
      const rule = GUIDED_RULES.find(r => r.id === id)!;
      expect(rule.targetStep).toBe('compare');
      // Consejo, nunca bloqueo: contrastar es una decisión del estudiante.
      expect(rule.kind).toBe('advisory');
    }
  });
});

describe('memoria de especificaciones estimadas', () => {
  beforeEach(() => resetSessionForTests());

  it('cuenta especificaciones distintas, no corridas', () => {
    recordEstimation(sig());
    recordEstimation(sig());
    expect(getSession().estimatedSpecs).toHaveLength(1);
    recordEstimation(sig({ xNames: 'educacion' }));
    expect(getSession().estimatedSpecs).toHaveLength(2);
  });

  it('cambiar los errores estándar no es probar otra especificación', () => {
    // No mueve los coeficientes: es otra inferencia sobre el mismo modelo.
    recordEstimation(sig());
    recordEstimation(sig({ seType: 'HC3' }));
    expect(getSession().estimatedSpecs).toHaveLength(1);
  });

  it('un dataset nuevo empieza la cuenta de cero', () => {
    recordEstimation(sig());
    recordEstimation(sig({ form: 'log-lin' }));
    resetForNewDataset('otro.csv');
    expect(getSession().estimatedSpecs).toEqual([]);
  });
});
