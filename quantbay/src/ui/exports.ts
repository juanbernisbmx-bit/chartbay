import type { RegressionResult } from '../regression';
import type { TimeSeriesAnalysisResult } from '../timeseries/types';
import { interpret } from '../interpretation';
import { significanceLabel } from '../utils/format';
import { $, showError } from '../app/dom';
import { appState } from '../app/state';

export function residualSumSquares(result: RegressionResult): number {
  return result.residuals.reduce((sum, residual) => sum + residual ** 2, 0);
}

function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function csvCell(value: string | number): string {
  const text = String(value);
  // Prefix formula-injection characters with a single quote so Excel/Sheets
  // treats the cell as text instead of executing a formula.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function formatExportNumber(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? 'N/D' : value.toFixed(6);
}

function timeSeriesDiagnosticNote(name: string): Array<Array<string | number>> {
  return [['note', name, '', `${name} no disponible para la serie transformada seleccionada.`]];
}

function timeSeriesWarnings(result: TimeSeriesAnalysisResult): string[] {
  return [
    ...result.validation.issues.map(issue => issue.message),
    ...result.selectedTransformation.warnings,
    ...result.acf.warnings,
  ];
}

function adfValue(adf: unknown, key: string): string | number {
  if (!adf || typeof adf !== 'object') return 'N/D';
  const value = (adf as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : String(value ?? 'N/D');
}

function buildTimeSeriesCSVRows(result: TimeSeriesAnalysisResult): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [
    ['section', 'metric', 'variable', 'value'],
    ['time_series', 'value_column', '', result.dataset.valueColumn],
    ['time_series', 'date_column', '', result.dataset.dateColumn ?? 'N/D'],
    ['time_series', 'selected_transformation', '', result.selectedTransformation.label],
    ['summary', 'observations', '', result.summary.observations],
    ['summary', 'transformed_observations', '', result.selectedTransformation.summary.observations],
    ['summary', 'frequency', '', result.summary.frequency],
    ['summary', 'start_date', '', result.summary.startDate ? result.summary.startDate.toISOString().slice(0, 10) : 'N/D'],
    ['summary', 'end_date', '', result.summary.endDate ? result.summary.endDate.toISOString().slice(0, 10) : 'N/D'],
  ];

  rows.push(...(result.acf.rows.length > 0
    ? result.acf.rows.flatMap(row => [
      ['acf', 'autocorrelation', String(row.lag), row.autocorrelation],
      ['acf', 'threshold', String(row.lag), row.threshold],
      ['acf', 'outside_threshold', String(row.lag), row.outsideThreshold ? 'Si' : 'No'],
    ] as Array<Array<string | number>>)
    : timeSeriesDiagnosticNote('ACF')));

  rows.push(...(result.acf.ljungBox.length > 0
    ? result.acf.ljungBox.flatMap(row => [
      ['ljung_box', 'q_statistic', String(row.lag), row.qStatistic],
      ['ljung_box', 'p_value', String(row.lag), row.pValue],
      ['ljung_box', 'interpretation', String(row.lag), row.interpretation],
    ] as Array<Array<string | number>>)
    : timeSeriesDiagnosticNote('Ljung-Box')));

  rows.push(...(result.acf.pacf.length > 0
    ? result.acf.pacf.flatMap(row => [
      ['pacf', 'partial_autocorrelation', String(row.lag), row.partialAutocorrelation],
      ['pacf', 'threshold', String(row.lag), row.threshold],
      ['pacf', 'outside_threshold', String(row.lag), row.outsideThreshold ? 'Si' : 'No'],
    ] as Array<Array<string | number>>)
    : timeSeriesDiagnosticNote('PACF')));

  const adf = (result as unknown as { adf?: unknown }).adf;
  if (adf) {
    rows.push(
      ['adf', 'statistic', '', adfValue(adf, 'statistic')],
      ['adf', 'p_value', '', adfValue(adf, 'pValue')],
      ['adf', 'interpretation', '', adfValue(adf, 'interpretation')]
    );
  } else {
    rows.push(['note', 'ADF', '', 'ADF no disponible para esta serie.']);
  }

  for (const warning of timeSeriesWarnings(result)) {
    rows.push(['warning', 'text', '', warning]);
  }
  rows.push(['interpretation', 'summary', '', result.interpretation.join(' ')]);
  rows.push(['interpretation', 'transformation', '', result.selectedTransformation.interpretation]);
  rows.push(['interpretation', 'acf', '', result.acf.interpretation]);
  rows.push(['interpretation', 'pacf', '', result.acf.pacfInterpretation]);

  return rows;
}

