import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(__dirname, '..', '..', 'src');

// Directories/files that are ALLOWED to know about Pyodide/statsmodels: the Pro
// engine itself and the entry point that routes between engines.
const ALLOWED = [
  join(SRC_DIR, 'pro'),
  join(SRC_DIR, 'pro.worker.entry.ts'),
  join(SRC_DIR, 'main.ts'),
  join(SRC_DIR, 'ui', 'proView.ts'),
  join(SRC_DIR, 'ui', 'proTimeSeriesView.ts'),
];

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (full.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('Lite engine isolation', () => {
  it('no Lite source file imports Pyodide or the Pro runners', () => {
    const liteFiles = collectSourceFiles(SRC_DIR).filter(
      file => !ALLOWED.some(allowed => file === allowed || file.startsWith(allowed + '\\') || file.startsWith(allowed + '/'))
    );
    expect(liteFiles.length).toBeGreaterThan(0);

    // Only real module dependencies count: version metadata may name the
    // 'pyodide' engine as a string without depending on it.
    const offenders = liteFiles.filter(file => {
      const source = readFileSync(file, 'utf8');
      return /(from\s+|import\s*\(\s*)['"][^'"]*(pyodide|\/pro\/|\.\.?\/pro\b)/i.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
