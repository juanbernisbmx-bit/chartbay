import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outputDirectory = resolve(import.meta.dirname, '../../web/static/js');
const bundles = [
  'quantbay.bundle.js',
  'quantbay.worker.js',
  'quantbay.cleaner.js',
  'quantbay.data-cleaner.worker.js',
  'quantbay.pro.worker.js',
];

for (const name of bundles) {
  const path = resolve(outputDirectory, name);
  const source = await readFile(path, 'utf8');
  // esbuild conserva correctamente los avisos legales de las dependencias,
  // incluidos algunos bloques que traen espacios al final de sus líneas.
  // Normalizar sólo ese whitespace mantiene los avisos y hace que el artefacto
  // generado cumpla `git diff --check` de manera reproducible.
  const normalized = source.replace(/[ \t]+(?=\r?\n|$)/g, '');
  if (normalized !== source) await writeFile(path, normalized, 'utf8');
}
