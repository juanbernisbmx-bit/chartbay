import { csvLine, transform } from './model';
import { findings } from './validation';
import type { Row } from './model';
import type { CleanerSession } from './session';
export interface TextSink { write(value: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
/** Writes incrementally: neither CSV nor the complete audit is assembled in RAM. */
export async function exportSession(session: CleanerSession, kind: 'csv' | 'audit', sink: TextSink, safeForExcel: boolean): Promise<void> {
  const review = session.applied;
  if (!review) throw new Error('Aplicá los cambios antes de exportar.');
  const headers = review.rules.normalizeHeaders ? session.headers : session.source.originalHeaders ?? session.headers;
  if (kind === 'audit' && session.lastCsvExport) safeForExcel = session.lastCsvExport.safeForExcel;
  try {
    if (kind === 'csv') await sink.write('\uFEFF' + csvLine(headers, safeForExcel));
    else await sink.write(JSON.stringify({ schemaVersion: 2, engine: 'chartbay-data-cleaner/2', source: session.source,
      exportedAt: new Date().toISOString(), lastCsvExport: session.lastCsvExport, status: 'aplicado', review, history: session.events,
      semantics: { duplicates: 'Filas originales exactamente iguales; se conserva la primera.',
        identifiers: 'Validación local de formato, prefijo y dígito verificador. No comprueba inscripción ni titularidad.',
        profiles: 'Perfil del original. Tipos sobre hasta 200 filas/2 MiB. Conteos, únicos, medianas y percentiles exactos mediante disco. Desvío estándar muestral. Outliers solo marcados, con umbrales del original fijos para comparar antes/después.',
        undo: 'Hasta 50 aplicaciones durante esta sesión.',
        csv: 'UTF-8 con BOM; valores, sin formato ni fórmulas del libro.',
        safeForExcel, exportEscaping: safeForExcel ? 'Se antepone apóstrofo a celdas y encabezados que comienzan con =, +, -, @ (también tras espacios). Incluido en changes.' : 'Sin escape de fórmulas.' },
    }).slice(0, -1) + ',"changes":[');
    let first = true;
    const audit = (change: unknown) => { const text = (first ? '' : ',') + JSON.stringify(change); first = false; return text; };
    if (kind === 'audit') {
      for (const [i, before] of (session.source.originalHeaders ?? []).entries()) {
        if (before !== headers[i]) await sink.write(audit({ row: session.source.headerRow, column: headers[i], before, after: headers[i], reason: 'Encabezado vacío o repetido: nombre único' }));
      }
    }
    if (kind === 'audit' && safeForExcel) {
      for (const name of headers) if (/^\s*[=+@-]/.test(name)) await sink.write(audit({ row: session.source.headerRow, column: name, before: name, after: "'" + name, reason: 'Escape de fórmula al exportar encabezado CSV' }));
    }
    for await (const rows of session.rows()) {
      let chunk = '';
      for (const row of rows) {
        const result = transform(row, review.profiles, review.rules);
        if (kind === 'csv') { if (result.cells) chunk += csvLine(result.cells, safeForExcel); }
        else {
          for (const change of result.changes) chunk += audit(change);
          if (safeForExcel && result.cells) result.cells.forEach((value, i) => {
            if (/^\s*[=+@-]/.test(value)) chunk += audit({ row: row.n, column: headers[i], before: value, after: "'" + value, reason: 'Escape de fórmula al exportar CSV' });
          });
        }
        if (chunk.length > 256 * 1024) { await sink.write(chunk); chunk = ''; }
      }
      if (chunk) await sink.write(chunk);
    }
    if (kind === 'audit') {
      await sink.write('],"pendingIssues":[');
      first = true;
      const severity = new Map(review.after?.issues.map(issue => [JSON.stringify([issue.code, issue.column]), issue.severity]));
      await session.storage.clearSeen();
      for await (const rows of session.rows()) {
        const output: Row[] = [];
        for (const row of rows) {
          const cells = transform(row, review.profiles, review.rules).cells;
          if (cells) output.push({n: row.n, cells});
        }
        await session.storage.markDuplicates(output);
        for (const row of output) {
          for (const finding of findings(row, review.profiles, review.rules, session.headers)) {
            await sink.write((first ? '' : ',') + JSON.stringify({row: row.n, ...finding, severity: severity.get(JSON.stringify([finding.code, finding.column])) ?? finding.severity})); first = false;
          }
        }
      }
      await session.storage.clearSeen();
      await sink.write(']}');
    }
    session.check();
    await sink.close();
    if (kind === 'csv') session.lastCsvExport = { safeForExcel, exportedAt: new Date().toISOString() };
  } catch (error) { await sink.abort().catch(() => undefined); throw error; }
}

export async function exportQuality(session: CleanerSession, sink: TextSink): Promise<void> {
  const review = session.candidate;
  if (!review) throw new Error('Generá una vista previa antes de exportar el reporte.');
  try {
    await sink.write(JSON.stringify({schemaVersion: 1, source: session.source, createdAt: new Date().toISOString(),
      status: session.applied === review ? 'aplicado' : 'vista-previa', rules: review.rules,
      before: review.before, after: review.after, profiles: review.profiles,
      changedCells: review.changedCells, removedRows: review.removedRows,
      semantics: 'Errores = incidencias críticas + advertencias; informativos separados. Una fila puede incumplir varias reglas. Después se vuelve a validar la propuesta, incluidos duplicados nuevos. Se mantienen los umbrales de outliers del original. Antes de aplicar, después es una proyección.'}));
    session.check(); await sink.close();
  } catch (error) { await sink.abort().catch(() => undefined); throw error; }
}
