/**
 * La sección Limpiador: subir un CSV, ver qué se le hizo y por qué, y llevarse
 * el resultado.
 *
 * Bundle propio y no parte de quantbay.bundle.js: esta página no necesita nada
 * del motor econométrico, y arrastrar 375 kB para limpiar un archivo sería
 * pagar por algo que no se usa.
 */

import {
  cleanCsv,
  loadCleaner,
  setCleanerBaseUrl,
  type CleanedTable,
  type MissingPolicy,
} from '../../cleaner/js/csvclean';
import { calculateMemoryBudget, detectDeviceProfile } from '../../cleaner/js/deviceProfiler';
import { preflight } from '../../cleaner/js/preflight';
import { renderDeviceProfile } from '../../cleaner/js/deviceProfileView';
import { putHandoff } from './services/datasetHandoff';

setCleanerBaseUrl('/static/wasm/');

const $ = (id: string) => document.getElementById(id);

let current: CleanedTable | null = null;
let currentName = 'limpio.csv';
/** Se guarda para poder re-limpiar cuando cambia la política de faltantes. */
let currentFile: File | null = null;

/**
 * Qué le pasa a los datos con cada política, en una línea.
 *
 * Ninguna de estas opciones es gratis y el texto lo dice. Completar con una
 * constante achica la varianza de la variable y con eso sus errores estándar;
 * eliminar filas es honesto pero descarta información y sesga si lo que falta
 * no falta al azar. Que la interfaz elija el default silencioso y no lo
 * explique es cómo se terminan publicando modelos que nadie puede auditar.
 */
const MISSING_HELP: Record<MissingPolicy, string> = {
  keep: 'Los faltantes quedan marcados y no se inventa nada. Es el default. Ojo: Econometría se niega a estimar si las columnas elegidas tienen huecos, así que para calcular vas a tener que elegir otra opción o filtrar a mano.',
  drop: 'Se elimina toda fila con al menos un dato faltante (casos completos). Es el criterio más transparente y el que usa la mayoría del software estadístico, pero descarta información y sesga los resultados si lo que falta no falta al azar.',
  mean: 'Cada hueco se rellena con la media de su columna. Conserva el n, pero reduce artificialmente la varianza de la variable y con eso achica sus errores estándar: los coeficientes van a parecer más precisos de lo que son.',
  median: 'Igual que la media, pero con la mediana. Más resistente a valores extremos, con el mismo costo sobre la varianza.',
  zero: 'Los huecos pasan a valer cero. Solo tiene sentido cuando la ausencia significa realmente cero — una venta que no ocurrió, por ejemplo. Si no, distorsiona la escala de la variable.',
  ffill: 'Cada hueco toma el último valor observado. Es lo habitual en series de tiempo con lagunas, pero achata la varianza: los tramos rellenados no aportan información nueva.',
};

function missingPolicy(): MissingPolicy {
  const value = ($('cl-missing') as HTMLSelectElement | null)?.value;
  return (value as MissingPolicy) || 'keep';
}

function updateMissingHelp(): void {
  const node = $('cl-missing-help');
  if (node) node.textContent = MISSING_HELP[missingPolicy()];
}

function show(id: string, visible: boolean): void {
  const node = $(id);
  if (node) node.style.display = visible ? '' : 'none';
}

function setStatus(text: string): void {
  const node = $('cl-status');
  if (node) node.textContent = text;
}

