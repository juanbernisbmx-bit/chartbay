import { describe, expect, it } from 'vitest';

import { calculateMemoryBudget, type DeviceProfile } from '../../../cleaner/js/deviceProfiler';
import {
  ALL_MODES,
  estimateDuplicateMemory,
  estimateFile,
  estimateModeMemory,
  preflight,
  recommendForMode,
  type ProcessingMode,
} from '../../../cleaner/js/preflight';
import {
  DUPLICATE_BYTES_PER_SLOT,
  WASM_PLANNING_LIMIT_BYTES,
} from '../../../cleaner/js/processingLimits';

const MB = 1024 * 1024;
const GB = 1024 * MB;

function profileWith(overrides: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    wasmSupported: true,
    workersSupported: true,
    availableApis: {
      deviceMemory: overrides.estimatedDeviceMemoryGB !== undefined,
      hardwareConcurrency: false,
      performanceMemory: overrides.jsHeapLimitBytes !== undefined,
      userAgentData: false,
    },
    ...overrides,
  };
}

/**
 * A stand-in for a File of arbitrary size. Only the head is real, which is
 * exactly what preflight is allowed to read — allocating a gigabyte in a test
 * would defeat the purpose.
 */
function fakeFile(totalBytes: number, head: string): Blob {
  return {
    size: totalBytes,
    slice(start = 0, end = totalBytes) {
      const text = head.slice(start, Math.min(end, head.length));
      return { text: async () => text } as unknown as Blob;
    },
  } as unknown as Blob;
}

/** Header plus `rows` numeric rows of a predictable width. */
function numericCsv(rows: number): string {
  let out = 'id,valor,precio,cantidad\n';
  for (let i = 0; i < rows; i++) {
    out += `${i},${(i * 1.5).toFixed(2)},${(i * 3.25).toFixed(2)},${i % 97}\n`;
  }
  return out;
}

/**
 * Rows about 68 bytes wide, matching the reference benchmark file. Row width
 * drives everything downstream: 500 MB of 25-byte rows is 20 M rows and really
 * does need a gigabyte, while 500 MB of 68-byte rows is 7.5 M and fits.
 */
function wideCsv(rows: number): string {
  let out = 'fecha;pais;pbi;inflacion;deuda;nota\n';
  for (let i = 0; i < rows; i++) {
    const day = String((i % 28) + 1).padStart(2, '0');
    out += `${day}/03/2024;Argentina;1.234,50;211,4%;$ 45.000;observacion\n`;
  }
  return out;
}

const budget8GB = calculateMemoryBudget(profileWith({ estimatedDeviceMemoryGB: 8 }));

describe('estimateFile', () => {
  it('counts rows exactly when the sample covers the whole file', async () => {
    const csv = numericCsv(200);
    const file = fakeFile(csv.length, csv);
    const estimate = await estimateFile(file);

    expect(estimate.exact).toBe(true);
    expect(estimate.estimatedRows).toBe(200);
    expect(estimate.columnCount).toBe(4);
  });

  it('extrapolates from the head for a file it cannot read whole', async () => {
    const head = numericCsv(4000);
    // Claim the file is 100x the sampled head.
    const file = fakeFile(head.length * 100, head);
    const estimate = await estimateFile(file, 64 * 1024);

    expect(estimate.exact).toBe(false);
    // Rows scale with size; allow a wide band since row width varies with the
    // number of digits in the id.
    expect(estimate.estimatedRows).toBeGreaterThan(200_000);
    expect(estimate.estimatedRows).toBeLessThan(600_000);
    expect(estimate.averageRowBytes).toBeGreaterThan(5);
  });

  it('recognises the column mix well enough to size the estimate', async () => {
    const csv =
      'fecha,pais,monto,nota\n' +
      Array.from({ length: 300 }, (_, i) =>
        `2024-01-${String((i % 28) + 1).padStart(2, '0')},AR,${i}.50,texto libre numero ${i}\n`
      ).join('');
    const estimate = await estimateFile(fakeFile(csv.length, csv));

    expect(estimate.shape.date).toBe(1);
    expect(estimate.shape.numeric).toBe(1);
    expect(estimate.shape.categorical).toBe(1);
    expect(estimate.shape.text).toBe(1);
  });

  it('handles a semicolon file and an empty one without producing NaN', async () => {
    const semi = 'a;b;c\n1;2;3\n4;5;6\n';
    const estimate = await estimateFile(fakeFile(semi.length, semi));
    expect(estimate.columnCount).toBe(3);
    expect(Number.isFinite(estimate.averageRowBytes)).toBe(true);

    const empty = await estimateFile(fakeFile(0, ''));
    expect(Number.isFinite(empty.averageRowBytes)).toBe(true);
    expect(empty.averageRowBytes).toBeGreaterThan(0);  // never a divide by zero
    expect(empty.estimatedRows).toBe(0);
  });
});

