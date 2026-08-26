import { beforeEach, describe, expect, it } from 'vitest';
import { buildGuidedPlan } from '../../src/guided/planner';
import { buildPracticeQuestion, buildPracticeReveal, MAX_PRACTICE_OPTIONS } from '../../src/guided/practice';
import { STEP_DEFINITIONS, stepDefinition } from '../../src/guided/steps';
import {
  answerPractice, getPracticeAnswer, getSession, resetForNewDataset, resetSessionForTests, setMode,
} from '../../src/guided/session';
import { clearStoredMode, loadStoredMode } from '../../src/guided/persistence';
import { useMemoryStorage } from './memoryStorage';
import type {
  AnalysisContext, CurrentSpec, DatasetProfile, GuidedPlan, SpecSignature, StepKey,
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
function dataset(over: Partial<DatasetProfile> = {}): DatasetProfile {
  return {
    name: 'datos.csv', rows: 140, columns: 4,
    numericColumns: ['salario', 'educacion', 'experiencia'], categoricalColumns: [],
    hasDates: false, missingByColumn: {}, constantColumns: [], warnings: [], ...over,
  };
}
function ctx(over: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    mode: 'regression', engine: 'lite', dataset: dataset(), raw: null, spec: spec(),
    estimatedSignature: sig(), hasResult: true, timeSeries: null, doctor: null, comparison: null,
    session: {
      mode: 'practice', confirmedType: 'cross_section', acknowledged: [], dismissed: [],
      decisions: [], estimatedSpecs: ['a'],
    },
    ...over,
  };
}

const planOf = (over: Partial<AnalysisContext> = {}): GuidedPlan => buildGuidedPlan(ctx(over));

beforeEach(() => {
  useMemoryStorage();
  resetSessionForTests();
  clearStoredMode();
});

describe('la pregunta sale del plan, no de un catálogo aparte', () => {
  it('pregunta por el paso que la guía iba a recomendar', () => {
    const plan = planOf();
    const question = buildPracticeQuestion(plan)!;
    expect(question).toBeTruthy();
    expect(question.recommended).toBe(plan.primary!.targetStep);
    expect(question.options.map(o => o.step)).toContain(plan.primary!.targetStep);
  });

  it('su identidad es la de la recomendación retenida', () => {
    // Mientras la guía siga recomendando lo mismo, es la misma pregunta.
    const plan = planOf();
    expect(buildPracticeQuestion(plan)!.id).toBe(plan.primary!.id);
  });

  it('usa los textos del catálogo y no inventa consignas nuevas', () => {
    for (const option of buildPracticeQuestion(planOf())!.options) {
      expect(option.title).toBe(stepDefinition(option.step).prompt.title);
    }
  });

  it('no ofrece más opciones de las que se pueden leer', () => {
    const question = buildPracticeQuestion(planOf())!;
    expect(question.options.length).toBeLessThanOrEqual(MAX_PRACTICE_OPTIONS);
    expect(question.options.length).toBeGreaterThan(1);
  });

  it('no ofrece pasos ya completados ni los que no aplican', () => {
    const plan = planOf();
    const question = buildPracticeQuestion(plan)!;
    for (const option of question.options) {
      const step = plan.steps.find(s => s.key === option.step)!;
      expect(step.state).not.toBe('done');
      expect(step.state).not.toBe('not_applicable');
    }
  });

  it('es determinística: mismo plan, misma pregunta', () => {
    const a = buildPracticeQuestion(planOf())!;
    const b = buildPracticeQuestion(planOf())!;
    expect(a.id).toBe(b.id);
    expect(a.options.map(o => o.step)).toEqual(b.options.map(o => o.step));
  });

  it('la respuesta no cae siempre en la misma posición', () => {
    // Si estuviera siempre primera, se acertaría sin leer.
    const posiciones = new Set<number>();
    for (const over of [
      {}, { dataset: null, spec: null, hasResult: false, estimatedSignature: null },
      { session: { mode: 'practice' as const, confirmedType: 'cross_section' as const,
        acknowledged: ['readCoefficients'] as StepKey[], dismissed: [], decisions: [], estimatedSpecs: [] } },
    ]) {
      const plan = planOf(over);
      const q = buildPracticeQuestion(plan);
      if (q) posiciones.add(q.options.findIndex(o => o.step === q.recommended));
    }
    expect(posiciones.size).toBeGreaterThan(1);
  });

  it('sin recomendación no hay pregunta', () => {
    const plan = planOf();
    expect(buildPracticeQuestion({ ...plan, primary: null })).toBeNull();
  });

  it('no pregunta por un paso que ya está hecho', () => {
    const plan = planOf();
    const steps = plan.steps.map(s =>
      s.key === plan.primary!.targetStep ? { ...s, state: 'done' as const } : s);
    expect(buildPracticeQuestion({ ...plan, steps })).toBeNull();
  });

  it('con una sola opción posible no pregunta nada', () => {
    const plan = planOf();
    const single = plan.steps.filter(s => s.key === plan.primary!.targetStep);
    expect(buildPracticeQuestion({ ...plan, steps: single })).toBeNull();
  });
});