function exportTimeSeriesCSV(result: TimeSeriesAnalysisResult): void {
  downloadTextFile(
    'quantbay_time_series.csv',
    buildTimeSeriesCSVRows(result).map(row => row.map(csvCell).join(',')).join('\n'),
    'text/csv'
  );
}

function exportTimeSeriesTXT(result: TimeSeriesAnalysisResult): void {
  const warnings = timeSeriesWarnings(result);
  const adf = (result as unknown as { adf?: unknown }).adf;
  const lines = [
    'Quant Bay - Time Series',
    '',
    `Serie seleccionada: ${result.dataset.valueColumn}`,
    `Columna de fecha: ${result.dataset.dateColumn ?? 'N/D'}`,
    `Transformacion seleccionada: ${result.selectedTransformation.label}`,
    `Observaciones: ${result.summary.observations}`,
    `Observaciones transformadas: ${result.selectedTransformation.summary.observations}`,
    `Frecuencia aproximada: ${result.summary.frequency}`,
    '',
    'ACF',
    ...(result.acf.rows.length > 0
      ? result.acf.rows.map(row => `Lag ${row.lag}\tACF ${formatExportNumber(row.autocorrelation)}\tUmbral +/- ${formatExportNumber(row.threshold)}\tFuera: ${row.outsideThreshold ? 'Si' : 'No'}`)
      : ['ACF no disponible para la serie transformada seleccionada.']),
    '',
    'PACF',
    ...(result.acf.pacf.length > 0
      ? result.acf.pacf.map(row => `Lag ${row.lag}\tPACF ${formatExportNumber(row.partialAutocorrelation)}\tUmbral +/- ${formatExportNumber(row.threshold)}\tFuera: ${row.outsideThreshold ? 'Si' : 'No'}`)
      : ['PACF no disponible para la serie transformada seleccionada.']),
    '',
    'Ljung-Box',
    ...(result.acf.ljungBox.length > 0
      ? result.acf.ljungBox.map(row => `Lag ${row.lag}\tQ ${formatExportNumber(row.qStatistic)}\tp ${formatExportNumber(row.pValue)}\t${row.interpretation}`)
      : ['Ljung-Box no disponible para las ventanas de lag seleccionadas.']),
    '',
    'ADF',
    adf
      ? `Statistic: ${adfValue(adf, 'statistic')}\tp-value: ${adfValue(adf, 'pValue')}\t${adfValue(adf, 'interpretation')}`
      : 'ADF no disponible para esta serie.',
    '',
    'Warnings',
    ...(warnings.length > 0 ? warnings : ['Sin warnings disponibles.']),
    '',
    'Interpretacion',
    ...result.interpretation,
    result.selectedTransformation.interpretation,
    result.acf.interpretation,
    result.acf.pacfInterpretation,
    '',
  ];

  downloadTextFile('quantbay_time_series.txt', lines.join('\n'), 'text/plain');
}

function exportTimeSeriesPDF(result: TimeSeriesAnalysisResult, doc: any): void {
  const W = 190;
  let y = 15;
  const table = (title: string, head: string[][], body: Array<Array<string | number>>): void => {
    if (!doc.autoTable) return;
    if (y > 230) { doc.addPage(); y = 15; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(title, 10, y);
    y += 4;
    doc.autoTable({
      head,
      body,
      startY: y,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [27, 58, 107] },
      margin: { left: 10, right: 10 },
    });
    y = doc.lastAutoTable.finalY + 5;
  };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('Quant Bay - Time Series', 10, y);
  y += 7;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text('Generado por ChartBay - ' + new Date().toLocaleDateString('es-AR'), 10, y);
  y += 8;

  table('Resumen', [['Indicador', 'Valor']], [
    ['Serie seleccionada', result.dataset.valueColumn],
    ['Columna de fecha', result.dataset.dateColumn ?? 'N/D'],
    ['Transformacion', result.selectedTransformation.label],
    ['Observaciones', result.summary.observations],
    ['Observaciones transformadas', result.selectedTransformation.summary.observations],
    ['Frecuencia aproximada', result.summary.frequency],
  ]);
  table('ACF', [['Lag', 'ACF', 'Umbral', 'Fuera']], result.acf.rows.length > 0
    ? result.acf.rows.map(row => [row.lag, formatExportNumber(row.autocorrelation), `+/- ${formatExportNumber(row.threshold)}`, row.outsideThreshold ? 'Si' : 'No'])
    : [['N/D', 'ACF no disponible para la serie transformada seleccionada.', '', '']]);
  table('PACF', [['Lag', 'PACF', 'Umbral', 'Fuera']], result.acf.pacf.length > 0
    ? result.acf.pacf.map(row => [row.lag, formatExportNumber(row.partialAutocorrelation), `+/- ${formatExportNumber(row.threshold)}`, row.outsideThreshold ? 'Si' : 'No'])
    : [['N/D', 'PACF no disponible para la serie transformada seleccionada.', '', '']]);
  table('Ljung-Box', [['Lag', 'Q', 'p-valor', 'Interpretacion']], result.acf.ljungBox.length > 0
    ? result.acf.ljungBox.map(row => [row.lag, formatExportNumber(row.qStatistic), formatExportNumber(row.pValue), row.interpretation])
    : [['N/D', 'Ljung-Box no disponible para las ventanas de lag seleccionadas.', '', '']]);

  const adf = (result as unknown as { adf?: unknown }).adf;
  table('ADF', [['Metric', 'Value']], adf
    ? [
      ['Statistic', adfValue(adf, 'statistic')],
      ['p-value', adfValue(adf, 'pValue')],
      ['Interpretation', adfValue(adf, 'interpretation')],
    ]
    : [['Nota', 'ADF no disponible para esta serie.']]);

  if (y > 230) { doc.addPage(); y = 15; }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Interpretacion y warnings', 10, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  const text = [
    ...timeSeriesWarnings(result),
    ...result.interpretation,
    result.selectedTransformation.interpretation,
    result.acf.interpretation,
    result.acf.pacfInterpretation,
  ].join('\n');
  doc.text(doc.splitTextToSize(text, W), 10, y);

  doc.save('quantbay_time_series.pdf');
}