describe('estimateDuplicateMemory', () => {
  it('models the real hash table, powers of two and all', () => {
    // RowHashSet keeps one 64-bit hash per slot, doubles at load factor 0.75.
    // 8 M rows need 10.7 M slots, which rounds up to 16 M.
    expect(estimateDuplicateMemory(8_000_000)).toBe(16_777_216 * DUPLICATE_BYTES_PER_SLOT);
    // Confirms the measured figure: 128 MB for the reference file.
    expect(estimateDuplicateMemory(8_000_000)).toBe(128 * MB);
  });

  it('is monotonic and steps at the doubling boundaries', () => {
    let previous = 0;
    for (const rows of [0, 1, 1000, 100_000, 1_000_000, 6_000_000, 6_200_000, 50_000_000]) {
      const bytes = estimateDuplicateMemory(rows);
      expect(bytes).toBeGreaterThanOrEqual(previous);
      expect(Number.isFinite(bytes)).toBe(true);
      previous = bytes;
    }
    // The real boundary: 8_388_608 slots hold 6_291_456 rows at load factor
    // 0.75. One row past that doubles the table. 6.0 M and 6.2 M share a
    // bucket, which is exactly why this is modelled rather than averaged.
    expect(estimateDuplicateMemory(6_291_456)).toBe(estimateDuplicateMemory(6_000_000));
    expect(estimateDuplicateMemory(6_291_457)).toBe(estimateDuplicateMemory(6_291_456) * 2);
  });
});

