import { appState } from '../app/state';
import { parseRLSRestriction } from '../rlsParser';
import type { RLSConstraint } from '../rls';
import { escapeHtml } from '../utils/format';
import { downloadTextFile } from './exports';
import {
  generateActionSnippet,
  generateReproducibilityArtifact,
  REPRODUCIBILITY_LANGUAGE_META,
} from '../reproducibility/generator';
import type {
  ReproducibilityAction,
  ReproducibilityCategoricalEncoding,
  ReproducibilityLanguage,
  ReproducibilityRestriction,
  ReproducibilitySpec,
} from '../reproducibility/types';

const languages: ReproducibilityLanguage[] = ['r', 'python', 'stata', 'notebook'];
const history: ReproducibilityAction[] = [];
let nextActionId = 1;
let activeLanguage: ReproducibilityLanguage = 'python';
let lastExecutedSpec: ReproducibilitySpec | null = null;
let lastExecutedKey = '';

function elementValue(id: string, fallback = ''): string {
  const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  return element?.value ?? fallback;
}

function integerValue(id: string, fallback: number): number {
  const value = Number(elementValue(id));
  return Number.isInteger(value) ? value : fallback;
}

function checked(id: string): boolean {
  return (document.getElementById(id) as HTMLInputElement | null)?.checked ?? false;
}

function selectedXNames(yName: string): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('.qb-x-cb:checked'))
    .map(input => input.value)
    .filter(name => name !== yName);
}

function categoricalEncodings(xNames: string[]): ReproducibilityCategoricalEncoding[] {
  const selected = new Set(xNames);
  return appState.lastCategoricalInfo
    .filter(info => selected.has(info.originalName))
    .map(info => ({
      source: info.originalName,
      baseCategory: info.baseCategory,
      categories: [...info.categories],
      dummyNames: [...info.createdDummies],
    }));
}

function expandedNames(
  xNames: string[],
  encodings: ReproducibilityCategoricalEncoding[]
): string[] {
  const bySource = new Map(encodings.map(encoding => [encoding.source, encoding]));
  return xNames.flatMap(name => bySource.get(name)?.dummyNames ?? [name]);
}

function restrictionSpec(expandedXNames: string[]): ReproducibilityRestriction | null {
  const expression = elementValue('qb-rls-input').trim();
  if (!expression || expandedXNames.length === 0) return null;
  const parsed = parseRLSRestriction(expression, expandedXNames);
  if (parsed === '' || typeof parsed === 'string') return null;
  return { expression, R: parsed.R.map(row => [...row]), q: [...parsed.q] };
}

function restrictionFromConstraint(constraint: RLSConstraint): ReproducibilityRestriction {
  return {
    expression: constraint.label,
    R: constraint.R.map(row => [...row]),
    q: [...constraint.q],
  };
}

export function captureReproducibilitySpec(autoRepair = false): ReproducibilitySpec {
  const yName = elementValue('qb-y');
  const xNames = selectedXNames(yName);
  const encodings = categoricalEncodings(xNames);
  const selectedExpandedNames = expandedNames(xNames, encodings);
  const executedFeatureNames = autoRepair && appState.lastResult
    ? appState.lastResult.featureNames.map(name => {
        const match = /^ln\((.*)\)$/.exec(name);
        return match?.[1] ?? name;
      })
    : null;
  const expandedXNames = executedFeatureNames ?? selectedExpandedNames;
  const restriction = autoRepair
    ? appState.lastResult?.method === 'RLS'
      ? restrictionSpec(expandedXNames)
      : null
    : restrictionSpec(selectedExpandedNames);
  const seValue = elementValue('qb-pro-se', 'classic');
  const standardErrorType = seValue === 'HC1' || seValue === 'HC3' || seValue === 'HAC'
    ? seValue
    : 'classic';
  const proTs = appState.activeVersion === 'pro';
  const dateColumn = elementValue(proTs ? 'qb-pro-ts-date' : 'qb-ts-date').trim() || null;
  const valueColumn = elementValue(proTs ? 'qb-pro-ts-value' : 'qb-ts-value');
  const transform = elementValue('qb-ts-transform', 'original');
  const transformation = (
    transform === 'difference' ||
    transform === 'percentReturn' ||
    transform === 'logReturn' ||
    transform === 'base100' ||
    transform === 'movingAverage'
  ) ? transform : 'original';
  const adfValue = elementValue('qb-pro-ts-adf-reg', 'c');
  const adfRegression = adfValue === 'ct' || adfValue === 'ctt' || adfValue === 'n' ? adfValue : 'c';

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    datasetName: appState.datasetName ?? 'dataset.csv',
    mode: appState.activeMode,
    engine: appState.activeVersion,
    regression: {
      yName,
      xNames,
      expandedXNames,
      functionalForm: appState.activeFunctionalForm,
      dropIncompleteRows: checked('qb-drop-incomplete'),
      standardErrorType,
      hacMaxLags: elementValue('qb-pro-hac-lags').trim() === ''
        ? null
        : integerValue('qb-pro-hac-lags', 0),
      categoricalEncodings: encodings,
      restriction,
      autoRepair,
    },
    timeSeries: {
      dateColumn,
      valueColumn,
      transformation,
      movingAverageWindow: integerValue('qb-ts-ma-window', 3),
      maxLag: integerValue(proTs ? 'qb-pro-ts-maxlag' : 'qb-ts-acf-max-lag', 12),
      adfRegression,
      runArima: checked('qb-pro-ts-arima-enable'),
      arimaOrder: {
        p: integerValue('qb-pro-ts-arima-p', 1),
        d: integerValue('qb-pro-ts-arima-d', 0),
        q: integerValue('qb-pro-ts-arima-q', 1),
      },
      forecastSteps: integerValue('qb-pro-ts-forecast-steps', 12),
    },
  };
}

