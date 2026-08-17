/**
 * El test que faltaba.
 *
 * Cuando se conectó el limpiador columnar, ParsedCSV.rows pasó a ser una vista
 * previa de 50 filas y el dataset entero quedó en `columns` como arrays
 * tipados. Cuatro lugares seguían armando la matriz de diseño desde `.rows`,
 * así que un CSV de 60 000 filas se estimaba con 50. Estuvo así en producción y
 * los 1172 tests seguían en verde, porque todos los fixtures construyen un
 * ParsedCSV a mano, sin `columns`, y por eso siempre tomaban el camino por
 * filas.
 *
 * Lo que lo delata no es el coeficiente — con datos limpios sale bien con 50
 * filas o con 60 000 — sino el n y el error estándar.
 *
 * Cualquier función nueva que arme X e y desde `.rows` va a romper acá.
 */

import { describe, expect, it } from 'vitest';

import { PREVIEW_ROWS, rowCountOf, type ColumnStore, type ParsedCSV } from '../../src/csvParser';
import { runAutoRegressionMode, runRegressionMode } from '../../src/modes/regressionMode';
import { runQuantAnalysis } from '../../src/services/analysisService';

const TOTAL_ROWS = 4000;

/**
 * Un dataset como el que entrega el limpiador: `rows` es solo la vista previa,
 * y la verdad está en `columns`.
 *
 * Si algo lee `rows` para estimar, va a ver 50 filas — y esas 50 tienen los
 * mismos valores que las primeras 50 del store, así que el fixture no delata
 * el problema por accidente, solo por el conteo.
 */
function columnarCsv(options: { withCategorical?: boolean } = {}): ParsedCSV {
  const y = new Float64Array(TOTAL_ROWS);
  const x = new Float64Array(TOTAL_ROWS);
  const mask = new Uint8Array(TOTAL_ROWS).fill(1);
  const codes = new Int32Array(TOTAL_ROWS);

  for (let i = 0; i < TOTAL_ROWS; i++) {
    x[i] = (i % 97) + 1;
    // y = 3x + 50, exacto: cualquier n recupera el coeficiente, así que el
    // único testigo del truncamiento es el n mismo.
    y[i] = 3 * x[i] + 50;
    codes[i] = i % 3;
  }

  const columns: ColumnStore = {
    numeric: new Map([
      ['y', { values: y, mask }],
      ['x', { values: x, mask }],
    ]),
    categorical: options.withCategorical
      ? new Map([['grupo', { codes, levels: ['a', 'b', 'c'] }]])
      : new Map(),
    text: new Map(),
    rowCount: TOTAL_ROWS,
  };

  const headers = options.withCategorical ? ['y', 'x', 'grupo'] : ['y', 'x'];
  const rows = Array.from({ length: PREVIEW_ROWS }, (_, i) => {
    const row: Record<string, unknown> = { y: y[i], x: x[i] };
    if (options.withCategorical) row.grupo = ['a', 'b', 'c'][codes[i]];
    return row;
  });

  return { headers, rows, numericColumns: ['y', 'x'], rowCount: TOTAL_ROWS, columns };
}

describe('regresión sobre un dataset columnar', () => {
  it('el fixture es realmente el caso peligroso', () => {
    // Si esto falla, el resto de los tests de este archivo no prueban nada:
    // estarían corriendo sobre un dataset donde `rows` ya es completo.
    const csv = columnarCsv();
    expect(csv.columns).toBeDefined();
    expect(csv.rows.length).toBe(PREVIEW_ROWS);
    expect(rowCountOf(csv)).toBe(TOTAL_ROWS);
    expect(csv.rows.length).toBeLessThan(TOTAL_ROWS);
  });

  it('runRegressionMode estima con todas las filas, no con la vista previa', () => {
    const output = runRegressionMode(columnarCsv(), 'y', ['x'], undefined);

    expect(output.result.nObs).toBe(TOTAL_ROWS);
    expect(output.result.nObs).not.toBe(PREVIEW_ROWS);
    expect(output.dropped).toBe(0);
  });

  it('el error estándar corresponde al n completo', () => {
    // El testigo cuantitativo. Con y = 3x + 50 exacto el error estándar tiende
    // a cero, y con 4000 filas es mucho más chico que con 50: sqrt(4000/50) ≈ 9
    // veces. Un error estándar grande significaría un n chico aunque el
    // coeficiente esté bien.
    const output = runRegressionMode(columnarCsv(), 'y', ['x'], undefined);
    const j = output.result.featureNames.indexOf('x');

    expect(j).toBeGreaterThanOrEqual(0);
    expect(output.result.coefficients[j]).toBeCloseTo(3, 6);
    // stdErrors incluye el intercepto en la posición 0, así que la de x va
    // desplazada uno.
    expect(output.result.stdErrors[j + 1]).toBeLessThan(1e-9);
    expect(output.result.df).toBe(TOTAL_ROWS - 2);
  });

  it('runAutoRegressionMode también', () => {
    const output = runAutoRegressionMode(columnarCsv(), 'y', ['x'], undefined);
    expect(output.result.nObs).toBe(TOTAL_ROWS);
  });

  it('runQuantAnalysis también, que es de donde salía el n mal', () => {
    // Este era el sitio concreto: armaba X e y con getValidRows(csvData.rows).
    const analysis = runQuantAnalysis(columnarCsv(), 'y', ['x']);
    expect(analysis.result.nObs).toBe(TOTAL_ROWS);
    expect(analysis.dropped).toBe(0);
  });

  it('con categóricas se materializan las filas y el n sigue completo', () => {
    // El otro camino: codificar dummies necesita objetos por fila, así que acá
    // sí se reconstruye el dataset entero. Lo que no puede pasar es que se
    // codifiquen solo las 50 de la vista previa.
    const output = runRegressionMode(columnarCsv({ withCategorical: true }), 'y', ['x', 'grupo'], undefined);

    expect(output.result.nObs).toBe(TOTAL_ROWS);
    // Tres niveles ⇒ dos dummies, más x.
    expect(output.result.featureNames.length).toBe(3);
  });

  it('los faltantes se cuentan sobre el total, no sobre la vista previa', () => {
    const csv = columnarCsv();
    // Un hueco fuera de las primeras 50 filas: invisible para el camino viejo.
    const y = csv.columns!.numeric.get('y')!;
    const conHueco = new Uint8Array(y.mask);
    conHueco[TOTAL_ROWS - 1] = 0;
    csv.columns!.numeric.set('y', { values: y.values, mask: conHueco });

    const output = runRegressionMode(csv, 'y', ['x'], undefined);
    expect(output.result.nObs).toBe(TOTAL_ROWS - 1);
    expect(output.dropped).toBe(1);
  });

  it('el camino por filas sigue funcionando igual', () => {
    // La otra mitad del contrato: un ParsedCSV sin `columns` tiene que seguir
    // estimando desde `rows`, que es lo que hacen los demás fixtures del repo.
    const rows = Array.from({ length: 30 }, (_, i) => ({ x: i + 1, y: 3 * (i + 1) + 50 }));
    const output = runRegressionMode(
      { headers: ['x', 'y'], rows, numericColumns: ['x', 'y'] },
      'y',
      ['x'],
      undefined
    );
    expect(output.result.nObs).toBe(30);
  });
});
