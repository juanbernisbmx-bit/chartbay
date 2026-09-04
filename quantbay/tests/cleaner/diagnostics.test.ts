import { describe, expect, it } from 'vitest';

import { diagnose } from '../../../cleaner/js/diagnostics';
import type {
  CleanReport,
  ColumnReport,
  FuzzyMatch,
  TimeIndexReport,
} from '../../../cleaner/js/csvclean';

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

function timeIndex(overrides: Partial<TimeIndexReport> = {}): TimeIndexReport {
  return {
    found: true,
    ambiguous: false,
    column: 'fecha',
    frequency: 'monthly',
    ordered: true,
    sorted: false,
    observations: 12,
    periodsObserved: 12,
    periodsExpected: 12,
    duplicates: 0,
    missingPeriods: 0,
    first: '2024-01',
    last: '2024-12',
    gapExamples: [],
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

  it('una serie desordenada que no se pudo ordenar sola es lo más grave', () => {
    const issues = diagnose(
      report({ timeIndex: timeIndex({ ordered: false, sorted: false, duplicates: 4 }) })
    );
    expect(issues[0].id).toBe('unsorted-time-index');
    expect(issues[0].severity).toBe('alta');
    // Y dice por qué no se ordenó sola, que es lo accionable.
    expect(issues[0].detail).toContain('panel');
  });

  it('una serie que se ordenó sola ya no es un problema', () => {
    const issues = diagnose(
      report({ timeIndex: timeIndex({ ordered: false, sorted: true }) })
    );
    expect(issues.find(i => i.id === 'unsorted-time-index')).toBeUndefined();
  });

  it('los huecos de la serie se nombran', () => {
    const issues = diagnose(
      report({
        timeIndex: timeIndex({
          periodsObserved: 10,
          periodsExpected: 12,
          missingPeriods: 2,
          gapExamples: ['2024-04', '2024-09'],
        }),
      })
    );
    const issue = issues.find(i => i.id === 'time-gaps');
    expect(issue).toBeDefined();
    expect(issue!.detail).toContain('2024-04');
    expect(issue!.detail).toContain('mensual');
  });

  it('los títulos concuerdan en singular, que es donde se nota', () => {
    // "Faltan 1 período" delata que lo escribió una plantilla, justo en el
    // panel que existe para que el usuario confíe en lo que se decidió.
    const uno = diagnose(
      report({
        timeIndex: timeIndex({ periodsObserved: 11, periodsExpected: 12, missingPeriods: 1 }),
        actions: [
          { kind: 'unified_levels', column: 'p', count: 1, detail: 'x' },
          { kind: 'skipped_preamble_rows', column: '', count: 1, detail: 'x' },
        ],
      })
    );
    const titulo = (id: string) => uno.find(i => i.id === id)!.title;
    expect(titulo('time-gaps')).toBe('Falta 1 período en la serie');
    expect(titulo('unified-levels')).toBe('Se unificó 1 escritura de las mismas categorías');
    expect(titulo('skipped-preamble')).toBe('Se salteó 1 fila arriba del encabezado');

    const varios = diagnose(
      report({
        timeIndex: timeIndex({ periodsObserved: 10, periodsExpected: 12, missingPeriods: 2 }),
        actions: [{ kind: 'skipped_preamble_rows', column: '', count: 3, detail: 'x' }],
      })
    );
    expect(varios.find(i => i.id === 'time-gaps')!.title).toBe('Faltan 2 períodos en la serie');
    expect(varios.find(i => i.id === 'skipped-preamble')!.title).toBe(
      'Se saltearon 3 filas arriba del encabezado'
    );
  });

  it('el título concuerda con el número de columnas descartadas', () => {
    const una = diagnose(
      report({
        actions: [
          { kind: 'dropped_constant_column', column: 'region', count: 0, detail: 'x' },
        ],
      })
    ).find(i => i.id === 'dropped-columns');
    expect(una!.title).toBe('Se descartó 1 columna');

    const dos = diagnose(
      report({
        actions: [
          { kind: 'dropped_constant_column', column: 'region', count: 0, detail: 'x' },
          { kind: 'dropped_empty_column', column: 'notas', count: 0, detail: 'x' },
        ],
      })
    ).find(i => i.id === 'dropped-columns');
    expect(dos!.title).toBe('Se descartaron 2 columnas');
  });

  it('una serie sana no genera ningún problema', () => {
    expect(diagnose(report({ timeIndex: timeIndex() }))).toEqual([]);
  });

  it('las escrituras parecidas se ofrecen, no se dan por hechas', () => {
    const parecidas: FuzzyMatch[] = [
      { column: 'provincia', from: 'Cordova', to: 'Córdoba', fromCount: 1, toCount: 14, distance: 1 },
    ];
    const issue = diagnose(report({ fuzzyMatches: parecidas })).find(
      i => i.id === 'similar-levels'
    );
    expect(issue).toBeDefined();
    expect(issue!.title).toBe('Hay 1 escritura parecida a otra');
    expect(issue!.detail).toContain('"Cordova" (1) se parece a "Córdoba" (14)');
    // La acción es opt-in: el botón la aplica, el default no.
    expect(issue!.fix?.options).toEqual({ fuzzyCategories: true });
  });

  it('si ya se fusionaron, el camino de vuelta también está', () => {
    const issue = diagnose(
      report({
        actions: [
          { kind: 'merged_similar_levels', column: 'provincia', count: 2, detail: 'x' },
        ],
      })
    ).find(i => i.id === 'merged-similar-levels');
    expect(issue).toBeDefined();
    expect(issue!.title).toBe('Se fusionaron 2 escrituras parecidas a otras');
    expect(issue!.fix?.options).toEqual({ fuzzyCategories: false });
  });

  it('el aviso de parecidos también concuerda en singular', () => {
    const uno = diagnose(
      report({
        fuzzyMatches: [
          { column: 'p', from: 'Cordova', to: 'Córdoba', fromCount: 1, toCount: 14, distance: 1 },
        ],
      })
    ).find(i => i.id === 'similar-levels');
    expect(uno!.detail).toContain('No se fusionó porque');
    // Y el ejemplo de huecos, que también lleva verbo.
    const hueco = diagnose(
      report({
        timeIndex: timeIndex({
          periodsObserved: 11,
          periodsExpected: 12,
          missingPeriods: 1,
          gapExamples: ['2024-04'],
        }),
      })
    ).find(i => i.id === 'time-gaps');
    expect(hueco!.detail).toContain('Falta, por ejemplo: 2024-04');
  });

  it('sin parecidos no dice nada', () => {
    expect(diagnose(report({ fuzzyMatches: [] }))).toEqual([]);
  });

  it('la unificación de categorías se puede revertir desde el diagnóstico', () => {
    const issues = diagnose(
      report({
        actions: [
          {
            kind: 'unified_levels',
            column: 'provincia',
            count: 3,
            detail: 'En "provincia" se unificaron 3 escrituras con las que ya estaban.',
          },
        ],
      })
    );
    const issue = issues.find(i => i.id === 'unified-levels');
    expect(issue).toBeDefined();
    expect(issue!.columns).toEqual(['provincia']);
    // Es la única parte de la limpieza que cambia lo que el archivo dice, así
    // que el camino de vuelta tiene que estar a un click.
    expect(issue!.fix?.options).toEqual({ unifyCategories: false });
  });

  it('el encoding convertido se avisa, y el que no se puede leer va primero', () => {
    const issues = diagnose(
      report({
        actions: [
          {
            kind: 'converted_encoding',
            column: '',
            count: 3,
            detail: 'El archivo no estaba en UTF-8: se tradujeron 3 bytes.',
          },
          {
            kind: 'unsupported_encoding',
            column: '',
            count: 1,
            detail: 'El archivo empieza con una marca de UTF-16.',
          },
        ],
      })
    );
    // UTF-16 es grave: nada de lo que se muestra abajo significa algo.
    expect(issues[0].id).toBe('unsupported-encoding');
    expect(issues.find(i => i.id === 'converted-encoding')?.severity).toBe('media');
  });

  it('avisa cuando se salteó un preámbulo, porque el encabezado pudo salir mal', () => {
    const issues = diagnose(
      report({
        actions: [
          {
            kind: 'skipped_preamble_rows',
            column: '',
            count: 2,
            detail: 'Se saltearon 2 filas arriba del encabezado.',
          },
        ],
      })
    );
    const issue = issues.find(i => i.id === 'skipped-preamble');
    expect(issue).toBeDefined();
    expect(issue!.detail).toContain('Se saltearon 2 filas');
  });

  it('el pie de tabla descartado se puede recuperar desde el diagnóstico', () => {
    const issues = diagnose(
      report({
        actions: [
          {
            kind: 'dropped_footer_rows',
            column: '',
            count: 1,
            detail: 'Se descartó 1 fila de pie de tabla.',
          },
        ],
      })
    );
    const issue = issues.find(i => i.id === 'dropped-footer');
    expect(issue).toBeDefined();
    // Descartar una fila es destructivo y la heurística puede equivocarse: el
    // camino de vuelta tiene que estar a un click.
    expect(issue!.fix?.options).toEqual({ dropFooterRows: false });
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
