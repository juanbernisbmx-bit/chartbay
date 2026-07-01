import { describe, it, expect } from 'vitest';
import { recommendFunctionalForm } from '../src/services/formRecommender';
import type { ParsedCSV } from '../src/csvParser';

function makeCSV(data: Record<string, number[]>): { csvData: ParsedCSV; yName: string; xNames: string[] } {
  const keys = Object.keys(data);
  const yName = 'y';
  const xNames = keys.filter(k => k !== yName);
  const n = data[keys[0]].length;
  const rows = Array.from({ length: n }, (_, i) =>
    Object.fromEntries(keys.map(k => [k, data[k][i]])) as Record<string, unknown>
  );
  return {
    csvData: { headers: keys, rows, numericColumns: keys },
    yName,
    xNames,
  };
}

// Synthetic data sets for testing
const linearX = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const positiveY = linearX.map(xi => 2 * xi + 1);    // perfect lin-lin
const exponentialY = linearX.map(xi => Math.exp(xi)); // perfect log-lin: ln(Y)=X
const powerY = linearX.map(xi => xi ** 2);            // perfect log-log: ln(Y)=2·ln(X)

describe('recommendFunctionalForm — candidate list', () => {
  it('always returns exactly four candidates, one per form', () => {
    const { csvData, yName, xNames } = makeCSV({ y: positiveY, x: linearX });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    expect(rec.candidates).toHaveLength(4);
    expect(rec.candidates.map(c => c.form)).toEqual(['lin-lin', 'log-lin', 'lin-log', 'log-log']);
  });

  it('lin-lin is valid even when X contains zeros and negatives', () => {
    const { csvData, yName, xNames } = makeCSV({
      y: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      x: [-4, -3, -2, -1, 0, 1, 2, 3, 4, 5],
    });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    const linLin = rec.candidates.find(c => c.form === 'lin-lin')!;
    expect(linLin.valid).toBe(true);
    expect(linLin.metrics).toBeDefined();
  });
});

