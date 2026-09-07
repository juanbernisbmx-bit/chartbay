import { importCsv, importXlsx, type ImportOptions } from './importers';
import { BATCH_BYTES, CleanerStorage, MAX_ROW_BYTES } from './storage';
import { transform, type Row, type Rules, type Review, type Source } from './model';
import { profileSession } from './profiler';
import { categorySuggestions } from './categories';
import { findings, QualityCounter, validateRules } from './validation';
export class CleanerSession {
  headers: string[] = [];
  blocks = 0;
  sample: Row[] = [];
  source!: Source;
  candidate: Review | null = null;
  applied: Review | null = null;
  history: (Rules | null)[] = [];
  lastCsvExport: { safeForExcel: boolean; exportedAt: string } | null = null;
  events: { at: string; action: string; rules: Rules | null }[] = [];
  constructor(readonly storage: CleanerStorage, public check: () => void, public progress: (stage: string, fraction: number) => void) {}
  async import(file: File, options: ImportOptions): Promise<void> {
    let rows: Row[] = [], batchBytes = 0, sampleBytes = 0;
    const flush = async () => {
      if (!rows.length) return;
      this.check();
      await this.storage.markDuplicates(rows);
      await this.storage.put('rows', this.blocks++, rows);
      rows = []; batchBytes = 0;
    };
    const emit = async (cells: string[], n: number) => {
      this.check();
      let bytes = cells.reduce((sum, c) => sum + c.length * 2 + 16, 0);
      if (bytes > MAX_ROW_BYTES) throw new Error(`La fila ${n} supera 4 MiB.`);
      if (!this.headers.length) {
        if (!cells.length || cells.every(c => c === '')) return;
        this.source.headerRow = n;
        this.source.originalHeaders = [...cells];
        const used = new Set<string>();
        this.headers = cells.map((name, i) => {
          const base = name || `Columna ${i + 1}`;
          let unique = base, suffix = 2;
          while (used.has(unique)) unique = `${base} (${suffix++})`;
          used.add(unique); return unique;
        });
        if (this.headers.some((h, i) => h !== cells[i])) this.source.warnings.push('El archivo contiene encabezados vacíos o repetidos; revisá la regla de nombres únicos.');
        return;
      }
      // Sparse Excel cells / completely empty CSV records are padded, never truncated.
      if (cells.length === 1 && cells[0] === '') cells = this.headers.map(() => '');
      if (cells.length > this.headers.length || (!/\.xlsx$/i.test(file.name) && cells.length !== this.headers.length)) {
        throw new Error(`Fila ${n}: ${cells.length} campos; el encabezado tiene ${this.headers.length}. Revisá el separador o el archivo.`);
      }
      cells = Array.from({ length: this.headers.length }, (_, i) => cells[i] ?? '');
      // Sparse Excel rows may expand greatly when padded to the header width.
      // Budget the materialized row, not only the cells present in the XML.
      bytes = cells.reduce((sum, c) => sum + c.length * 2 + 16, 0);
      if (bytes > MAX_ROW_BYTES) throw new Error(`La fila ${n} supera 4 MiB.`);
      const row: Row = { n, cells };
      if (this.sample.length < 200 && sampleBytes + bytes <= 2 * 1024 * 1024) { this.sample.push(row); sampleBytes += bytes; }
      rows.push(row); batchBytes += bytes;
      if (rows.length >= 256 || batchBytes >= BATCH_BYTES) await flush();
    };
    this.source = { name: file.name, size: file.size, sheet: options.sheet, importedAt: new Date().toISOString(), warnings: [] };
    if (/\.xlsx$/i.test(file.name)) this.source.warnings.push(...await importXlsx(file, this.storage, options, emit, n => this.progress('Importando Excel', n)));
    else if (/\.csv$/i.test(file.name)) await importCsv(file, options, emit, n => this.progress('Importando CSV', n));
    else throw new Error('Usá un archivo CSV o Excel .xlsx. Para .xls, guardalo como .xlsx desde Excel.');
    await flush();
    await this.storage.clearSeen();
    if (!this.headers.length) throw new Error('El archivo está vacío.');
  }
  async *rows(): AsyncGenerator<Row[]> {
    for (let i = 0; i < this.blocks; i++) {
      this.check();
      yield await this.storage.get<Row[]>('rows', i);
      this.progress('Revisando', (i + 1) / this.blocks);
    }
  }
  async review(rules: Rules): Promise<Review> {
    validateRules(rules, this.headers);
    const headers = rules.normalizeHeaders ? this.headers : this.source.originalHeaders ?? this.headers;
    const profiles = await profileSession(this, rules);
    const before = new QualityCounter(), after = new QualityCounter();
    await this.storage.clearSeen();
    const result: Review = { profiles, rowsIn: 0, rowsOut: 0, duplicates: 0, changedCells: 0,
      removedRows: 0, preview: [], rules: structuredClone(rules), previewLimit: 100 };
    for (const [i, before] of (this.source.originalHeaders ?? []).entries()) {
      if (before !== headers[i]) {
        result.changedCells++;
        if (result.preview.length < result.previewLimit) result.preview.push({ row: this.source.headerRow!, column: headers[i], before: clip(before), after: clip(headers[i]), reason: 'Encabezado vacío o repetido: nombre único' });
      }
    }
    for await (const rows of this.rows()) {
      const output: Row[] = [];
      for (const row of rows) {
        result.rowsIn++;
        if (row.duplicateOf) result.duplicates++;
        const problems = findings(row, profiles, rules, this.headers);
        before.add(row, problems);
        for (const problem of problems) if (problem.code === 'outlier') profiles[this.headers.indexOf(problem.column)].advanced!.outliers++;
        const proposal = transform(row, profiles, rules);
        if (proposal.cells) { result.rowsOut++; result.changedCells += proposal.changes.length; output.push({ n: row.n, cells: proposal.cells }); }
        else result.removedRows++;
        for (const change of proposal.changes) {
          if (result.preview.length < result.previewLimit) result.preview.push({ ...change,
            before: clip(change.before), after: clip(change.after) });
        }
      }
      await this.storage.markDuplicates(output);
      for (const row of output) after.add(row, findings(row, profiles, rules, this.headers));
    }
    await this.storage.clearSeen();
    result.before = before.finish(); result.after = after.finish();
    result.categorySuggestions = categorySuggestions(profiles);
    this.candidate = result;
    return result;
  }
  apply(): Review {
    if (!this.candidate) throw new Error('Generá una vista previa antes de aplicar.');
    this.history.push(this.applied ? structuredClone(this.applied.rules) : null);
    if (this.history.length > 50) this.history.shift();
    this.applied = this.candidate;
    this.lastCsvExport = null;
    this.events.push({ at: new Date().toISOString(), action: 'aplicar', rules: structuredClone(this.applied.rules) });
    return this.applied;
  }
  async undo(): Promise<Review | null> {
    if (!this.history.length) throw new Error('No hay cambios para deshacer.');
    const previous = this.history[this.history.length - 1];
    const restored = previous ? await this.review(previous) : null;
    this.history.pop(); this.applied = restored; this.candidate = restored;
    this.lastCsvExport = null;
    this.events.push({ at: new Date().toISOString(), action: 'deshacer', rules: previous });
    return restored;
  }
}
function clip(value: string): string { return value.length > 250 ? value.slice(0, 250) + '… [ver completo en auditoría]' : value; }
