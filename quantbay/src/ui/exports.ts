import type { RegressionResult } from '../regression';
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

export function exportAnalysisCSV(): void {
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