export function exportAnalysisCSV(): void {
  if (appState.activeMode === 'timeseries') {
    if (!appState.lastTimeSeriesResult) {
      showError('Primero ejecuta un analisis de Time Series para poder exportar.');
      return;
    }
    exportTimeSeriesCSV(appState.lastTimeSeriesResult);
    return;
  }

  if (!appState.lastResult) {
    showError('Primero ejecutá una regresión para poder exportar.');
    return;
  }

  const result = appState.lastResult;
  const conclusion = interpret(result);
  const noInfCSV = result.restrictedInferenceAvailable === false;
  const infVal = (v: number): string | number => noInfCSV ? 'N/D' : v;
  const rows: Array<Array<string | number>> = [
    ['section', 'metric', 'variable', 'value'],
    ['model', 'dependent_variable', '', result.yName],
    ['model', 'method', '', result.method ?? 'OLS'],
    ['model', 'r_squared', '', result.rSquared],
    ['model', 'adjusted_r_squared', '', result.adjustedRSquared],
    ['model', 'rss', '', residualSumSquares(result)],
    ['model', 'f_stat', '', result.fStat],
    ['model', 'f_p_value', '', result.fPValue],
    ['model', 'observations', '', result.nObs],
    ['model', 'features', '', result.nFeatures],
    ['model', 'degrees_of_freedom', '', result.df],
    ['model', 'dropped_rows', '', appState.lastDropped],
    ...(noInfCSV ? [['note', 'inference', '', 'Inferencia individual no disponible para RLS sin matriz de covarianza restringida']] as Array<Array<string | number>> : []),
    ['coefficient', 'estimate', 'intercept', result.intercept],
    ['coefficient', 'std_error', 'intercept', infVal(result.stdErrors[0])],
    ['coefficient', 't_stat', 'intercept', infVal(result.tStats[0])],
    ['coefficient', 'p_value', 'intercept', infVal(result.pValues[0])],
    ...result.featureNames.flatMap((name, index) => [
      ['coefficient', 'estimate', name, result.coefficients[index]],
      ['coefficient', 'std_error', name, infVal(result.stdErrors[index + 1])],
      ['coefficient', 't_stat', name, infVal(result.tStats[index + 1])],
      ['coefficient', 'p_value', name, infVal(result.pValues[index + 1])],
    ] as Array<Array<string | number>>),
    ['conclusion', 'text', '', conclusion],
  ];

  downloadTextFile(
    'quantbay_resultados.csv',
    rows.map(row => row.map(csvCell).join(',')).join('\n'),
    'text/csv'
  );
}