function renderReport(table: CleanedTable): void {
  const report = table.report;

  const resumen = $('cl-summary');
  if (resumen) {
    resumen.innerHTML = '';
    const filas = [
      ['Filas leídas', report.rowsIn.toLocaleString('es-AR')],
      ['Filas resultantes', report.rowsOut.toLocaleString('es-AR')],
      ['Columnas', String(report.columnsOut)],
      // Lo que hace visible el efecto de la política: con "dejarlos como
      // están" este número queda, con cualquier imputación se va a cero.
      [
        'Celdas faltantes',
        report.columns.reduce((sum, c) => sum + c.missing, 0).toLocaleString('es-AR'),
      ],
      ['Separador', report.dialect.delimiter === '\t' ? 'tabulación' : report.dialect.delimiter],
    ];
    for (const [k, v] of filas) {
      const row = document.createElement('div');
      row.className = 'cl-row';
      const label = document.createElement('span');
      label.textContent = k;
      const value = document.createElement('strong');
      value.textContent = v;
      row.append(label, value);
      resumen.append(row);
    }
  }

  // Perfil por columna.
  const tbody = $('cl-columns');
  if (tbody) {
    tbody.innerHTML = '';
    for (const col of report.columns) {
      const tr = document.createElement('tr');
      const celdas = [
        col.name,
        col.type,
        col.present.toLocaleString('es-AR'),
        col.missing.toLocaleString('es-AR'),
        col.invalid.toLocaleString('es-AR'),
        col.unique.toLocaleString('es-AR'),
        col.outliers.toLocaleString('es-AR'),
      ];
      for (const texto of celdas) {
        const td = document.createElement('td');
        td.textContent = texto;
        tr.append(td);
      }
      tbody.append(tr);
    }
  }

  // El log de acciones, que es lo que hace auditable la limpieza: cada cosa
  // que se tocó viene con su justificación escrita.
  const acciones = $('cl-actions');
  if (acciones) {
    acciones.innerHTML = '';
    if (report.actions.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No hubo nada que corregir.';
      acciones.append(li);
    }
    for (const action of report.actions) {
      const li = document.createElement('li');
      li.textContent = action.detail;
      acciones.append(li);
    }
  }
}

async function onFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  currentFile = file;
  await run(file);
}

/** Re-limpia el mismo archivo cuando cambia la política. */
async function onMissingChange(): Promise<void> {
  updateMissingHelp();
  if (currentFile) await run(currentFile);
}

async function run(file: File): Promise<void> {
  current?.dispose();
  current = null;
  show('cl-results', false);
  setStatus('Analizando...');

  const nombre = $('cl-filename');
  if (nombre) nombre.textContent = file.name;
  currentName = file.name.replace(/\.csv$/i, '') + '-limpio.csv';

  try {
    const budget = calculateMemoryBudget(detectDeviceProfile());
    const plan = await preflight(file, budget);

    const panel = $('cl-profile');
    if (panel) {
      renderDeviceProfile(panel, { profile: detectDeviceProfile(), budget, preflight: plan });
    }

    setStatus('Limpiando...');
    await loadCleaner();
    const table = await cleanCsv(file, {
      budget,
      estimatedMemoryBytes: plan.recommendations['standard-clean'].estimatedMemoryBytes,
      copy: true,
      missing: missingPolicy(),
      // Esta página exporta sí o sí — descarga o traspaso —, así que el handle
      // tiene que sobrevivir a la copia. Lo libera el dispose() del próximo
      // archivo.
      retainForCsv: true,
      onProgress: fraction => setStatus(`Limpiando... ${Math.round(fraction * 100)} %`),
    });

    current = table;
    renderReport(table);
    show('cl-results', true);
    setStatus(`Listo: ${table.report.rowsOut.toLocaleString('es-AR')} filas.`);
  } catch (err) {
    setStatus(`Error: ${(err as Error).message}`);
  }
}

function download(): void {
  const csv = current?.toCsv();
  if (!csv) {
    setStatus('No hay nada para descargar.');
    return;
  }
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = currentName;
  a.click();
  URL.revokeObjectURL(url);
}

async function sendToEconometria(): Promise<void> {
  const csv = current?.toCsv();
  if (!csv) {
    setStatus('Primero limpiá un archivo.');
    return;
  }
  try {
    await putHandoff(currentName, csv);
    window.location.href = '/econometria';
  } catch (err) {
    setStatus(`No se pudo pasar el archivo: ${(err as Error).message}`);
  }
}

function init(): void {
  updateMissingHelp();
  $('cl-file')?.addEventListener('change', event => void onFile(event));
  $('cl-missing')?.addEventListener('change', () => void onMissingChange());
  $('cl-download')?.addEventListener('click', download);
  $('cl-to-econometria')?.addEventListener('click', () => void sendToEconometria());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
