/**
 * Convierte lo que el limpiador detectó en consejo accionable.
 *
 * El reporte ya trae todo: separadores ambiguos, celdas que no se pudieron
 * leer, faltantes, atípicos, columnas descartadas. Lo que no trae es qué hacer
 * con eso. Este módulo ordena los problemas por gravedad y, cuando existe una
 * corrección concreta, la deja lista para aplicar en un click.
 *
 * El criterio de gravedad no es cuántas celdas afecta sino **cuán silencioso es
 * el error**. Un separador decimal ambiguo es lo más grave de la lista aunque
 * no rompa nada: el archivo se lee, los números tienen pinta razonable y están
 * mil veces mal. Un faltante, en cambio, se ve.
 */

import type { CleanOptions, CleanReport } from './csvclean';

export type IssueSeverity = 'alta' | 'media' | 'baja';

export interface Issue {
  id: string;
  severity: IssueSeverity;
  title: string;
  /** Qué pasó y por qué importa, en castellano llano. */
  detail: string;
  /** Columnas involucradas, si aplica. */
  columns?: string[];
  /** Opciones a aplicar para corregirlo, y cómo se llama el botón. */
  fix?: { label: string; options: Partial<CleanOptions> };
}

const SEVERITY_ORDER: Record<IssueSeverity, number> = { alta: 0, media: 1, baja: 2 };

const FREQUENCY_LABEL: Record<string, string> = {
  daily: 'diaria',
  business_daily: 'de días hábiles',
  weekly: 'semanal',
  fortnightly: 'quincenal',
  monthly: 'mensual',
  quarterly: 'trimestral',
  semiannual: 'semestral',
  annual: 'anual',
  unknown: 'irregular',
};

function plural(n: number, uno: string, varios: string): string {
  return `${n.toLocaleString('es-AR')} ${n === 1 ? uno : varios}`;
}

