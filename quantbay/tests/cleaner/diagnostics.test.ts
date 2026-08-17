import { describe, expect, it } from 'vitest';

import { diagnose } from '../../../cleaner/js/diagnostics';
import type { CleanReport, ColumnReport } from '../../../cleaner/js/csvclean';

function column(overrides: Partial<ColumnReport> = {}): ColumnReport {
  return {
    name: 'x',
    originalName: 'x',
    type: 'numeric',
    present: 100,
    missing: 0,
    invalid: 0,
    unique: 100,
    outliers: 0,
    ...overrides,
  };
}

function report(overrides: Partial<CleanReport> = {}): CleanReport {
  return {
    rowsIn: 100,
    rowsOut: 100,
    columnsOut: 1,
    dialect: { delimiter: ',', quote: '"', hasHeader: true },
    quoteAnomalies: 0,
    unterminatedQuote: false,
    columns: [column()],
    actions: [],
    ...overrides,
  };
}

describe('diagnose', () => {
  it('no inventa problemas donde no los hay', () => {
    expect(diagnose(report())).toEqual([]);
  });

  it('ordena por cuán silencioso es el error, no por cuántas celdas afecta', () => {
    // Un separador ambiguo toca una columna; los faltantes tocan cincuenta
    // celdas. Aun así el separador va primero: el archivo se lee igual y los
    // números quedan mil veces mal sin que nada avise.
    const issues = diagnose(
      report({
        columns: [
          column({ name: 'monto', ambiguousDecimal: true, decimalSeparator: '.' }),
          column({ name: 'otra', missing: 50, present: 50 }),
        ],
      })
    );
    expect(issues.map(i => i.id)).toEqual(['ambiguous-decimal', 'missing-values']);
    expect(issues[0].severity).toBe('alta');
  });

  it('el separador ambiguo ofrece leerlo al revés', () => {
    const [issue] = diagnose(
      report({ columns: [column({ ambiguousDecimal: true, decimalSeparator: '.' })] })
    );
    expect(issue.id).toBe('ambiguous-decimal');
    expect(issue.fix?.options).toEqual({ forceDecimal: ',' });
    expect(issue.fix?.label).toContain(',');
    // La etiqueta tiene que declarar su alcance: forzar el separador vale para
    // todo el archivo, así que puede romper columnas que estaban bien.
    expect(issue.fix?.label).toContain('todo el archivo');
    expect(issue.detail).toContain('TODO el archivo');
    // Y al revés: si se leyó con coma, la corrección propone el punto.
    const [otro] = diagnose(
      report({ columns: [column({ ambiguousDecimal: true, decimalSeparator: ',' })] })
    );
    expect(otro.fix?.options).toEqual({ forceDecimal: '.' });
  });

  it('las fechas ambiguas ofrecen el orden contrario al que se usó', () => {
    const [issue] = diagnose(
      report({
        columns: [column({ type: 'date', ambiguousDateOrder: true, dateOrder: 'dmy' })],
      })
    );
    expect(issue.fix?.options).toEqual({ forceDateOrder: 'mdy' });
    expect(issue.detail).toContain('estadounidense');
  });

  it('los faltantes explican el costo de cada salida, no solo que existen', () => {
    const [issue] = diagnose(
      report({ columns: [column({ name: 'pbi', missing: 12, present: 88 })] })
    );
    expect(issue.id).toBe('missing-values');
    expect(issue.columns).toEqual(['pbi']);
    expect(issue.detail).toContain('errores estándar');
    expect(issue.fix?.options).toEqual({ missing: 'drop' });
  });

  it('los atípicos no se tocan solos, y el texto dice por qué', () => {
    const [issue] = diagnose(report({ columns: [column({ outliers: 3 })] }));
    expect(issue.id).toBe('outliers');
    expect(issue.detail).toContain('el dato más interesante');
    expect(issue.fix?.options).toEqual({ outliers: 'winsorize' });
  });

  it('agrupa varias columnas en un solo aviso', () => {
    const [issue] = diagnose(
      report({
        columns: [
          column({ name: 'a', missing: 5, present: 95 }),
          column({ name: 'b', missing: 7, present: 93 }),
        ],
      })
    );
    expect(issue.columns).toEqual(['a', 'b']);
    expect(issue.title).toContain('12');  // suma de las dos
  });

  it('detecta texto libre que no sirve como regresora', () => {
    const issues = diagnose(
      report({
        rowsOut: 100,
        columns: [column({ name: 'comentario', type: 'text', unique: 100 })],
      })
    );
    expect(issues.map(i => i.id)).toContain('free-text');
  });

  it('no marca como texto libre una categórica de pocos niveles', () => {
    const issues = diagnose(
      report({ rowsOut: 100, columns: [column({ name: 'pais', type: 'text', unique: 4 })] })
    );
    expect(issues.map(i => i.id)).not.toContain('free-text');
  });

  it('informa las columnas descartadas leyendo el log de acciones', () => {
    const issues = diagnose(
      report({
        actions: [
          { kind: 'dropped_constant_column', column: 'constante', count: 0, detail: '' },
          { kind: 'dropped_empty_column', column: 'vacia', count: 0, detail: '' },
          { kind: 'inferred_dialect', column: '', count: 0, detail: '' },
        ],
      })
    );
    const dropped = issues.find(i => i.id === 'dropped-columns');
    expect(dropped?.columns).toEqual(['constante', 'vacia']);
    expect(dropped?.severity).toBe('baja');
  });

  it('la comilla sin cerrar es grave aunque no rompa la lectura', () => {
    const [issue] = diagnose(report({ unterminatedQuote: true }));
    expect(issue.id).toBe('unterminated-quote');
    expect(issue.severity).toBe('alta');
  });

  it('cada problema con corrección trae opciones aplicables', () => {
    const issues = diagnose(
      report({
        unterminatedQuote: true,
        quoteAnomalies: 2,
        columns: [
          column({ ambiguousDecimal: true, decimalSeparator: '.' }),
          column({ name: 'y', missing: 3, present: 97, invalid: 1, outliers: 2 }),
        ],
      })
    );
    for (const issue of issues) {
      expect(issue.title.length).toBeGreaterThan(0);
      expect(issue.detail.length).toBeGreaterThan(20);
      if (issue.fix) {
        expect(Object.keys(issue.fix.options).length).toBeGreaterThan(0);
        expect(issue.fix.label.length).toBeGreaterThan(0);
      }
    }
    // Y el orden de gravedad se respeta de punta a punta.
    const rank = { alta: 0, media: 1, baja: 2 };
    const orden = issues.map(i => rank[i.severity]);
    expect([...orden].sort()).toEqual(orden);
  });
});