describe('la devolución contrasta, no corrige', () => {
  it('muestra la recomendación retenida tal como la emitió la regla', () => {
    const plan = planOf();
    const question = buildPracticeQuestion(plan)!;
    const reveal = buildPracticeReveal(plan, question, question.recommended)!;
    expect(reveal.matched).toBe(true);
    expect(reveal.recommendedTitle).toBe(plan.primary!.title);
    expect(reveal.recommendedBody).toBe(plan.primary!.body);
    expect(reveal.recommendedWhy).toBe(plan.primary!.why);
  });

  it('con otra elección explica para qué sirve ese paso, con el texto del catálogo', () => {
    const plan = planOf();
    const question = buildPracticeQuestion(plan)!;
    const otra = question.options.find(o => o.step !== question.recommended)!;
    const reveal = buildPracticeReveal(plan, question, otra.step)!;
    expect(reveal.matched).toBe(false);
    expect(reveal.chosenLabel).toBe(stepDefinition(otra.step).label);
    expect(reveal.chosenWhy).toBe(stepDefinition(otra.step).prompt.why);
  });

  it('si el paso elegido todavía no se puede hacer, dice qué falta', () => {
    // Sin dataset, casi todo está bloqueado y el motivo es un hecho, no un juicio.
    const plan = planOf({ dataset: null, spec: null, hasResult: false, estimatedSignature: null });
    const question = buildPracticeQuestion(plan)!;
    const bloqueado = plan.steps.find(s => s.state === 'blocked' && s.unmet.length > 0)!;
    const reveal = buildPracticeReveal(plan, question, bloqueado.key)!;
    expect(reveal.chosenBlocked).toBe(bloqueado.unmet[0].describe);
  });

  it('un paso disponible no se reporta como bloqueado', () => {
    const plan = planOf();
    const question = buildPracticeQuestion(plan)!;
    expect(buildPracticeReveal(plan, question, question.recommended)!.chosenBlocked).toBeNull();
  });
});

describe('respuestas registradas', () => {
  it('se guardan por pregunta y quedan en el registro de decisiones', () => {
    answerPractice('G03', 'inference', 'Revisá la inferencia');
    expect(getPracticeAnswer('G03')).toBe('inference');
    const decision = getSession().decisions.find(d => d.kind === 'practice_answer')!;
    expect(decision.summary).toBe('Respondiste Revisá la inferencia');
    expect(decision.fromRecommendation).toBe('G03');
  });

  it('la primera respuesta manda: no se puede contestar dos veces la misma', () => {
    answerPractice('G03', 'inference', 'Revisá la inferencia');
    answerPractice('G03', 'diagnostics', 'Revisá los diagnósticos');
    expect(getPracticeAnswer('G03')).toBe('inference');
    expect(getSession().decisions.filter(d => d.kind === 'practice_answer')).toHaveLength(1);
  });

  it('una pregunta sin contestar no tiene respuesta', () => {
    expect(getPracticeAnswer('G10')).toBeNull();
  });

  it('un dataset nuevo borra las respuestas', () => {
    // Si sobrevivieran, el id volvería a aparecer con la devolución ya abierta.
    answerPractice('G03', 'inference', 'Revisá la inferencia');
    resetForNewDataset('otro.csv');
    expect(getPracticeAnswer('G03')).toBeNull();
  });
});

describe('práctica como tercer modo', () => {
  it('se persiste y se restaura igual que libre', () => {
    setMode('practice');
    expect(loadStoredMode()).toBe('practice');
    expect(getSession().mode).toBe('practice');
  });

  it('queda anotado el cambio, diciendo qué implica', () => {
    setMode('practice');
    const decision = getSession().decisions.find(d => d.kind === 'set_mode')!;
    expect(decision.summary).toContain('pregunta antes de recomendar');
  });

  it('no cambia el plan: práctica es presentación, no otro motor', () => {
    const guiado = buildGuidedPlan(ctx({
      session: {
        mode: 'guided', confirmedType: 'cross_section', acknowledged: [], dismissed: [],
        decisions: [], estimatedSpecs: ['a'],
      },
    }));
    const practica = planOf();
    expect(practica.primary?.id).toBe(guiado.primary?.id);
    expect(practica.nextStep).toBe(guiado.nextStep);
    expect(practica.steps.map(s => s.state)).toEqual(guiado.steps.map(s => s.state));
  });
});

describe('cada paso puede ser una opción legible', () => {
  it('todos los pasos del catálogo tienen un título usable como opción', () => {
    for (const def of STEP_DEFINITIONS) {
      expect(def.prompt.title.length).toBeGreaterThan(10);
    }
  });
});