export function diagnose(report: CleanReport): Issue[] {
  const issues: Issue[] = [];

  // ── Grave: el archivo se leyó, pero puede estar mal leído ──

  if (report.unterminatedQuote) {
    issues.push({
      id: 'unterminated-quote',
      severity: 'alta',
      title: 'El archivo termina con una comilla sin cerrar',
      detail:
        'Se cerró el último campo al final del archivo, pero es probable que falte ' +
        'contenido o que haya una comilla de más en algún lado. Revisá el final del CSV.',
    });
  }

  const utf16 = report.actions.find(a => a.kind === 'unsupported_encoding');
  if (utf16) {
    issues.push({
      id: 'unsupported-encoding',
      severity: 'alta',
      title: 'El archivo no está en UTF-8 ni en Windows-1252',
      detail:
        `${utf16.detail} Mientras tanto, todo lo que veas abajo — nombres de columna, ` +
        'categorías, tipos — sale de bytes mal interpretados.',
    });
  }

  const t = report.timeIndex;
  if (t?.found && !t.ordered && !t.sorted) {
    issues.push({
      id: 'unsorted-time-index',
      severity: 'alta',
      title: 'La serie no está ordenada por fecha',
      columns: [t.column],
      detail:
        `Las filas no vienen en orden cronológico por "${t.column}", y no se reordenaron ` +
        `solas porque ${
          t.duplicates > 0
            ? 'hay fechas repetidas: si esto es un panel, ordenar solo por fecha mezclaría ' +
              'las unidades y arruinaría cualquier rezago'
            : 'la columna de fechas tiene faltantes'
        }. Todo lo que mira el pasado — el arrastre, los rezagos, la autocorrelación, las ` +
        'raíces unitarias — depende de ese orden, y sobre filas desordenadas devuelve un ' +
        'número, no un error.',
    });
  }

  const ambiguosDecimal = report.columns.filter(c => c.ambiguousDecimal);
  if (ambiguosDecimal.length > 0) {
    const usado = ambiguosDecimal[0].decimalSeparator ?? '.';
    const otro = usado === ',' ? '.' : ',';
    issues.push({
      id: 'ambiguous-decimal',
      severity: 'alta',
      title: 'No se puede saber si el separador es decimal o de miles',
      columns: ambiguosDecimal.map(c => c.name),
      detail:
        `En estas columnas todos los valores tienen exactamente tres dígitos después ` +
        `del separador, así que "1.234" puede ser mil doscientos treinta y cuatro o ` +
        `uno con doscientos treinta y cuatro. Se leyó con "${usado}" como decimal. ` +
        'Si el orden de magnitud no es el que esperabas, son mil veces más chicos o ' +
        'más grandes de lo que deberían. Ojo: la corrección se aplica a TODO el ' +
        'archivo, no solo a estas columnas, así que si otras columnas usan la ' +
        'convención contraria van a dejar de leerse como números.',
      fix: {
        // forceDecimal y no fallbackDecimal: el fallback solo entra si el
        // archivo entero quedó indeciso, y acá justamente el resto del archivo
        // votó — es esa votación la que hay que poder contradecir.
        label: `Releer todo el archivo con "${otro}" como decimal`,
        options: { forceDecimal: otro as '.' | ',' },
      },
    });
  }

  const ambiguasFechas = report.columns.filter(c => c.ambiguousDateOrder);
  if (ambiguasFechas.length > 0) {
    const usado = ambiguasFechas[0].dateOrder === 'mdy' ? 'MM/DD' : 'DD/MM';
    const otro = usado === 'MM/DD' ? 'dmy' : 'mdy';
    issues.push({
      id: 'ambiguous-date-order',
      severity: 'alta',
      title: 'No se puede saber si las fechas son DD/MM o MM/DD',
      columns: ambiguasFechas.map(c => c.name),
      detail:
        `Ningún valor tiene día mayor a 12, así que las dos lecturas son posibles. ` +
        `Se asumió ${usado}. Si el archivo viene de una fuente estadounidense, ` +
        'probablemente sea al revés. La corrección se aplica a todas las columnas ' +
        'de fecha del archivo.',
      fix: {
        label: `Releer las fechas como ${otro === 'mdy' ? 'MM/DD' : 'DD/MM'}`,
        options: { forceDateOrder: otro as 'dmy' | 'mdy' },
      },
    });
  }

  // ── Media: se ve, pero hay que decidir qué hacer ──

  const invalidas = report.columns.filter(c => c.invalid > 0);
  if (invalidas.length > 0) {
    const total = invalidas.reduce((s, c) => s + c.invalid, 0);
    issues.push({
      id: 'invalid-cells',
      severity: 'media',
      title: `${plural(total, 'celda no se pudo leer', 'celdas no se pudieron leer')}`,
      columns: invalidas.map(c => c.name),
      detail:
        'Quedaron marcadas como faltantes en vez de forzar un número inventado. ' +
        'Suele ser texto mezclado con números, unidades pegadas al valor, o un ' +
        'separador decimal distinto al del resto de la columna.',
    });
  }

  const faltantes = report.columns.filter(c => c.missing > 0);
  if (faltantes.length > 0) {
    const total = faltantes.reduce((s, c) => s + c.missing, 0);
    issues.push({
      id: 'missing-values',
      severity: 'media',
      title: `${plural(total, 'celda vacía', 'celdas vacías')}`,
      columns: faltantes.map(c => c.name),
      detail:
        'Econometría no estima con huecos en las columnas elegidas, así que hay que ' +
        'decidir algo. Eliminar las filas incompletas es lo más transparente; ' +
        'completar con la mediana conserva el n pero achica la varianza y con eso ' +
        'los errores estándar.',
      fix: { label: 'Eliminar las filas incompletas', options: { missing: 'drop' } },
    });
  }

  const conAtipicos = report.columns.filter(c => c.outliers > 0);
  if (conAtipicos.length > 0) {
    const total = conAtipicos.reduce((s, c) => s + c.outliers, 0);
    issues.push({
      id: 'outliers',
      severity: 'media',
      title: `${plural(total, 'valor atípico', 'valores atípicos')}`,
      columns: conAtipicos.map(c => c.name),
      detail:
        'Están marcados pero no se tocó ninguno. Un atípico puede ser un error de ' +
        'carga o el dato más interesante del conjunto, y esa diferencia no la puede ' +
        'decidir el programa. Revisalos antes de winsorizar.',
      fix: { label: 'Recortarlos al borde (winsorizar)', options: { outliers: 'winsorize' } },
    });
  }

  const encoding = report.actions.find(a => a.kind === 'converted_encoding');
  if (encoding) {
    issues.push({
      id: 'converted-encoding',
      severity: 'media',
      title: 'El archivo estaba en Windows-1252, no en UTF-8',
      detail:
        `${encoding.detail} Revisá que los nombres de columna y las categorías se lean ` +
        'bien; si alguno quedó raro, el archivo puede estar en otro encoding.',
    });
  }

  if (t?.found && t.duplicates > 0) {
    issues.push({
      id: 'duplicate-periods',
      severity: 'media',
      title: `${plural(t.duplicates, 'fecha repetida', 'fechas repetidas')} en el índice`,
      columns: [t.column],
      detail:
        `"${t.column}" tiene ${plural(t.observations, 'observación', 'observaciones')} en ` +
        `${plural(t.periodsObserved, 'período distinto', 'períodos distintos')}. O el archivo ` +
        'es un panel — varias unidades por fecha, y entonces no es una serie de tiempo y hay ' +
        'que filtrarlo antes de estimar —, o hay filas cargadas dos veces.',
    });
  }

  if (t?.found && t.missingPeriods > 0) {
    const ejemplos = t.gapExamples.length > 0 ? ` Faltan, por ejemplo: ${t.gapExamples.join(', ')}.` : '';
    issues.push({
      id: 'time-gaps',
      severity: 'media',
      title: `Faltan ${plural(t.missingPeriods, 'período', 'períodos')} en la serie`,
      columns: [t.column],
      detail:
        `Entre ${t.first} y ${t.last} la serie avanza de forma ${FREQUENCY_LABEL[t.frequency]}, ` +
        `así que debería tener ${plural(t.periodsExpected, 'período', 'períodos')} y tiene ` +
        `${t.periodsObserved}.${ejemplos} Un hueco no es un faltante marcado: la fila no existe, ` +
        'así que nada lo cuenta como dato ausente y los rezagos saltean el hueco como si los ' +
        'dos extremos fueran consecutivos.',
    });
  }

  const unified = report.actions.filter(a => a.kind === 'unified_levels');
  if (unified.length > 0) {
    const total = unified.reduce((sum, a) => sum + a.count, 0);
    issues.push({
      id: 'unified-levels',
      severity: 'media',
      title: `Se unificaron ${plural(total, 'escritura', 'escrituras')} de las mismas categorías`,
      columns: unified.map(a => a.column),
      detail:
        `${unified.map(a => a.detail).join(' ')} Es la única parte de la limpieza que cambia ` +
        'lo que dice el archivo, así que mirá la lista: si dos de esas eran categorías ' +
        'distintas de verdad, conviene apagarlo.',
      fix: { label: 'Tratarlas como categorías distintas', options: { unifyCategories: false } },
    });
  }

  const preamble = report.actions.find(a => a.kind === 'skipped_preamble_rows');
  if (preamble) {
    issues.push({
      id: 'skipped-preamble',
      severity: 'media',
      title: `Se saltearon ${plural(preamble.count, 'fila', 'filas')} arriba del encabezado`,
      detail:
        `${preamble.detail} Si el encabezado no es ese, el archivo entero quedó corrido ` +
        'una fila y todos los nombres de columna están mal.',
    });
  }

  const footer = report.actions.find(a => a.kind === 'dropped_footer_rows');
  if (footer) {
    issues.push({
      id: 'dropped-footer',
      severity: 'media',
      title: `Se descartó el pie de tabla (${plural(footer.count, 'fila', 'filas')})`,
      detail:
        `${footer.detail} Si esa fila era un dato de verdad y no un subtotal, traela de ` +
        'vuelta.',
      fix: { label: 'Conservar la fila del final', options: { dropFooterRows: false } },
    });
  }

  // ── Baja: informativo ──

  if (report.quoteAnomalies > 0) {
    issues.push({
      id: 'quote-anomalies',
      severity: 'baja',
      title: `${plural(report.quoteAnomalies, 'comilla suelta', 'comillas sueltas')}`,
      detail:
        'Aparecieron adentro de campos entrecomillados. Se conservaron tal cual, sin ' +
        'cortar el campo, pero puede ser señal de que el archivo se generó mal.',
    });
  }

  const descartadas = report.actions.filter(a =>
    a.kind === 'dropped_empty_column' ||
    a.kind === 'dropped_constant_column' ||
    a.kind === 'dropped_duplicate_column'
  );
  if (descartadas.length > 0) {
    issues.push({
      id: 'dropped-columns',
      severity: 'baja',
      title: `Se descartaron ${plural(descartadas.length, 'columna', 'columnas')}`,
      columns: descartadas.map(a => a.column),
      detail:
        'Estaban vacías, tenían siempre el mismo valor, o eran idénticas a otra. ' +
        'Ninguna aporta información a un modelo, y una columna constante además hace ' +
        'singular la matriz X\'X.',
    });
  }

  const textoLibre = report.columns.filter(
    c => c.type === 'text' && c.unique > 0 && c.unique >= report.rowsOut * 0.9
  );
  if (textoLibre.length > 0) {
    issues.push({
      id: 'free-text',
      severity: 'baja',
      title: 'Hay columnas de texto casi todas distintas',
      columns: textoLibre.map(c => c.name),
      detail:
        'Un texto que casi nunca se repite no sirve como variable explicativa: no hay ' +
        'categorías que comparar. Suelen ser identificadores o comentarios. Son además ' +
        'las columnas que más memoria ocupan.',
    });
  }

  return issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