function stableSpecKey(spec: ReproducibilitySpec): string {
  return JSON.stringify({ ...spec, generatedAt: '' });
}

function currentSpec(): ReproducibilitySpec {
  return captureReproducibilitySpec();
}

function renderHistory(): void {
  const container = document.getElementById('qb-repro-history');
  if (!container) return;
  if (history.length === 0) {
    container.innerHTML = '<p class="muted qb-repro-empty">Tus acciones analíticas aparecerán acá con su traducción a código.</p>';
    return;
  }
  container.innerHTML = history.slice().reverse().map(action => `
    <article class="qb-repro-event">
      <div class="qb-repro-event-head">
        <strong>${escapeHtml(action.label)}</strong>
        <time>${escapeHtml(new Date(action.timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</time>
      </div>
      <pre><code>${escapeHtml(generateActionSnippet(action, activeLanguage))}</code></pre>
    </article>
  `).join('');
}

function renderPreview(): void {
  const preview = document.getElementById('qb-repro-code');
  const status = document.getElementById('qb-repro-status');
  if (!preview || !status) return;
  const spec = currentSpec();
  const isExecuted = lastExecutedSpec !== null && stableSpecKey(spec) === lastExecutedKey;
  const previewSpec = isExecuted ? lastExecutedSpec! : spec;
  const comment = activeLanguage === 'stata' ? '*' : '#';
  preview.textContent = appState.datasetName
    ? generateReproducibilityArtifact(previewSpec, activeLanguage)
    : `${comment} Cargá un dataset para construir una receta ejecutable de ChartBay.\n`;
  status.textContent = isExecuted
    ? 'RECETA EJECUTADA · LISTA PARA DESCARGAR'
    : lastExecutedSpec
      ? 'BORRADOR MODIFICADO · LA DESCARGA CONSERVA LA ÚLTIMA EJECUCIÓN'
      : 'BORRADOR · EJECUTÁ EL ANÁLISIS PARA HABILITAR DESCARGAS';
  status.dataset.state = isExecuted ? 'executed' : 'draft';

  for (const language of languages) {
    const button = document.querySelector<HTMLButtonElement>(`[data-repro-download="${language}"]`);
    if (button) button.disabled = !lastExecutedSpec;
  }
}

function render(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-repro-language]').forEach(button => {
    const isActive = button.dataset.reproLanguage === activeLanguage;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  });
  renderHistory();
  renderPreview();
}

export function recordReproducibilityAction(label: string, autoRepair = false): void {
  if (!document.getElementById('qb-repro-panel')) return;
  // La acción se registra antes de ejecutar. Todavía no debe reutilizar el
  // resultado anterior como si fuera la salida de la reparación nueva.
  const spec = captureReproducibilitySpec(false);
  spec.regression.autoRepair = autoRepair;
  history.push({ id: nextActionId++, timestamp: new Date().toISOString(), label, spec });
  if (history.length > 20) history.shift();
  render();
}

