// El contexto contra el módulo de comparación de verdad.
//
// Los tests de reglas inyectan ComparisonFacts a mano; acá se verifica la
// costura: que la guía lea el store real y reproduzca el dictamen del motor
// en vez de sacar uno propio.

import { beforeEach, describe, expect, it } from 'vitest';
import { appState } from '../../src/app/state';
import { buildAnalysisContext } from '../../src/guided/context';
import { getSession, resetSessionForTests } from '../../src/guided/session';
import { initGuided, resetGuidedViewForTests } from '../../src/ui/guidedView';
import {
  getComparisonStoreState,
  removeComparisonModel,
  resetComparisonStore,
  saveCurrentComparisonModel,
  setCurrentComparisonModel,
  startComparisonDataset,
} from '../../src/modelComparison/store';
import type { ModelSnapshot } from '../../src/modelComparison/types';

interface Coef { name: string; estimate: number; pValue: number }

function snapshot(over: {
  y?: string;
  scale?: 'level' | 'log';
  nObs?: number;
  coefficients?: Coef[];
} = {}): ModelSnapshot {
  const coefficients = over.coefficients ?? [{ name: 'educacion', estimate: 0.8, pValue: 0.01 }];
  return {
    id: '', name: undefined, createdAt: '', datasetId: '',
    specification: {
      flow: 'cross-section', family: 'linear', engine: 'lite',
      dependentVariable: over.y ?? 'salario',
      outcomeScale: over.scale ?? 'level',
      regressors: coefficients.map(c => c.name),
      functionalForm: 'lin-lin', estimationMethod: 'OLS', standardErrorType: 'classic',
      hasIntercept: true, categoricalBaseCategories: {},
    },
    coefficients: coefficients.map(c => ({
      key: c.name, name: c.name, estimate: c.estimate, stdError: 0.1,
      statistic: null, pValue: c.pValue, confidenceInterval: null, isIntercept: false,
    })),
    metrics: {
      nObs: over.nObs ?? 140, regressorCount: coefficients.length,
      rSquared: 0.5, adjustedRSquared: 0.48, fStatistic: null, fPValue: null, aic: null, bic: null,
    },
    interpretation: [],
    doctor: {
      overallState: 'clear', headline: null, findings: [],
      coverage: { evaluated: 0, applicable: 0, skipped: [] }, limits: [], flow: 'cross-section',
    },
    warnings: [],
  };
}

function save(over: Parameters<typeof snapshot>[0] = {}, name?: string): void {
  setCurrentComparisonModel(snapshot(over));
  saveCurrentComparisonModel(name);
}

const comparison = () => buildAnalysisContext().comparison;

beforeEach(() => {
  document.body.innerHTML = '';
  // Antes de tocar el store: resetearlo emite, y un observador con memoria
  // vieja anotaría bajas que el estudiante nunca hizo.
  resetGuidedViewForTests();
  appState.csvData = null;
  appState.lastResult = null;
  appState.lastTimeSeriesResult = null;
  appState.activeMode = 'regression';
  appState.activeVersion = 'lite';
  resetSessionForTests();
  resetComparisonStore();
  startComparisonDataset('datos.csv');
});

describe('el contexto lee el store de comparación', () => {
  it('sin nada guardado ni nada para guardar, no hay hechos de contraste', () => {
    expect(comparison()).toBeNull();
  });

  it('una estimación en pantalla cuenta como pendiente de guardar', () => {
    setCurrentComparisonModel(snapshot());
    const facts = comparison()!;
    expect(facts.saved).toBe(0);
    expect(facts.currentUnsaved).toBe(true);
    // Con menos de dos no se dictamina nada: no hay contra qué comparar.
    expect(facts.level).toBeNull();
  });

  it('con una sola guardada todavía no hay dictamen', () => {
    save();
    const facts = comparison()!;
    expect(facts.saved).toBe(1);
    expect(facts.level).toBeNull();
  });

  it('dos modelos equivalentes dan comparación directa y sin advertencias', () => {
    save();
    save();
    const facts = comparison()!;
    expect(facts.saved).toBe(2);
    expect(facts.level).toBe('direct');
    expect(facts.blocking).toEqual([]);
    expect(facts.cautions).toEqual([]);
  });

  it('cambiar la variable dependiente bloquea, con el texto del motor', () => {
    save();
    save({ y: 'ingreso' });
    const facts = comparison()!;
    expect(facts.level).toBe('incompatible');
    expect(facts.blocking).toHaveLength(1);
    expect(facts.blocking[0]).toContain('variable dependiente');
    expect(facts.cautions).toEqual([]);
  });

  it('una muestra distinta pide cautela sin bloquear', () => {
    save();
    save({ nObs: 120 });
    const facts = comparison()!;
    expect(facts.level).toBe('caution');
    expect(facts.blocking).toEqual([]);
    expect(facts.cautions.join(' ')).toContain('observaciones');
  });

  it('detecta el coeficiente que cambia de significancia entre modelos', () => {
    save({ coefficients: [{ name: 'educacion', estimate: 0.8, pValue: 0.01 }] });
    save({
      coefficients: [
        { name: 'educacion', estimate: 0.3, pValue: 0.30 },
        { name: 'experiencia', estimate: 0.5, pValue: 0.02 },
      ],
    });
    expect(comparison()!.significanceFlips).toContain('educacion');
  });

  it('no reporta cambios de significancia cuando los modelos no son comparables', () => {
    // El motor apaga compareCoefficients y la guía no debe inventar el dato.
    save({ coefficients: [{ name: 'educacion', estimate: 0.8, pValue: 0.01 }] });
    save({ y: 'ingreso', coefficients: [{ name: 'educacion', estimate: 0.3, pValue: 0.30 }] });
    const facts = comparison()!;
    expect(facts.level).toBe('incompatible');
    expect(facts.significanceFlips).toEqual([]);
  });
});

describe('el registro anota lo que se guarda para contrastar', () => {
  beforeEach(() => {
    document.body.innerHTML = '<section id="qb-guided"></section>';
    initGuided();
  });

  it('anota el alta con el nombre que le puso el estudiante', () => {
    save({}, 'Base');
    const decisions = getSession().decisions.filter(d => d.kind === 'compare_models');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].summary).toBe('Guardaste Base para comparar');
  });

  it('anota también la baja: descartar un modelo es una decisión', () => {
    save({}, 'Base');
    const id = getComparisonStoreState().saved[0].id;
    removeComparisonModel(id);
    const summaries = getSession().decisions
      .filter(d => d.kind === 'compare_models')
      .map(d => d.summary);
    expect(summaries).toEqual(['Guardaste Base para comparar', 'Quitaste Base de la comparación']);
  });

  it('no anota nada cuando el store emite sin cambiar los guardados', () => {
    // Renombrar, empezar un dataset o capturar el modelo actual también emiten.
    setCurrentComparisonModel(snapshot());
    startComparisonDataset('otro.csv');
    expect(getSession().decisions.filter(d => d.kind === 'compare_models')).toHaveLength(0);
  });
});