export function exportAnalysisTXT(): void {
  if (appState.activeMode === 'timeseries') {
    if (!appState.lastTimeSeriesResult) {
      showError('Primero ejecuta un analisis de Time Series para poder exportar.');
      return;
    }
    exportTimeSeriesTXT(appState.lastTimeSeriesResult);
    return;
  }

  if (!appState.lastResult) {
    showError('Primero ejecutá una regresión para poder exportar.');
    return;
  }

  const result = appState.lastResult;
  const noInfTxt = result.restrictedInferenceAvailable === false;
  const fmtI = (v: number): string => noInfTxt ? 'N/D' : v.toFixed(6);
  const lines = [
    'Quant Bay - Resultados del analisis',
    '',
    `Variable dependiente: ${result.yName}`,
    `Metodo: ${result.method ?? 'OLS'}`,
    `Ecuacion: ${result.equation}`,
    '',
    ...(noInfTxt ? ['NOTA: Inferencia individual (Err. Est., t-stat, p-value) no disponible para RLS sin matriz de covarianza restringida.', ''] : []),
    'Coeficientes',
    'Variable\tCoeficiente\tError estandar\tt-stat\tp-value',
    `Intercepto\t${result.intercept.toFixed(6)}\t${fmtI(result.stdErrors[0])}\t${fmtI(result.tStats[0])}\t${fmtI(result.pValues[0])}`,
    ...result.featureNames.map((name, index) =>
      `${name}\t${result.coefficients[index].toFixed(6)}\t${fmtI(result.stdErrors[index + 1])}\t${fmtI(result.tStats[index + 1])}\t${fmtI(result.pValues[index + 1])}`
    ),
    '',
    'Resumen del modelo',
    `R2: ${result.rSquared.toFixed(6)}`,
    `R2 ajustado: ${result.adjustedRSquared.toFixed(6)}`,
    `RSS: ${residualSumSquares(result).toFixed(6)}`,
    `F-stat: ${isFinite(result.fStat) ? result.fStat.toFixed(6) : 'Infinity'}`,
    `p(F): ${result.fPValue.toFixed(6)}`,
    `Observaciones: ${result.nObs}`,
    `Variables X: ${result.nFeatures}`,
    `Grados de libertad: ${result.df}`,
    `Filas omitidas: ${appState.lastDropped}`,
    '',
    'Conclusion textual',
    interpret(result),
    '',
  ];

  downloadTextFile('quantbay_resultados.txt', lines.join('\n'), 'text/plain');
}