describe('mode recommendations', () => {
  it('basic scan has no memory-derived size limit at all', async () => {
    const head = numericCsv(2000);
    const file = fakeFile(20 * GB, head);
    const result = await preflight(file, budget8GB);
    const scan = result.recommendations['basic-scan'];

    expect(scan.status).toBe('safe');
    expect(scan.recommendedMaxFileBytes).toBeUndefined();
    expect(scan.hardLimitBytes).toBeUndefined();
    // 20 GB of CSV, and the estimate stays at the fixed base cost.
    expect(scan.estimatedMemoryBytes).toBeLessThan(64 * MB);
    expect(scan.reason).toContain('no guarda nada por fila');
  });

  it('a small file is safe in every mode', async () => {
    const csv = numericCsv(500);
    const result = await preflight(fakeFile(csv.length, csv), budget8GB);
    for (const mode of ALL_MODES) {
      expect(result.recommendations[mode].status).toBe('safe');
    }
    expect(result.recommendedMode).toBe('full-analysis');
  });

  it('500 MB of ordinary rows is safe on an 8 GB device', async () => {
    // The case the 8 GB tier was recalibrated for. A real 516 MB file of this
    // exact shape measured 727 MB of WASM heap; against the old 512 MB budget
    // the advice was "not recommended" for something that demonstrably runs.
    // With the tier at 1 GB the estimate lands where the measurement did and
    // the verdict matches reality.
    const result = await preflight(fakeFile(500 * MB, wideCsv(3000)), budget8GB);
    const clean = result.recommendations['standard-clean'];

    expect(clean.status).toBe('safe');
    expect(clean.estimatedMemoryBytes).toBeGreaterThan(500 * MB);
    expect(clean.estimatedMemoryBytes).toBeLessThan(800 * MB);
  });

  it('the same file on a 4 GB device is still advised against', async () => {
    // The tier below did not move, so a constrained machine still gets warned
    // about the same file. Raising one rung must not flatten the ladder.
    const modest = calculateMemoryBudget(profileWith({ estimatedDeviceMemoryGB: 4 }));
    const result = await preflight(fakeFile(500 * MB, wideCsv(3000)), modest);
    expect(result.recommendations['standard-clean'].status).toBe('not-recommended');
    expect(result.recommendations['basic-scan'].status).toBe('safe');
  });

  it('the same 500 MB in very narrow rows costs much more', async () => {
    // Same bytes, four times the rows. Memory follows rows, not file size —
    // which is the whole reason the recommendation is computed per mode from a
    // row estimate rather than from a size threshold.
    const result = await preflight(fakeFile(500 * MB, numericCsv(4000)), budget8GB);
    expect(result.recommendations['standard-clean'].status).toBe('not-recommended');
    expect(result.recommendations['basic-scan'].status).toBe('safe');
  });

  it('duplicate detection is the mode that degrades first', async () => {
    const head = numericCsv(4000);
    const result = await preflight(fakeFile(2 * GB, head), budget8GB);

    const clean = result.recommendations['standard-clean'];
    const dupes = result.recommendations['global-duplicates'];
    expect(dupes.estimatedMemoryBytes).toBeGreaterThan(clean.estimatedMemoryBytes);
    expect(dupes.reason).toContain('tabla de hashes');
    // The scan is unaffected by any of it.
    expect(result.recommendations['basic-scan'].status).toBe('safe');
  });

  it('blocks only on a real technical ceiling, not on being big', async () => {
    const head = numericCsv(4000);
    // Large enough that materialising columns exceeds what wasm32 can address.
    const result = await preflight(fakeFile(400 * GB, head), budget8GB);

    expect(result.recommendations['standard-clean'].status).toBe('blocked');
    expect(result.recommendations['standard-clean'].reason).toContain('wasm32');
    // Even then, scanning stays available: nothing about it grows with size.
    expect(result.recommendations['basic-scan'].status).toBe('safe');
    expect(result.recommendedMode).toBe('basic-scan');
  });

  it('warns before it refuses, and severity never goes backwards', async () => {
    const head = wideCsv(3000);
    const rank = { safe: 0, warning: 1, 'not-recommended': 2, blocked: 3 };
    const seen = new Set<string>();
    let previous = -1;

    // A fine sweep: the warning band is real, not an artefact of where the
    // sample points happen to fall.
    for (let mb = 50; mb <= 3000; mb += 50) {
      const result = await preflight(fakeFile(mb * MB, head), budget8GB);
      const status = result.recommendations['standard-clean'].status;
      seen.add(status);
      expect(rank[status]).toBeGreaterThanOrEqual(previous);
      previous = rank[status];
    }
    expect(seen.has('safe')).toBe(true);
    expect(seen.has('warning')).toBe(true);
    expect(seen.has('not-recommended')).toBe(true);
  });

  it('a weaker device recommends a weaker mode for the same file', async () => {
    const head = numericCsv(4000);
    const file = fakeFile(1.5 * GB, head);
    const weak = calculateMemoryBudget(profileWith({ estimatedDeviceMemoryGB: 4 }));
    const strong = calculateMemoryBudget(
      profileWith({ estimatedDeviceMemoryGB: 32, memoryOverrideApplied: true })
    );

    const onWeak = await preflight(file, weak);
    const onStrong = await preflight(file, strong);
    const order: ProcessingMode[] = ALL_MODES;
    expect(order.indexOf(onWeak.recommendedMode)).toBeLessThanOrEqual(
      order.indexOf(onStrong.recommendedMode)
    );
  });

  it('changing mode changes the recommendation for the same file', async () => {
    const head = numericCsv(4000);
    const result = await preflight(fakeFile(3 * GB, head), budget8GB);
    const memories = ALL_MODES.map(m => result.recommendations[m].estimatedMemoryBytes);
    // Strictly increasing cost across the four modes.
    for (let i = 1; i < memories.length; i++) {
      expect(memories[i]).toBeGreaterThanOrEqual(memories[i - 1]);
    }
    expect(memories[0]).toBeLessThan(memories[memories.length - 1]);
  });

  it('never emits NaN or Infinity, whatever the input', async () => {
    const heads = ['', 'a\n', numericCsv(10), numericCsv(4000)];
    const sizes = [0, 1, 1024, 500 * MB, 1 * GB, 1024 * GB];
    for (const head of heads) {
      for (const size of sizes) {
        const result = await preflight(fakeFile(size, head), budget8GB);
        for (const mode of ALL_MODES) {
          const item = result.recommendations[mode];
          expect(Number.isFinite(item.estimatedMemoryBytes)).toBe(true);
          expect(Number.isFinite(item.estimatedSeconds)).toBe(true);
          for (const value of [
            item.recommendedMaxFileBytes,
            item.warningThresholdBytes,
            item.hardLimitBytes,
          ]) {
            if (value !== undefined) {
              expect(Number.isFinite(value)).toBe(true);
              expect(value).toBeGreaterThan(0);
            }
          }
        }
      }
    }
  });

  it('estimates line up with what the core actually used', async () => {
    // The reference measurement: 516 MB, 7.9 M rows, 4 numeric/date + 2
    // categorical columns. Observed heaps were 16 MB scanning, 137 MB scanning
    // with duplicates, 727 MB for a standard clean. The model should land in
    // the same neighbourhood, or the constants in processingLimits.ts are wrong.
    const file = {
      fileBytes: 516 * MB,
      sampledBytes: 65536,
      sampledRows: 1000,
      averageRowBytes: 68,
      estimatedRows: 7_900_000,
      columnCount: 6,
      shape: { numeric: 3, date: 1, categorical: 2, text: 0, averageTextLength: 0 },
      exact: false,
    };

    const scan = estimateModeMemory('basic-scan', file);
    expect(scan).toBeLessThan(32 * MB);

    const clean = estimateModeMemory('standard-clean', file);
    expect(clean).toBeGreaterThan(400 * MB);
    expect(clean).toBeLessThan(900 * MB);

    const dupes = estimateModeMemory('global-duplicates', file);
    expect(dupes - clean).toBeCloseTo(128 * MB, -6);
  });

  it('a hard limit, when present, sits above the recommended maximum', async () => {
    const head = numericCsv(4000);
    const result = await preflight(fakeFile(1 * GB, head), budget8GB);
    for (const mode of ALL_MODES) {
      const item = result.recommendations[mode];
      if (item.hardLimitBytes && item.recommendedMaxFileBytes) {
        expect(item.hardLimitBytes).toBeGreaterThan(item.recommendedMaxFileBytes);
      }
      if (item.warningThresholdBytes && item.recommendedMaxFileBytes) {
        expect(item.warningThresholdBytes).toBeLessThanOrEqual(item.recommendedMaxFileBytes);
      }
    }
    expect(WASM_PLANNING_LIMIT_BYTES).toBeLessThan(4 * GB);
  });
});
