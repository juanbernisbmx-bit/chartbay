// Lo que el panel NO puede mostrar mientras la pregunta esté abierta.
//
// Es la garantía central del modo: si la recomendación, el riel o el contador
// de sugerencias se filtran, el estudiante contesta leyendo la respuesta y el
// modo no practica nada. Un test de presencia no alcanza — hay que verificar
// la ausencia.

import { beforeEach, describe, expect, it } from 'vitest';
import { appState } from '../../src/app/state';
import { buildAnalysisContext } from '../../src/guided/context';
import { buildGuidedPlan } from '../../src/guided/planner';
import { buildPracticeQuestion } from '../../src/guided/practice';
import { renderGuided } from '../../src/ui/guidedView';
import {
  answerPractice, confirmAnalysisType, getSession, resetSessionForTests, setMode,
} from '../../src/guided/session';
import { clearStoredMode } from '../../src/guided/persistence';
import { resetComparisonStore } from '../../src/modelComparison/store';

const panel = () => document.getElementById('qb-guided')?.innerHTML ?? '';
const plan = () => buildGuidedPlan(buildAnalysisContext());
const question = () => buildPracticeQuestion(plan())!;

beforeEach(() => {
  document.body.innerHTML = `
    <span id="qb-filename">datos.csv</span>
    <select id="qb-y"><option value="salario" selected>salario</option></select>
    <input class="qb-x-cb" type="checkbox" value="educacion" checked>
    <input class="qb-x-cb" type="checkbox" value="experiencia" checked>
    <select id="qb-form"><option value="lin-lin" selected>lin-lin</option></select>
    <section id="qb-guided"></section>`;
  appState.csvData = {
    headers: ['salario', 'educacion', 'experiencia'],
    rows: [{ salario: 1, educacion: 2, experiencia: 3 }],
    numericColumns: ['salario', 'educacion', 'experiencia'],
    rowCount: 140,
  };
  appState.lastResult = null;
  appState.lastTimeSeriesResult = null;
  appState.activeMode = 'regression';
  appState.activeVersion = 'lite';
  resetSessionForTests();
  resetComparisonStore();
  clearStoredMode();
  setMode('practice');
  confirmAnalysisType('cross_section', 'cross_section');
});

describe('con la pregunta abierta la guía no adelanta nada', () => {
  it('no muestra el cuerpo ni el porqué de la recomendación retenida', () => {
    const recommendation = plan().primary!;
    renderGuided();

    const html = panel();
    expect(html).toContain('¿Qué conviene hacer ahora?');
    expect(html).not.toContain(recommendation.body);
    expect(html).not.toContain(recommendation.why);
  });

  it('tampoco el título, cuando la recomendación la emitió una regla', () => {
    // Sin regla, la recomendación ES el prompt del paso, así que su título es
    // legítimamente el texto de una de las opciones. Con una regla en juego el
    // título es propio y no puede aparecer en ningún lado.
    appState.csvData = {
      headers: ['salario', 'educacion', 'experiencia'],
      rows: [
        { salario: 1, educacion: 2, experiencia: 3 },
        { salario: 2, educacion: '', experiencia: 4 },
      ],
      numericColumns: ['salario', 'educacion', 'experiencia'],
      rowCount: 2,
    };
    const recommendation = plan().primary!;
    expect(recommendation.ruleId).toBe('G01');
    renderGuided();

    const html = panel();
    expect(html).toContain('¿Qué conviene hacer ahora?');
    expect(html).not.toContain(recommendation.title);
    expect(html).not.toContain(recommendation.body);
    expect(html).not.toContain(recommendation.why);
  });

  it('no dibuja el riel: el chip "siguiente" contestaría solo', () => {
    renderGuided();
    expect(panel()).not.toContain('qb-g-steps');
  });

  it('no dibuja el contador de sugerencias, que adelanta cuánto falta', () => {
    renderGuided();
    expect(panel()).not.toContain('qb-g-more');
  });

  it('ofrece las opciones como botones, sin marcar cuál es', () => {
    const q = question();
    renderGuided();

    const html = panel();
    for (const option of q.options) {
      expect(html).toContain(`data-practice-step="${option.step}"`);
      expect(html).toContain(option.title);
    }
    // Nada en el marcado distingue a la recomendada de las demás.
    expect(html).not.toContain('recommended');
    expect(html).not.toContain(`data-practice-step="${q.options[0].step}" class="is-`);
  });
});

describe('una vez contestada, la guía muestra todo', () => {
  beforeEach(() => {
    const q = question();
    answerPractice(q.id, q.recommended, 'la opción recomendada');
  });

  it('revela la recomendación con su porqué', () => {
    const recommendation = plan().primary!;
    renderGuided();

    const html = panel();
    expect(html).toContain(recommendation.title);
    expect(html).toContain(recommendation.why);
    expect(html).not.toContain('¿Qué conviene hacer ahora?');
  });

  it('devuelve el riel para que se vea dónde está parado', () => {
    renderGuided();
    expect(panel()).toContain('qb-g-steps');
  });

  it('coincidir no se presenta como haber validado el análisis', () => {
    renderGuided();
    expect(panel()).toContain('Coincidir no valida el análisis');
  });
});

describe('elegir distinto no se trata como un error', () => {
  it('explica para qué sirve el paso elegido en vez de corregir', () => {
    const q = question();
    const otra = q.options.find(o => o.step !== q.recommended)!;
    answerPractice(q.id, otra.step, otra.title);
    renderGuided();

    const html = panel();
    expect(html).toContain('No es un error');
    expect(html).not.toContain('Incorrecto');
    expect(html).not.toContain('Respuesta correcta');
  });
});

describe('los otros modos no preguntan nada', () => {
  it('guiado muestra la recomendación de una', () => {
    setMode('guided');
    const recommendation = plan().primary!;
    renderGuided();

    const html = panel();
    expect(html).toContain(recommendation.title);
    expect(html).not.toContain('¿Qué conviene hacer ahora?');
  });

  it('libre sigue callado y sin preguntas', () => {
    setMode('free');
    renderGuided();
    expect(panel()).not.toContain('¿Qué conviene hacer ahora?');
  });

  it('la respuesta dada en práctica queda en el registro', () => {
    const q = question();
    answerPractice(q.id, q.recommended, 'Estimá el modelo');
    setMode('guided');
    renderGuided();

    expect(panel()).toContain('Respondiste Estimá el modelo');
    expect(getSession().decisions.some(d => d.kind === 'practice_answer')).toBe(true);
  });
});