export function markReproducibilityExecuted(
  label: string,
  autoRepair = false,
  executedConstraint?: RLSConstraint
): void {
  // Se conservan por separado la receta efectivamente ejecutada (que puede
  // tener menos X después de reparar) y la firma de los controles que la
  // originaron. Así la propia reparación no aparece como una edición posterior.
  const controlSpec = captureReproducibilitySpec(false);
  const spec = captureReproducibilitySpec(autoRepair);
  if (executedConstraint) {
    const restrictionSurvivedRepair = !autoRepair || appState.lastResult?.method === 'RLS';
    spec.regression.restriction = restrictionSurvivedRepair
      ? restrictionFromConstraint(executedConstraint)
      : null;
  }
  lastExecutedSpec = spec;
  lastExecutedKey = stableSpecKey(controlSpec);
  history.push({ id: nextActionId++, timestamp: spec.generatedAt, label, spec });
  if (history.length > 20) history.shift();
  render();
}

export function resetReproducibilityForDataset(label: string): void {
  lastExecutedSpec = null;
  lastExecutedKey = '';
  recordReproducibilityAction(`Dataset cargado: ${label}`);
}

async function copyPreview(): Promise<void> {
  const content = document.getElementById('qb-repro-code')?.textContent ?? '';
  if (!content) return;
  await navigator.clipboard?.writeText(content);
  const button = document.getElementById('qb-repro-copy');
  if (button) {
    const previous = button.textContent;
    button.textContent = 'Copiado';
    window.setTimeout(() => { button.textContent = previous; }, 1200);
  }
}

function download(language: ReproducibilityLanguage): void {
  if (!lastExecutedSpec) return;
  const meta = REPRODUCIBILITY_LANGUAGE_META[language];
  const content = generateReproducibilityArtifact(lastExecutedSpec, language);
  downloadTextFile(`chartbay_reproducible.${meta.extension}`, content, meta.mime);
  history.push({
    id: nextActionId++,
    timestamp: new Date().toISOString(),
    label: `Descarga ${meta.label}`,
    spec: lastExecutedSpec,
  });
  if (history.length > 20) history.shift();
  render();
}

const changeLabels: Record<string, string> = {
  'qb-mode': 'Cambiar modo de análisis',
  'qb-version': 'Cambiar motor',
  'qb-y': 'Seleccionar variable Y',
  'qb-form': 'Cambiar forma funcional',
  'qb-drop-incomplete': 'Configurar datos faltantes',
  'qb-pro-se': 'Cambiar errores estándar',
  'qb-pro-hac-lags': 'Configurar rezagos HAC',
  'qb-rls-input': 'Definir restricción RLS',
  'qb-ts-date': 'Seleccionar fecha',
  'qb-ts-value': 'Seleccionar serie',
  'qb-ts-transform': 'Transformar serie',
  'qb-ts-ma-window': 'Cambiar ventana móvil',
  'qb-ts-acf-max-lag': 'Cambiar rezago máximo',
  'qb-pro-ts-date': 'Seleccionar fecha Pro',
  'qb-pro-ts-value': 'Seleccionar serie Pro',
  'qb-pro-ts-maxlag': 'Cambiar rezago máximo Pro',
  'qb-pro-ts-adf-reg': 'Cambiar especificación ADF',
  'qb-pro-ts-arima-enable': 'Configurar ARIMA',
  'qb-pro-ts-arima-p': 'Cambiar orden AR',
  'qb-pro-ts-arima-d': 'Cambiar diferenciación ARIMA',
  'qb-pro-ts-arima-q': 'Cambiar orden MA',
  'qb-pro-ts-forecast-steps': 'Cambiar horizonte de forecast',
};

export function initReproducibilityView(): void {
  if (!document.getElementById('qb-repro-panel')) return;
  document.querySelectorAll<HTMLButtonElement>('[data-repro-language]').forEach(button => {
    button.addEventListener('click', () => {
      const language = button.dataset.reproLanguage as ReproducibilityLanguage | undefined;
      if (!language || !languages.includes(language)) return;
      activeLanguage = language;
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-repro-download]').forEach(button => {
    button.addEventListener('click', () => {
      const language = button.dataset.reproDownload as ReproducibilityLanguage | undefined;
      if (language && languages.includes(language)) download(language);
    });
  });
  document.getElementById('qb-repro-copy')?.addEventListener('click', () => void copyPreview());

  document.addEventListener('change', event => {
    const target = event.target as HTMLInputElement | HTMLSelectElement | null;
    if (!target) return;
    const label = target.classList.contains('qb-x-cb')
      ? 'Seleccionar variables X'
      : changeLabels[target.id];
    if (!label) return;
    queueMicrotask(() => recordReproducibilityAction(label));
  });
  render();
}
