import { DEFAULT_OUTLIERS, type CategoryMapping, type OutlierOptions, type ValidationRule, type QualitySummary } from './advancedTypes';
import type { Profile, Review, Rules, Source } from './model';
import type { Request } from './worker';
import { PROVINCES } from './categories';
import { validateRules } from './validation';
import { createRecipe, deleteRecipe, listRecipes, parseRecipe, recipeRules, saveRecipe } from './recipes';
import type { ComparisonReport, ComparisonKind } from './comparison';
type Command = Request extends infer T ? T extends Request ? Omit<T, 'id'> : never : never;
export type ExportFormat = 'csv' | 'audit' | 'quality' | 'comparison';
interface Hooks {
  call<T>(command: Command): Promise<T>;
  run(action: () => Promise<void>): () => void;
  dirty(): void;
  status(text: string): void;
  getRules(): Rules;
  setRules(rules: Rules): void;
  database(): string;
  export(format: ExportFormat): Promise<void>;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById('dc-' + id) as T;
const input = (id: string) => $<HTMLInputElement>(id).value;
const numeric = (id: string) => { const value = input(id); return value.trim() ? Number(value) : NaN; };
const format = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('es-AR', {maximumFractionDigits: 3});
const names: Record<string, string> = {critico:'Crítico', advertencia:'Advertencia', informativo:'Informativo'};
const kinds: Record<ComparisonKind, string> = {both:'En ambos, sin cambios', modified:'Modificada', new:'Nueva / solo actual', removed:'Eliminada / solo referencia', ambiguous:'Clave ambigua', 'missing-key':'Clave faltante'};
function text(tag: string, value: string, className = ''): HTMLElement { const element = document.createElement(tag); element.textContent = value; element.className = className; return element; }
function row(body: HTMLElement, values: string[], className = ''): void { const tr = document.createElement('tr'); tr.className = className; values.forEach(v => tr.append(text('td',v))); body.append(tr); }
function fillSelect(id: string, values: string[], selected?: string): void {
  const select = $<HTMLSelectElement>(id), previous = selected ?? select.value;
  const selections = Array.from(select.selectedOptions).map(o => o.value);
  select.replaceChildren(...values.map(v => { const o = document.createElement('option'); o.value = v; o.textContent = v || (id === 'outlier-column' ? 'Todas las numéricas' : '(encabezado vacío)'); return o; }));
  if (select.multiple) {
    const retained = selections.filter(value => values.includes(value));
    Array.from(select.options).forEach(o => { o.selected = retained.length ? retained.includes(o.value) : o.value === ''; });
  } else if (values.includes(previous)) select.value = previous;
}
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export class AdvancedView {
  private custom: ValidationRule[] = [];
  private categories: CategoryMapping[] = [];
  private value: Review | null = null;
  private headers: string[] = [];
  private referenceFile: File | null = null;
  private reference: {source: Source; headers: string[]; profiles: Profile[]} | null = null;
  private comparison: ComparisonReport | null = null;
  constructor(private hooks: Hooks) {
    $('rule-kind').addEventListener('change', () => this.ruleFields());
    $('rule-add').addEventListener('click', hooks.run(async () => this.addRule()));
    $('rule-provinces').addEventListener('click', () => { $<HTMLTextAreaElement>('rule-values').value = PROVINCES.join('\n'); });
    $('category-add').addEventListener('click', hooks.run(async () => this.addCategory({column: input('category-column'), from: input('category-from').split('\n').filter(v => v !== ''), to: input('category-to').trim()})));
    $('outlier-method').addEventListener('change', () => { $<HTMLInputElement>('outlier-factor').value = input('outlier-method') === 'zscore' ? '3' : '1.5'; this.hooks.dirty(); });
    for (const id of ['outlier-factor','outlier-lower','outlier-upper','outlier-column']) $(id).addEventListener('change', () => this.hooks.dirty());
    $('profile-column').addEventListener('change', () => this.profile());
    for (const id of ['issue-severity','issue-phase']) $(id).addEventListener('change', () => this.issues());
    $('recipe-save').addEventListener('click', hooks.run(async () => this.save()));
    $('recipe-load').addEventListener('click', hooks.run(async () => this.load()));
    $('recipe-delete').addEventListener('click', hooks.run(async () => { deleteRecipe(input('recipe-list')); this.recipes(); this.hooks.status('Receta eliminada de este navegador.'); }));
    $('recipe-export').addEventListener('click', hooks.run(async () => {
      const recipe = listRecipes().find(r => r.id === input('recipe-list'));
      if (!recipe) throw new Error('Elegí una receta guardada.');
      saveBlob(new Blob([JSON.stringify(recipe, null, 2)], {type:'application/json'}), recipe.name + '.json');
    }));
    $('recipe-import').addEventListener('change', hooks.run(async () => {
      const file = $<HTMLInputElement>('recipe-import').files?.[0];
      if (!file) return;
      if (file.size > 512 * 1024) throw new Error('La receta supera 512 KiB.');
      const recipe = parseRecipe(await file.text()); saveRecipe(recipe); this.recipes(recipe.id);
      this.hooks.status('Receta importada. Cargala para revisar las reglas sobre esta base.');
      $<HTMLInputElement>('recipe-import').value = '';
    }));
    $('quality-export').addEventListener('click', hooks.run(() => hooks.export('quality')));
    $('reference-file').addEventListener('change', hooks.run(() => this.chooseReference()));
    $('reference-import').addEventListener('click', hooks.run(() => this.importReference()));
    $('compare-run').addEventListener('click', hooks.run(() => this.compare()));
    $('compare-export').addEventListener('click', hooks.run(() => hooks.export('comparison')));
    $('compare-filter').addEventListener('change', () => this.comparisonRows());
    for (const id of ['compare-current-key','compare-reference-key','compare-normalization','compare-jump']) $(id).addEventListener('change', () => this.invalidateComparison());
    $<HTMLInputElement>('rule-asof').value = new Date().toISOString().slice(0,10);
    this.ruleFields();
    try { this.recipes(); } catch (error) { this.hooks.status(`Recetas: ${(error as Error).message}`); }
  }
  getRules(): Pick<Rules, 'custom' | 'categories' | 'outliers'> {
    const columns = Array.from($<HTMLSelectElement>('outlier-column').selectedOptions).map(o => o.value);
    return {custom: structuredClone(this.custom), categories: structuredClone(this.categories), outliers: {
      method: input('outlier-method') as OutlierOptions['method'], factor: numeric('outlier-factor'), lower: numeric('outlier-lower'), upper: numeric('outlier-upper'), columns: columns.includes('') ? [] : columns,
    }};
  }
  setRules(rules: Rules): void {
    this.custom = structuredClone(rules.custom ?? []); this.categories = structuredClone(rules.categories ?? []);
    const outlier = rules.outliers ?? DEFAULT_OUTLIERS;
    $<HTMLSelectElement>('outlier-method').value = outlier.method;
    $<HTMLInputElement>('outlier-factor').value = String(outlier.factor);
    $<HTMLInputElement>('outlier-lower').value = String(outlier.lower);
    $<HTMLInputElement>('outlier-upper').value = String(outlier.upper);
    fillSelect('outlier-column', ['', ...this.headers]);
    Array.from($<HTMLSelectElement>('outlier-column').options).forEach(option => { option.selected = outlier.columns.length ? outlier.columns.includes(option.value) : option.value === ''; });
    this.ruleList(); this.categoryList();
  }
  reset(): void {
    this.headers = []; this.value = null; this.reference = null; this.referenceFile = null;
    $<HTMLInputElement>('reference-file').value = ''; $('reference-info').textContent = 'Sin archivo de referencia.';
    this.invalidateComparison();
  }
  invalidateComparison(): void { this.comparison = null; $('comparison-results').hidden = true; $<HTMLButtonElement>('compare-export').disabled = true; }
  controls(locked: boolean, dirty: boolean): void {
    $<HTMLSelectElement>('reference-sheet').disabled = locked || !/\.xlsx$/i.test(this.referenceFile?.name ?? '');
    $<HTMLButtonElement>('reference-import').disabled = locked || !this.referenceFile;
    $<HTMLButtonElement>('compare-run').disabled = locked || !this.reference || !this.value || dirty;
    $<HTMLButtonElement>('compare-export').disabled = locked || !this.comparison;
    $<HTMLButtonElement>('quality-export').disabled = locked || !this.value || dirty;
  }
  render(value: Review): void {
    this.value = value; this.headers = value.profiles.map(p => p.key ?? p.name);
    for (const id of ['rule-column','rule-other','rule-components','category-column','profile-column','compare-current-key']) fillSelect(id, this.headers);
    fillSelect('outlier-column', ['', ...this.headers]);
    this.profile(); this.quality(); this.issues(); this.suggestions(); this.ruleList(); this.categoryList();
  }
  private ruleFields(): void {
    const kind = input('rule-kind');
    document.querySelectorAll<HTMLElement>('[data-rule-kinds]').forEach(el => { el.hidden = !el.dataset.ruleKinds!.split(' ').includes(kind); });
  }
  private addRule(): void {
    const kind = input('rule-kind') as ValidationRule['kind'];
    const column = input('rule-column');
    const rule: ValidationRule = {id: crypto.randomUUID(), kind, column, severity: input('rule-severity') as ValidationRule['severity'], label: input('rule-label').trim() || `${column}: ${$<HTMLSelectElement>('rule-kind').selectedOptions[0].textContent}`};
    if (kind === 'number-range') { rule.min = input('rule-min') === '' ? undefined : numeric('rule-min'); rule.max = input('rule-max') === '' ? undefined : numeric('rule-max'); }
    if (kind === 'date-range') { rule.from = input('rule-from'); rule.to = input('rule-to'); }
    if (kind === 'digits') rule.length = numeric('rule-length');
    if (kind === 'allowed') rule.values = input('rule-values').split('\n').filter(v => v !== '');
    if (kind === 'date-order' || kind === 'age') rule.other = input('rule-other');
    if (kind === 'sum') rule.components = Array.from($<HTMLSelectElement>('rule-components').selectedOptions).map(o => o.value);
    if (kind === 'sum' || kind === 'age') rule.tolerance = numeric('rule-tolerance');
    if (kind === 'age') rule.asOf = input('rule-asof');
    validateRules({...this.hooks.getRules(), custom: [...this.custom, rule]}, this.headers);
    this.custom.push(rule); this.ruleList(); this.hooks.dirty(); this.hooks.status('Regla agregada. Actualizá la vista previa para evaluar toda la base.');
  }
  private ruleList(): void {
    $('custom-list').replaceChildren();
    for (const rule of this.custom) {
      const item = text('li', '', `dc-issue dc-severity--${rule.severity}`);
      const description = rule.kind === 'number-range' ? `${rule.min ?? '−∞'} ≤ valor ≤ ${rule.max ?? '∞'}`
        : rule.kind === 'date-range' ? `${rule.from} a ${rule.to}` : rule.kind === 'digits' ? `${rule.length} dígitos`
        : rule.kind === 'allowed' ? `${rule.values!.length} valores permitidos: ${rule.values!.slice(0, 5).join(', ')}`
        : rule.kind === 'date-order' ? `≥ ${rule.other}` : rule.kind === 'sum' ? `${rule.components!.join(' + ')}; tolerancia ${rule.tolerance}`
        : rule.kind === 'age' ? `nacimiento ${rule.other}; referencia ${rule.asOf}; tolerancia ${rule.tolerance} años` : 'Dato obligatorio';
      item.append(text('strong', `${names[rule.severity]} · ${rule.label}`), text('p', `${rule.column}: ${description}`));
      const button = text('button', 'Quitar', 'btn-ink') as HTMLButtonElement; button.type = 'button';
      button.addEventListener('click', () => { this.custom = this.custom.filter(r => r.id !== rule.id); this.ruleList(); this.hooks.dirty(); });
      item.append(button); $('custom-list').append(item);
    }
  }
  private addCategory(mapping: CategoryMapping): void {
    validateRules({...this.hooks.getRules(), categories: [...this.categories, mapping]}, this.headers);
    this.categories.push(mapping); this.categoryList(); this.hooks.dirty(); this.hooks.status('Agrupación propuesta. Revisá los cambios antes de aplicarlos.');
  }
  private categoryList(): void {
    $('category-list').replaceChildren();
    this.categories.forEach((mapping, index) => {
      const li = text('li', `${mapping.column}: ${mapping.from.join(' · ')} → ${mapping.to} `);
      const button = text('button','Quitar','btn-ink') as HTMLButtonElement; button.type = 'button';
      button.addEventListener('click', () => { this.categories.splice(index, 1); this.categoryList(); this.hooks.dirty(); });
      li.append(button); $('category-list').append(li);
    });
  }
  private suggestions(): void {
    $('category-suggestions').replaceChildren();
    const suggestions = this.value?.categorySuggestions ?? [];
    if (!suggestions.length) $('category-suggestions').append(text('p','No se encontraron equivalencias sugeridas entre las categorías principales. Podés definir una agrupación manual.','muted qb-help'));
    suggestions.forEach(s => {
      const card = text('div','', 'dc-issue');
      card.append(text('strong',s.column), text('p',s.variants.map(v => `${v.value} (${format(v.count)})`).join(' · ')), text('p',s.reason,'muted qb-help'));
      const button = text('button',`Proponer grupo “${s.canonical}”`,'btn-ink') as HTMLButtonElement; button.type = 'button';
      button.addEventListener('click', this.hooks.run(async () => this.addCategory({column:s.column,from:s.variants.map(v=>v.value),to:s.canonical})));
      card.append(button); $('category-suggestions').append(card);
    });
  }
  private profile(): void {
    const index = this.headers.indexOf(input('profile-column')), p = this.value?.profiles[index];
    $('profile-card').replaceChildren(); if (!p) return;
    const d = p.advanced;
    $('profile-card').append(text('h4',p.name || p.key!));
    const metrics = text('div','', 'dc-metrics');
    for (const [label, value] of [['Tipo',p.type],['Nulos',`${format(d?.nullPercent)} %`],['Únicos',format(p.unique)],['Mínimo',d?.firstDate ?? format(p.min)],['Máximo',d?.lastDate ?? format(p.max)],['Media',format(p.mean)],['Mediana',format(d?.median)],['Desvío muestral',format(d?.sd)],['Q1 / Q3',`${format(d?.q1)} / ${format(d?.q3)}`],['Outliers 🚩',format(d?.outliers)]]) {
      const tile = text('div','', 'dc-metric'); tile.append(text('span',label),text('strong',value)); metrics.append(tile);
    }
    $('profile-card').append(metrics, text('p','Categorías principales (máximo 10):','muted qb-help'));
    const list = document.createElement('ul');
    for (const c of d?.topCategories.slice(0,10) ?? []) list.append(text('li',`${c.value}: ${format(c.count)}`));
    $('profile-card').append(list);
    if (!d?.categoriesExact) $('profile-card').append(text('p','Lista parcial por límites de tamaño de etiquetas. Los únicos y frecuencias se cuentan sobre todo el archivo.','muted qb-help'));
    const issues = this.value?.before?.issues.filter(issue=>issue.column===(p.key??p.name)) ?? [];
    for (const issue of issues) $('profile-card').append(text('p',`${names[issue.severity]} · ${issue.label}: ${format(issue.count)}`,`dc-severity--${issue.severity}`));
  }
  private quality(): void {
    const before = this.value?.before, after = this.value?.after;
    if (!before || !after) return;
    $('quality-summary').textContent = `Antes: ${format(before.rows)} filas, ${format(before.errors)} errores. Después de aplicar la propuesta: ${format(after.rows)} filas, ${format(after.errors)} errores pendientes.`;
    $('quality-counts').replaceChildren();
    for (const [label, s] of [['Antes',before],['Después (propuesta)',after]] as [string,QualitySummary][]) row($('quality-counts'),[label,format(s.rowsWithErrors),format(s.severity.critico),format(s.severity.advertencia),format(s.severity.informativo)]);
  }
  private issues(): void {
    const phase = input('issue-phase') as 'before' | 'after', filter = input('issue-severity');
    const issues = this.value?.[phase]?.issues.filter(i=>!filter || i.severity===filter) ?? [];
    $('quality-issues').replaceChildren();
    if (!issues.length) $('quality-issues').append(text('p','No hay incidencias para este filtro.','muted qb-help'));
    for (const issue of issues.slice(0,100)) {
      const card = text('div','',`dc-issue dc-severity--${issue.severity}`);
      card.append(text('strong',`${names[issue.severity]} · ${issue.column} · ${issue.label} (${format(issue.count)})`));
      for (const example of issue.examples) card.append(text('p',`Fila ${example.row}: ${example.value || '(vacío)'}${example.detail ? ' · '+example.detail : ''}`));
      $('quality-issues').append(card);
    }
    if (issues.length > 100) $('quality-issues').append(text('p',`Se muestran 100 de ${issues.length} grupos. El reporte contiene todos.`));
  }
  private recipes(selected?: string): void {
    const select = $<HTMLSelectElement>('recipe-list'); select.replaceChildren();
    for (const recipe of listRecipes()) { const option = document.createElement('option'); option.value = recipe.id; option.textContent = recipe.name; select.append(option); }
    if (selected) select.value = selected;
  }
  private save(): void {
    const rules = this.hooks.getRules();
    const allTypes = Object.fromEntries(this.value!.profiles.map((p,i) => [i, rules.types[i] ?? p.type]));
    const recipe = createRecipe(input('recipe-name'), this.headers, {...rules, types:allTypes});
    const previous = listRecipes().find(r=>r.name===recipe.name); if (previous) recipe.id=previous.id;
    saveRecipe(recipe); this.recipes(recipe.id); this.hooks.status('Receta guardada en este navegador. Podés exportarla como JSON.');
  }
  private load(): void {
    const recipe = listRecipes().find(r=>r.id===input('recipe-list'));
    if (!recipe) throw new Error('Elegí una receta guardada.');
    this.hooks.setRules(recipeRules(recipe,this.headers)); this.hooks.dirty();
    this.hooks.status(`Receta “${recipe.name}” cargada por nombres de columna. Actualizá la vista previa; no se aplicó automáticamente.`);
  }
  private async chooseReference(): Promise<void> {
    this.referenceFile=$<HTMLInputElement>('reference-file').files?.[0]??null; this.reference=null; this.invalidateComparison();
    if (!this.referenceFile) return;
    if (!/\.(csv|xlsx)$/i.test(this.referenceFile.name)) {this.referenceFile=null; throw new Error('La referencia debe ser CSV o Excel .xlsx.');}
    const sheets=/\.xlsx$/i.test(this.referenceFile.name) ? await this.hooks.call<{name:string}[]>({kind:'sheets',file:this.referenceFile}) : [{name:'Solo para Excel'}];
    fillSelect('reference-sheet',sheets.map(s=>s.name)); $('reference-info').textContent=`${this.referenceFile.name} · listo para importar como referencia/anterior.`;
  }
  private async importReference(): Promise<void> {
    if (!this.referenceFile) return;
    this.reference=null; this.invalidateComparison();
    this.reference=await this.hooks.call({kind:'reference',file:this.referenceFile,database:this.hooks.database()+'-reference',options:{sheet:/\.xlsx$/i.test(this.referenceFile.name)?input('reference-sheet'):undefined,delimiter:input('reference-delimiter').replace('tab','\t'),encoding:input('reference-encoding')}});
    fillSelect('compare-reference-key',this.reference!.headers);
    $('reference-info').textContent=`Referencia: ${this.reference!.source.name}${this.reference!.source.sheet?' · '+this.reference!.source.sheet:''}. ${this.reference!.source.warnings.join(' ')}`;
    this.hooks.status('Referencia importada. Elegí las claves y ejecutá el cruce.');
  }
  private async compare(): Promise<void> {
    this.invalidateComparison();
    this.comparison=await this.hooks.call<ComparisonReport>({kind:'compare',options:{currentKey:input('compare-current-key'),referenceKey:input('compare-reference-key'),normalization:input('compare-normalization') as 'exact',jumpPercent:numeric('compare-jump')}});
    const r=this.comparison;
    $('comparison-results').hidden=false;
    $('compare-summary').textContent=`${format(r.matchedKeys)} claves en ambos · ${format(r.modifiedRows)} filas modificadas · ${format(r.unchangedRows)} sin cambios · ${format(r.newRows)} nuevas · ${format(r.removedRows)} eliminadas · ${format(r.ambiguousKeys)} claves ambiguas.`;
    $('compare-duplicates').textContent=`Actual: ${format(r.currentDuplicateKeys)} claves repetidas (${format(r.currentDuplicateRows)} filas), ${format(r.currentMissingKeys)} claves faltantes. Referencia: ${format(r.referenceDuplicateKeys)} claves repetidas (${format(r.referenceDuplicateRows)} filas), ${format(r.referenceMissingKeys)} claves faltantes.`;
    $('compare-schema').textContent=`Columnas nuevas: ${r.addedColumns.join(', ')||'ninguna'}. Columnas eliminadas: ${r.removedColumns.join(', ')||'ninguna'}.`;
    $('compare-drift').replaceChildren();
    for (const d of r.drift) row($('compare-drift'),[d.column,format(d.modified),format(d.abruptValues),`${format(d.beforeMean)} → ${format(d.afterMean)}`,`${format(d.beforeMedian)} → ${format(d.afterMedian)}`,d.meanPercentChange===null?'— (sin base o base cero)':`${format(d.meanPercentChange)} %`,`${format(d.nullPercentagePoints)} pp`,d.abrupt?'🚩 Cambio brusco de media':'—'],d.abrupt?'dc-drift-alert':'');
    this.comparisonRows(); this.hooks.status('Cruce completo. Las claves duplicadas están señaladas, sin emparejarlas arbitrariamente.');
  }
  private comparisonRows(): void {
    $('compare-rows').replaceChildren(); const filter=input('compare-filter');
    for (const record of this.comparison?.preview ?? []) {
      const matches = !filter || (filter === 'duplicates' ? record.duplicate : filter === 'matched' ? ['both','modified','ambiguous'].includes(record.kind) : record.kind === filter);
      if (!matches) continue;
      row($('compare-rows'),[kinds[record.kind]+(record.duplicate?' · clave duplicada':''),record.key??'(faltante)',record.side==='current'?'Actual':'Referencia',`${record.row}${record.referenceRow?' ↔ '+record.referenceRow:''}`,record.changes.length?record.changes.map(c=>`${c.column}: ${c.before} → ${c.after}${c.jump?' 🚩':''}`).join('\n'):record.cells.join(' · ')]);
    }
  }
}
