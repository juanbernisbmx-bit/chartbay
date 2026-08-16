import { describe, expect, it } from 'vitest';

import { MemoryMonitor, SessionTelemetry } from '../../../cleaner/js/telemetry';
import { applyMode } from '../../../cleaner/js/csvclean';

const MB = 1024 * 1024;

describe('MemoryMonitor', () => {
  const target = 512 * MB;
  const max = 768 * MB;

  it('stays quiet while usage is comfortable', () => {
    const monitor = new MemoryMonitor(target, max);
    expect(monitor.check(100 * MB).kind).toBe('ok');
    expect(monitor.check(300 * MB).kind).toBe('ok');
  });

  it('warns once, not on every chunk', () => {
    const monitor = new MemoryMonitor(target, max);
    expect(monitor.check(450 * MB).kind).toBe('warning');
    // Same pressure, second look: warning already delivered.
    expect(monitor.check(460 * MB).kind).toBe('ok');
    expect(monitor.check(470 * MB).kind).toBe('ok');
  });

  it('aborts at the ceiling and explains what to do instead', () => {
    const monitor = new MemoryMonitor(target, max);
    const event = monitor.check(800 * MB);
    expect(event.kind).toBe('abort');
    if (event.kind === 'abort') {
      expect(event.message).toContain('archivo original está intacto');
      expect(event.message).toContain('escaneo básico');
    }
  });

  it('remembers the peak, not just the last reading', () => {
    const monitor = new MemoryMonitor(target, max);
    monitor.check(100 * MB);
    monitor.check(400 * MB);
    monitor.check(200 * MB);
    expect(monitor.peakBytes()).toBe(400 * MB);
  });
});

describe('SessionTelemetry', () => {
  it('keeps runs locally and scores estimates against reality', () => {
    const telemetry = new SessionTelemetry();
    telemetry.record({
      mode: 'standard-clean',
      startedAt: 0,
      elapsedMs: 1000,
      bytesProcessed: 100 * MB,
      bytesPerSecond: 100 * MB,
      rowsProcessed: 1000,
      finalHeapBytes: 200 * MB,
      peakHeapBytes: 220 * MB,
      estimatedMemoryBytes: 200 * MB,
      estimateRatio: 1.1,
      aborted: false,
    });
    telemetry.record({
      mode: 'basic-scan',
      startedAt: 0,
      elapsedMs: 1000,
      bytesProcessed: 100 * MB,
      bytesPerSecond: 100 * MB,
      rowsProcessed: 1000,
      finalHeapBytes: 16 * MB,
      peakHeapBytes: 16 * MB,
      aborted: false,
    });

    const summary = telemetry.summary();
    expect(summary.runs).toBe(2);
    expect(summary.totalBytes).toBe(200 * MB);
    expect(summary.peakHeapBytes).toBe(220 * MB);
    // Only the run that had an estimate contributes a ratio.
    expect(summary.estimateRatios).toEqual([1.1]);
    expect(Number.isFinite(summary.meanBytesPerSecond)).toBe(true);
  });

  it('survives an empty session without dividing by zero', () => {
    const summary = new SessionTelemetry().summary();
    expect(summary.runs).toBe(0);
    expect(summary.meanBytesPerSecond).toBe(0);
    expect(Number.isNaN(summary.meanBytesPerSecond)).toBe(false);
  });
});

describe('applyMode', () => {
  it('basic scan turns off everything that costs memory per row', () => {
    const options = applyMode({ mode: 'basic-scan' });
    expect(options.scanOnly).toBe(true);
    expect(options.dropDuplicateRows).toBe(false);
  });

  it('global duplicates keeps the row table on and materialises columns', () => {
    const options = applyMode({ mode: 'global-duplicates' });
    expect(options.scanOnly).toBe(false);
    expect(options.dropDuplicateRows).toBe(true);
  });

  it('an explicit option beats whatever the mode implies', () => {
    const options = applyMode({ mode: 'basic-scan', dropDuplicateRows: true });
    expect(options.scanOnly).toBe(true);
    expect(options.dropDuplicateRows).toBe(true);
  });

  it('is a no-op without a mode', () => {
    const options = applyMode({ chunkBytes: 123 });
    expect(options.scanOnly).toBeUndefined();
    expect(options.chunkBytes).toBe(123);
  });
});
