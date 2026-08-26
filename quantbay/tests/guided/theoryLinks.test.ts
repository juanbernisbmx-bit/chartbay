// Ningún link de teoría puede apuntar a una sección que no existe.
//
// La guía se escribió con ids en prosa ('OLS', 't y p-value') mientras que las
// anclas de guia.html son 'teoria-ols', 'teoria-inferencia'. Los links se veían
// bien y no llevaban a ninguna parte — el modo de falla más silencioso posible,
// porque nada tira error: el navegador simplemente no encuentra el ancla.
//
// Este test lee la plantilla del disco, como learnContent.test.ts, porque
// guia.html es un template de Flask fuera del bundler.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appState } from '../../src/app/state';
import { GUIDED_RULES } from '../../src/guided/rules';
import { STEP_DEFINITIONS } from '../../src/guided/steps';
import {
  acknowledgeStep, confirmAnalysisType, noteDoctorReport, recordEstimation,
  resetForNewDataset, resetSessionForTests,
} from '../../src/guided/session';
import { renderGuided } from '../../src/ui/guidedView';
import { resetComparisonStore } from '../../src/modelComparison/store';
import type { DoctorFinding, DoctorReport } from '../../src/modelDoctor/types';

const SRC = join(__dirname, '..', '..', 'src');
const GUIA_HTML = readFileSync(
  join(__dirname, '..', '..', '..', 'web', 'templates', 'guia.html'),
  'utf8'
);

/** Ids que guia.html expone realmente como destino de un link. */
const ANCHORS = new Set(
  Array.from(GUIA_HTML.matchAll(/id="(teoria-[a-z-]+)"/g)).map(m => m[1])
);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

/** Cada `'teoria-…'` escrito en el código, con el archivo donde aparece. */
function referencedIds(): Array<{ id: string; file: string }> {
  const found: Array<{ id: string; file: string }> = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/'(teoria-[a-z-]+)'/g)) {
      found.push({ id: match[1], file });
    }
  }
  return found;
}

describe('las anclas de teoría existen', () => {
  it('guia.html expone secciones para linkear', () => {
    expect(ANCHORS.size).toBeGreaterThan(10);
    expect(ANCHORS.has('teoria-ols')).toBe(true);
  });

  it('ningún id citado en el código quedó colgado', () => {
    const colgados = referencedIds()
      .filter(ref => !ANCHORS.has(ref.id))
      .map(ref => `${ref.id} (${ref.file.replace(SRC, 'src')})`);
    expect(colgados).toEqual([]);
  });
});

describe('la guía cita teoría con el vocabulario de guia.html', () => {
  const idsDeLaGuia = [
    ...STEP_DEFINITIONS.flatMap(def => def.theory),
    // Las reglas que heredan de Model Doctor arman su teoría desde el informe,
    // no desde un literal, así que acá solo se ven las escritas a mano.
    ...GUIDED_RULES.flatMap(rule => {
      try {
        return rule.build({} as never).theory;
      } catch {
        return [];
      }
    }),
  ];

  it('usa ids de ancla y no nombres en prosa', () => {
    for (const id of idsDeLaGuia) {
      expect(id).toMatch(/^teoria-[a-z-]+$/);
    }
  });

  it('todos apuntan a una sección que existe', () => {
    for (const id of idsDeLaGuia) {
      expect(ANCHORS.has(id), `${id} no existe en guia.html`).toBe(true);
    }
  });

  it('cubre lo que la guía enseña, no una sola sección', () => {
    expect(new Set(idsDeLaGuia).size).toBeGreaterThan(5);
  });
});

describe('la etiqueta del link se lee, no se muestra el id', () => {
  /** Informe mínimo con un hallazgo que arrastra su propia teoría. */
  function reportWith(theory: Array<{ id: string; label: string }>): DoctorReport {
    const finding: DoctorFinding = {
      category: 'heteroskedasticity', state: 'problem', impact: 'inference',
      evidence: 'moderate', confidence: 'medium', headlineText: 'titular',
      detail: {
        evidence: [], conclusion: 'conclusión', whyItMatters: 'por qué importa',
        whatToCheck: [{ text: 'revisar' }], whatItDoesNot: [], confidenceNote: '', theory,
      },
      sources: [], appliedRules: [],
    };
    return {
      overallState: 'review', headline: finding, findings: [finding],
      coverage: { evaluated: 1, applicable: 1, skipped: [] }, limits: [], flow: 'cross-section',
    };
  }

  function render(theory: Array<{ id: string; label: string }>): string {
    document.body.innerHTML = `
      <span id="qb-filename">datos.csv</span>
      <select id="qb-y"><option value="salario" selected>salario</option></select>
      <input class="qb-x-cb" type="checkbox" value="educacion" checked>
      <select id="qb-form"><option value="lin-lin" selected>lin-lin</option></select>
      <section id="qb-guided"></section>`;
    appState.csvData = {
      headers: ['salario', 'educacion'], rows: [{ salario: 1, educacion: 2 }],
      numericColumns: ['salario', 'educacion'], rowCount: 140,
    };
    appState.lastResult = null;
    appState.lastTimeSeriesResult = null;
    appState.activeMode = 'regression';
    appState.activeVersion = 'lite';
    resetSessionForTests();
    resetComparisonStore();
    resetForNewDataset('datos.csv');
    confirmAnalysisType('cross_section', 'cross_section');
    acknowledgeStep('readCoefficients', 'coeficientes');
    recordEstimation({
      dataset: 'datos.csv', yName: 'salario', xNames: 'educacion', form: 'lin-lin',
      seType: 'classic', dropIncomplete: false, restriction: '', transformation: '', arimaOrders: '',
    });
    noteDoctorReport(reportWith(theory));
    renderGuided();
    return document.getElementById('qb-guided')?.innerHTML ?? '';
  }

  it('deriva un nombre legible para los ids que hereda de Model Doctor', () => {
    const html = render([{ id: 'teoria-heterocedasticidad', label: 'heterocedasticidad' }]);
    expect(html).toContain('/guia#teoria-heterocedasticidad');
    expect(html).toContain('>heterocedasticidad</a>');
    // El id crudo como texto del link era lo que se veía antes.
    expect(html).not.toContain('>teoria-heterocedasticidad</a>');
  });

  it('mantiene las siglas en mayúscula en vez de derivarlas', () => {
    const html = render([{ id: 'teoria-vif', label: 'vif' }]);
    expect(html).toContain('>VIF</a>');
  });
});