export function exportPDF(): void {
  const jspdfLib = (window as any).jspdf;
  if (appState.activeMode === 'timeseries') {
    if (!jspdfLib?.jsPDF) { showError('Exportacion PDF no disponible. Verifica la conexion a internet.'); return; }
    if (!appState.lastTimeSeriesResult) {
      showError('Primero ejecuta un analisis de Time Series para poder exportar.');
      return;
    }
    const { jsPDF } = jspdfLib;
    exportTimeSeriesPDF(appState.lastTimeSeriesResult, new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' }));
    return;
  }
  if (!jspdfLib?.jsPDF) { showError('Exportación PDF no disponible. Verificá la conexión a internet.'); return; }
  if (!appState.lastResult) { showError('Primero ejecutá una regresión para poder exportar.'); return; }
  const result = appState.lastResult;

  const { jsPDF } = jspdfLib;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = 190;
  let y = 15;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('Quant Bay — Análisis de Regresión OLS', 10, y);
  y += 7;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text('Generado por ChartBay · ' + new Date().toLocaleDateString('es-AR'), 10, y);
  y += 8;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Ecuación estimada:', 10, y);
  y += 5;
  doc.setFont('courier', 'normal');
  doc.setFontSize(8);
  const eqLines = doc.splitTextToSize(result.equation, W);
  doc.text(eqLines, 10, y);
  y += eqLines.length * 4 + 5;

  if (doc.autoTable) {
    const noInfPDF = result.restrictedInferenceAvailable === false;
    const pdfI = (v: number, dec = 4): string => noInfPDF ? 'N/D' : (isFinite(v) ? v.toFixed(dec) : '—');
    const pdfCI = (lo: number, hi: number): string => noInfPDF ? 'N/D' : `[${lo.toFixed(4)}, ${hi.toFixed(4)}]`;
    const pdfSig = (p: number): string => noInfPDF ? 'N/D' : significanceLabel(p);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(`Coeficientes y Significancia${noInfPDF ? ' (RLS — inferencia individual N/D)' : ''}`, 10, y);
    y += 4;
    doc.autoTable({
      head: [['Variable', 'Coef.', 'Err. Est.', 't-stat', 'p-valor', 'IC 95%', 'Signif.']],
      body: [
        ['Intercepto', result.intercept.toFixed(6), pdfI(result.stdErrors[0], 6),
          pdfI(result.tStats[0]),
          pdfI(result.pValues[0]),
          pdfCI(result.ci95[0][0], result.ci95[0][1]),
          pdfSig(result.pValues[0])],
        ...result.featureNames.map((n, i) => [n,
          result.coefficients[i].toFixed(6),
          pdfI(result.stdErrors[i + 1], 6),
          pdfI(result.tStats[i + 1]),
          pdfI(result.pValues[i + 1]),
          pdfCI(result.ci95[i + 1][0], result.ci95[i + 1][1]),
          pdfSig(result.pValues[i + 1])]),
      ],
      startY: y, styles: { fontSize: 8 }, headStyles: { fillColor: [27, 58, 107] }, margin: { left: 10, right: 10 },
    });
    y = doc.lastAutoTable.finalY + 5;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Estadísticos del Modelo', 10, y);
    y += 4;
    doc.autoTable({
      head: [['Indicador', 'Valor']],
      body: [
        ['R²', result.rSquared.toFixed(6)],
        ['R² ajustado', result.adjustedRSquared.toFixed(6)],
        ['F-estadístico', isFinite(result.fStat) ? result.fStat.toFixed(4) : '∞'],
        ['p(F)', result.fPValue.toFixed(6)],
        ['n (observaciones)', String(result.nObs)],
        ['k (variables)', String(result.nFeatures)],
        ['Grados de libertad', String(result.df)],
        ['σ² (varianza residual)', result.sigma2.toFixed(6)],
      ],
      startY: y, styles: { fontSize: 8 }, headStyles: { fillColor: [27, 58, 107] }, margin: { left: 10, right: 10 },
    });
    y = doc.lastAutoTable.finalY + 5;
  }

  const chartCanvas = $('qb-chart') as HTMLCanvasElement | null;
  if (chartCanvas) {
    if (y > 220) { doc.addPage(); y = 15; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Real vs. Predicho', 10, y);
    y += 4;
    try { doc.addImage(chartCanvas.toDataURL('image/png'), 'PNG', 10, y, W, 65); y += 69; } catch (_) {}
  }

  if (appState.lastCorr && appState.lastCorrCols && doc.autoTable) {
    if (y > 200) { doc.addPage(); y = 15; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Matriz de Correlación de Pearson', 10, y);
    y += 4;
    doc.autoTable({
      head: [['', ...appState.lastCorrCols]],
      body: appState.lastCorr.map((row, i) => [appState.lastCorrCols![i], ...row.map(v => v.toFixed(3))]),
      startY: y, styles: { fontSize: 7 }, headStyles: { fillColor: [27, 58, 107] }, margin: { left: 10, right: 10 },
    });
    y = doc.lastAutoTable.finalY + 5;
  }

  if (appState.lastVIF && doc.autoTable) {
    if (y > 220) { doc.addPage(); y = 15; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Diagnóstico de Multicolinealidad (VIF)', 10, y);
    y += 4;
    doc.autoTable({
      head: [['Variable', 'VIF', 'Estado']],
      body: appState.lastVIF.map((v, i) => [
        result.featureNames[i],
        !isFinite(v) ? '>999' : v.toFixed(2),
        v >= 10 ? 'Severo' : v >= 5 ? 'Precaución' : 'Aceptable',
      ]),
      startY: y, styles: { fontSize: 8 }, headStyles: { fillColor: [27, 58, 107] }, margin: { left: 10, right: 10 },
    });
    y = doc.lastAutoTable.finalY + 5;
  }

  const rfCanvas = $('qb-resid-fitted') as HTMLCanvasElement | null;
  const rhCanvas = $('qb-resid-hist') as HTMLCanvasElement | null;
  if (rfCanvas || rhCanvas) {
    if (y > 200) { doc.addPage(); y = 15; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Diagnósticos de Residuos', 10, y);
    y += 4;
    try {
      if (rfCanvas) doc.addImage(rfCanvas.toDataURL('image/png'), 'PNG', 10, y, 90, 55);
      if (rhCanvas) doc.addImage(rhCanvas.toDataURL('image/png'), 'PNG', 105, y, 90, 55);
      y += 59;
    } catch (_) {}
  }

  if (y > 230) { doc.addPage(); y = 15; }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Interpretación Automática', 10, y);
  y += 5;
  const interpEl = $('qb-interpretation');
  if (interpEl) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    const lines = doc.splitTextToSize(interpEl.textContent ?? '', W);
    doc.text(lines, 10, y);
  }

  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7);
    doc.text('Análisis estadístico educativo · No constituye asesoramiento financiero.', 10, 290);
    doc.text(`Pág. ${i}/${pageCount}`, 185, 290);
  }

  doc.save('quantbay_regresión.pdf');
}
