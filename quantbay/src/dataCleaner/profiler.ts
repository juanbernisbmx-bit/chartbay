import { cleanText, inferProfiles, invalidValue, isMissing, parseNumeric, type Profile, type Rules } from './model';
import { DEFAULT_OUTLIERS } from './advancedTypes';
import { request } from './storage';
import { dateValue } from './validation';
import type { CleanerSession } from './session';
/** Exact medians and category frequencies spill to IndexedDB, never to full-column arrays. */
export async function profileSession(session: CleanerSession, rules: Rules): Promise<Profile[]> {
  const headers = rules.normalizeHeaders ? session.headers : session.source.originalHeaders ?? session.headers;
  const profiles = inferProfiles(headers, session.sample, rules.types);
  profiles.forEach((p, i) => {
    p.key = session.headers[i];
    p.advanced = { count: 0, min: null, max: null, mean: null, median: null, q1: null, q3: null, sd: null,
      lowerPercentile: null, upperPercentile: null, firstDate: null, lastDate: null, nullPercent: 0, topCategories: [], categoriesExact: true, outliers: 0 };
  });
  const m2 = profiles.map(() => 0);
  let total = 0;
  await session.storage.clear('numbers');
  await session.storage.clear('categories');
  for await (const rows of session.rows()) {
    let numbers: [IDBValidKey, number][] = [];
    const categories = new Map<string, { column: number; value: string; count: number }>();
    let bytes = 0;
    const flush = async () => {
      session.check();
      if (numbers.length) { await session.storage.putMany('numbers', numbers); numbers = []; }
      if (categories.size) {
        await session.storage.transaction('categories', 'readwrite', async store => {
          await Promise.all([...categories.values()].map(async c => {
            const key = [c.column, c.value];
            const previous = await request<number | undefined>(store.get(key));
            await request(store.put((previous ?? 0) + c.count, key));
          }));
        });
        categories.clear();
      }
      bytes = 0;
    };
    for (const row of rows) {
      total++;
      for (let i = 0; i < row.cells.length; i++) {
        const p = profiles[i], value = row.cells[i], d = p.advanced!;
        if (isMissing(value)) p.missing++;
        else {
          p.present++;
          if (invalidValue(value, p)) { p.invalid++; if (p.invalidExamples.length < 3) p.invalidExamples.push({row: row.n, value: value.slice(0, 100)}); }
          const key = JSON.stringify([i, value]);
          const existing = categories.get(key);
          if (existing) existing.count++;
          else { categories.set(key, {column: i, value, count: 1}); bytes += value.length * 4 + 96; }
          if (p.type === 'fecha') {
            const time = dateValue(value);
            if (time !== null) {
              const date = new Date(time).toISOString().slice(0, 10);
              d.firstDate = d.firstDate === null || date < d.firstDate ? date : d.firstDate;
              d.lastDate = d.lastDate === null || date > d.lastDate ? date : d.lastDate;
            }
          }
          if (p.type === 'número') {
            const n = parseNumeric(value, p.decimal);
            if (n !== null) {
              const delta = n - (d.mean ?? 0);
              d.mean = (d.mean ?? 0) + delta / ++d.count;
              m2[i] += delta * (n - d.mean);
              d.min = d.min === null ? n : Math.min(d.min, n);
              d.max = d.max === null ? n : Math.max(d.max, n);
              numbers.push([[i, n, total], 0]);
            }
          }
        }
        if (cleanText(value) !== value) p.dirty++;
        if (categories.size + numbers.length >= 2048 || bytes >= 512 * 1024) await flush();
      }
    }
    await flush();
  }
  let topBytes = 0;
  for await (const page of session.storage.pages<number>('categories')) {
    session.check();
    for (const entry of page) {
      const [index, value] = entry.key as [number, string];
      const p = profiles[index];
      p.unique++;
      // The index counts every value exactly; only the top 32 bounded labels cross to the UI.
      if (value.length <= 500) {
        const top = p.advanced!.topCategories;
        const next = [...top, {value, count: entry.value}].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, 32);
        const cost = (items: typeof top) => items.reduce((n, c) => n + c.value.length * 2 + 64, 0);
        const delta = cost(next) - cost(top);
        if (topBytes + delta <= 4 * 1024 * 1024) { p.advanced!.topCategories = next; topBytes += delta; }
        else p.advanced!.categoriesExact = false;
      } else p.advanced!.categoriesExact = false;
    }
  }
  const options = rules.outliers ?? DEFAULT_OUTLIERS;
  for (let i = 0; i < profiles.length; i++) {
    session.check();
    const p = profiles[i], d = p.advanced!;
    d.nullPercent = total ? 100 * p.missing / total : 0;
    p.min = d.min; p.max = d.max; p.mean = d.mean;
    d.sd = d.count > 1 ? Math.sqrt(Math.max(0, m2[i] / (d.count - 1))) : null;
    [d.q1, d.median, d.q3, d.lowerPercentile, d.upperPercentile] = await session.storage.quantiles(i, d.count, [.25, .5, .75, options.lower / 100, options.upper / 100]);
    session.progress('Calculando perfiles y cuantiles', (i + 1) / profiles.length);
  }
  await session.storage.clear('numbers');
  await session.storage.clear('categories');
  return profiles;
}
