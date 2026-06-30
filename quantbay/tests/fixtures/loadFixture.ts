/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Loads a committed JSON fixture, converting the "Infinity"/"-Infinity" sentinel
// strings (emitted by generate_fixtures.py) back into real numbers. `null` stays
// null (it stands for NaN / undefined in the reference output).
export function loadFixture<T = unknown>(fileName: string): T {
  const raw = readFileSync(join(here, fileName), 'utf8');
  return JSON.parse(raw, (_key, value) => {
    if (value === 'Infinity') return Infinity;
    if (value === '-Infinity') return -Infinity;
    return value;
  }) as T;
}