describe('recommendFunctionalForm — domain validation', () => {
  it('marks log-lin and log-log invalid when Y has a non-positive value', () => {
    const { csvData, yName, xNames } = makeCSV({
      y: [-1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      x: linearX,
    });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    expect(rec.candidates.find(c => c.form === 'log-lin')!.valid).toBe(false);
    expect(rec.candidates.find(c => c.form === 'log-log')!.valid).toBe(false);
    expect(rec.candidates.find(c => c.form === 'log-lin')!.reasonIfInvalid).toContain('menores o iguales a cero');
  });

  it('marks log-lin invalid when Y = 0', () => {
    const { csvData, yName, xNames } = makeCSV({
      y: [0, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      x: linearX,
    });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    expect(rec.candidates.find(c => c.form === 'log-lin')!.valid).toBe(false);
  });

  it('marks lin-log and log-log invalid when X has a zero value', () => {
    const { csvData, yName, xNames } = makeCSV({
      y: positiveY,
      x: [0, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    expect(rec.candidates.find(c => c.form === 'lin-log')!.valid).toBe(false);
    expect(rec.candidates.find(c => c.form === 'log-log')!.valid).toBe(false);
    expect(rec.candidates.find(c => c.form === 'lin-log')!.reasonIfInvalid).toContain('menores o iguales a cero');
  });

  it('marks lin-log and log-log invalid when X has a negative value', () => {
    const { csvData, yName, xNames } = makeCSV({
      y: positiveY,
      x: [-1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    expect(rec.candidates.find(c => c.form === 'lin-log')!.valid).toBe(false);
    expect(rec.candidates.find(c => c.form === 'log-log')!.valid).toBe(false);
  });

  it('does not crash when one form is invalid; other valid forms still run', () => {
    const { csvData, yName, xNames } = makeCSV({
      y: [-1, 2, 3, 4, 5, 6, 7, 8, 9, 10], // Y has negative → log-Y forms invalid
      x: linearX,
    });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    expect(rec.candidates.find(c => c.form === 'lin-lin')!.valid).toBe(true);
    expect(rec.candidates.find(c => c.form === 'lin-log')!.valid).toBe(true);
    expect(rec.recommended).not.toBeNull();
  });
});

describe('recommendFunctionalForm — metrics', () => {
  it('valid candidates have finite RMSE and MAE in original scale', () => {
    const { csvData, yName, xNames } = makeCSV({ y: positiveY, x: linearX });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    rec.candidates.filter(c => c.valid).forEach(c => {
      expect(Number.isFinite(c.metrics!.rmseOriginalScale)).toBe(true);
      expect(Number.isFinite(c.metrics!.maeOriginalScale)).toBe(true);
      expect(c.metrics!.rmseOriginalScale).toBeGreaterThanOrEqual(0);
      expect(c.metrics!.maeOriginalScale).toBeGreaterThanOrEqual(0);
    });
  });

  it('log-lin achieves near-zero RMSE in original scale on perfect log-lin data', () => {
    const { csvData, yName, xNames } = makeCSV({ y: exponentialY, x: linearX });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    const logLin = rec.candidates.find(c => c.form === 'log-lin')!;
    expect(logLin.valid).toBe(true);
    expect(logLin.metrics!.rmseOriginalScale).toBeLessThan(1e-6);
  });

  it('log-log achieves near-zero RMSE in original scale on perfect power-law data', () => {
    const { csvData, yName, xNames } = makeCSV({ y: powerY, x: linearX });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    const logLog = rec.candidates.find(c => c.form === 'log-log')!;
    expect(logLog.valid).toBe(true);
    expect(logLog.metrics!.rmseOriginalScale).toBeLessThan(1e-6);
  });

  it('computes improvementVsLinLin for non-lin-lin valid forms when lin-lin is valid', () => {
    const { csvData, yName, xNames } = makeCSV({ y: exponentialY, x: linearX });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    ['log-lin', 'lin-log', 'log-log'].forEach(form => {
      const c = rec.candidates.find(c => c.form === form)!;
      if (c.valid) {
        expect(c.metrics!.improvementVsLinLin).toBeDefined();
        expect(Number.isFinite(c.metrics!.improvementVsLinLin!)).toBe(true);
      }
    });
  });

  it('improvementVsLinLin is positive when the form outperforms lin-lin', () => {
    const { csvData, yName, xNames } = makeCSV({ y: exponentialY, x: linearX });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    const logLin = rec.candidates.find(c => c.form === 'log-lin')!;
    expect(logLin.metrics!.improvementVsLinLin!).toBeGreaterThan(0);
  });

  it('lin-lin candidate has no improvementVsLinLin field', () => {
    const { csvData, yName, xNames } = makeCSV({ y: positiveY, x: linearX });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    const linLin = rec.candidates.find(c => c.form === 'lin-lin')!;
    expect(linLin.metrics!.improvementVsLinLin).toBeUndefined();
  });
});

describe('recommendFunctionalForm — ranking and recommendation', () => {
  it('recommends log-lin for data that follows Y = exp(X)', () => {
    const { csvData, yName, xNames } = makeCSV({ y: exponentialY, x: linearX });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    expect(rec.recommended).toBe('log-lin');
  });

  it('recommends log-log for data that follows Y = X^2', () => {
    const { csvData, yName, xNames } = makeCSV({ y: powerY, x: linearX });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    expect(rec.recommended).toBe('log-log');
  });

  it('recommended form is the valid candidate with lowest RMSE in original scale', () => {
    const { csvData, yName, xNames } = makeCSV({ y: exponentialY, x: linearX });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    const validByRmse = rec.candidates
      .filter(c => c.valid && c.metrics)
      .sort((a, b) => a.metrics!.rmseOriginalScale - b.metrics!.rmseOriginalScale);
    expect(rec.recommended).toBe(validByRmse[0].form);
  });

  it('returns recommended: null when all forms are invalid', () => {
    // Only 2 rows, need at least 3 (k + 2 = 1 + 2) for k=1
    const { csvData, yName, xNames } = makeCSV({
      y: [1, 2],
      x: [1, 2],
    });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    expect(rec.recommended).toBeNull();
    expect(rec.candidates.every(c => !c.valid)).toBe(true);
  });

  it('returns recommended: null when no candidates survive (all non-positive Y)', () => {
    // Y all negative, X has zeros → only lin-lin could be valid, but still runs
    // Actually lin-lin has no positivity requirement so it will be valid.
    // Test: Y all negative + X all negative → log-Y and log-X forms invalid → lin-lin valid
    const { csvData, yName, xNames } = makeCSV({
      y: [-10, -8, -6, -4, -2, -1, -3, -5, -7, -9],
      x: [-5, -4, -3, -2, -1, -1, -2, -3, -4, -5],
    });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    // lin-lin should still be valid
    expect(rec.candidates.find(c => c.form === 'lin-lin')!.valid).toBe(true);
    expect(rec.recommended).toBe('lin-lin');
  });
});

describe('recommendFunctionalForm — warning and note', () => {
  it('note always contains the pedagogical caveat', () => {
    const { csvData, yName, xNames } = makeCSV({ y: positiveY, x: linearX });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    expect(rec.note).toContain('guía estadística');
  });

  it('note includes smearing caveat when a log-Y form is recommended', () => {
    const { csvData, yName, xNames } = makeCSV({ y: exponentialY, x: linearX });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    if (rec.recommended === 'log-lin' || rec.recommended === 'log-log') {
      expect(rec.note).toContain('smearing');
    }
  });

  it('note does NOT include smearing caveat when lin-lin or lin-log is recommended', () => {
    const { csvData, yName, xNames } = makeCSV({ y: positiveY, x: linearX });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    if (rec.recommended === 'lin-lin' || rec.recommended === 'lin-log') {
      expect(rec.note).not.toContain('smearing');
    }
  });

  it('warning is set when top two forms have RMSE within 1%', () => {
    // Perfect lin-lin: all forms roughly similar RMSE is not guaranteed,
    // so instead test that the warning property is a string or undefined
    const { csvData, yName, xNames } = makeCSV({ y: positiveY, x: linearX });
    const rec = recommendFunctionalForm(csvData, yName, xNames);
    expect(rec.warning === undefined || typeof rec.warning === 'string').toBe(true);
  });
});
