import { describe, expect, it } from 'vitest';

import {
  calculateMemoryBudget,
  detectDeviceProfile,
  type DeviceProfile,
} from '../../../cleaner/js/deviceProfiler';
import {
  MAX_CHUNK_BYTES,
  MAX_TARGET_MEMORY_BYTES,
  MEMORY_TIERS,
  MIN_CHUNK_BYTES,
  MIN_TARGET_MEMORY_BYTES,
} from '../../../cleaner/js/processingLimits';

const MB = 1024 * 1024;
const GB = 1024 * MB;

function profileWith(overrides: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    wasmSupported: true,
    workersSupported: true,
    availableApis: {
      deviceMemory: overrides.estimatedDeviceMemoryGB !== undefined,
      hardwareConcurrency: overrides.logicalCores !== undefined,
      performanceMemory: overrides.jsHeapLimitBytes !== undefined,
      userAgentData: false,
    },
    ...overrides,
  };
}

describe('detectDeviceProfile', () => {
  it('reads every signal when the browser offers them (Chromium)', () => {
    const profile = detectDeviceProfile({
      navigatorRef: {
        deviceMemory: 8,
        hardwareConcurrency: 12,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
      } as never,
      performanceRef: { memory: { jsHeapSizeLimit: 4 * GB } },
    });

    expect(profile.estimatedDeviceMemoryGB).toBe(8);
    expect(profile.logicalCores).toBe(12);
    expect(profile.jsHeapLimitBytes).toBe(4 * GB);
    expect(profile.browser).toBe('Chrome');
    expect(profile.availableApis.deviceMemory).toBe(true);
    expect(profile.availableApis.performanceMemory).toBe(true);
  });

  it('survives Safari, which exposes neither memory API', () => {
    const profile = detectDeviceProfile({
      navigatorRef: {
        hardwareConcurrency: 8,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
      } as never,
      performanceRef: {},
    });

    expect(profile.estimatedDeviceMemoryGB).toBeUndefined();
    expect(profile.jsHeapLimitBytes).toBeUndefined();
    expect(profile.logicalCores).toBe(8);
    expect(profile.browser).toBe('Safari');
    expect(profile.availableApis.deviceMemory).toBe(false);
  });

  it('survives Firefox, and is not fooled by its user agent', () => {
    const profile = detectDeviceProfile({
      navigatorRef: {
        hardwareConcurrency: 16,
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
      } as never,
      performanceRef: undefined,
    });

    expect(profile.browser).toBe('Firefox');
    expect(profile.estimatedDeviceMemoryGB).toBeUndefined();
  });

  it('does not mistake Chrome for Safari or Edge for Chrome', () => {
    const edge = detectDeviceProfile({
      navigatorRef: { userAgent: 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36 Edg/120.0' } as never,
    });
    expect(edge.browser).toBe('Edge');
  });

  it('ignores nonsense values instead of propagating them', () => {
    const profile = detectDeviceProfile({
      navigatorRef: { deviceMemory: 0, hardwareConcurrency: Number.NaN } as never,
      performanceRef: { memory: { jsHeapSizeLimit: Number.POSITIVE_INFINITY } },
    });
    expect(profile.estimatedDeviceMemoryGB).toBeUndefined();
    expect(profile.logicalCores).toBeUndefined();
    expect(profile.jsHeapLimitBytes).toBeUndefined();
  });

  it('does not throw when reading performance.memory throws', () => {
    const hostile = {
      get memory(): never {
        throw new Error('blocked by embedder');
      },
    };
    expect(() => detectDeviceProfile({ performanceRef: hostile as never })).not.toThrow();
  });

  it('runs with no navigator at all', () => {
    const profile = detectDeviceProfile({
      navigatorRef: {} as never,
      performanceRef: {},
    });
    expect(profile.estimatedDeviceMemoryGB).toBeUndefined();
    expect(profile.browser).toBeUndefined();
  });
});

describe('calculateMemoryBudget', () => {
  it('4 GB device gets the smallest tier', () => {
    const budget = calculateMemoryBudget(profileWith({ estimatedDeviceMemoryGB: 4 }));
    expect(budget.targetMemoryBytes).toBe(256 * MB);
    expect(budget.recommendedChunkBytes).toBe(8 * MB);
    expect(budget.confidence).toBe('medium');
  });

  it('8 GB device gets the second tier', () => {
    // Raised from 512 MB to 1 GB: the old figure advised against a 500 MB file
    // that measurably works (727 MB of real WASM heap). Still ~12 % of the
    // machine, so the posture stays conservative.
    const budget = calculateMemoryBudget(profileWith({ estimatedDeviceMemoryGB: 8 }));
    expect(budget.targetMemoryBytes).toBe(1024 * MB);
    expect(budget.recommendedChunkBytes).toBe(16 * MB);
  });

  it('16 GB and 32 GB tiers are reachable through an explicit override', () => {
    const sixteen = calculateMemoryBudget(
      profileWith({ estimatedDeviceMemoryGB: 16, memoryOverrideApplied: true })
    );
    expect(sixteen.targetMemoryBytes).toBe(1.25 * GB);
    expect(sixteen.recommendedChunkBytes).toBe(32 * MB);

    const thirtyTwo = calculateMemoryBudget(
      profileWith({ estimatedDeviceMemoryGB: 32, memoryOverrideApplied: true })
    );
    expect(thirtyTwo.targetMemoryBytes).toBe(1.5 * GB);
    expect(thirtyTwo.recommendedChunkBytes).toBe(64 * MB);
  });

  it('treats a clamped deviceMemory of 8 as a floor, not a value', () => {
    // The spec clamps navigator.deviceMemory at 8, so a 64 GB workstation is
    // indistinguishable from an 8 GB laptop. Confidence must reflect that.
    const clamped = calculateMemoryBudget(
      profileWith({ estimatedDeviceMemoryGB: 8, jsHeapLimitBytes: 4 * GB })
    );
    expect(clamped.confidence).toBe('medium');
    expect(clamped.reason).toContain('máximo que la especificación');

    const overridden = calculateMemoryBudget(
      profileWith({
        estimatedDeviceMemoryGB: 8,
        jsHeapLimitBytes: 4 * GB,
        memoryOverrideApplied: true,
      })
    );
    expect(overridden.confidence).toBe('high');
  });

  it('the tier ladder is strictly increasing', () => {
    // A rung equal to the one below it is a rung that does nothing: tierFor
    // picks the first tier the device fits under, so a duplicate target makes
    // the upper tier unreachable in effect. This happened once already, when
    // raising the 8 GB rung to 1 GB left it level with the 16 GB one.
    for (let i = 1; i < MEMORY_TIERS.length; i++) {
      const lower = MEMORY_TIERS[i - 1];
      const upper = MEMORY_TIERS[i];
      expect(upper.maxDeviceMemoryGB).toBeGreaterThan(lower.maxDeviceMemoryGB);
      expect(upper.targetMemoryBytes).toBeGreaterThan(lower.targetMemoryBytes);
      expect(upper.chunkBytes).toBeGreaterThanOrEqual(lower.chunkBytes);
    }
  });

  it('every tier stays inside the absolute bounds and the chunk range', () => {
    for (const tier of MEMORY_TIERS) {
      expect(tier.targetMemoryBytes).toBeGreaterThanOrEqual(MIN_TARGET_MEMORY_BYTES);
      expect(tier.targetMemoryBytes).toBeLessThanOrEqual(MAX_TARGET_MEMORY_BYTES);
      expect(tier.chunkBytes).toBeGreaterThanOrEqual(MIN_CHUNK_BYTES);
      expect(tier.chunkBytes).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    }
  });

  it('unknown device falls back to the conservative profile with low confidence', () => {
    const budget = calculateMemoryBudget(profileWith());
    expect(budget.targetMemoryBytes).toBe(256 * MB);
    expect(budget.recommendedChunkBytes).toBe(8 * MB);
    expect(budget.confidence).toBe('low');
    expect(budget.reason).toContain('conservador');
  });

  it('a small JS heap limit overrides a generous tier', () => {
    const budget = calculateMemoryBudget(
      profileWith({
        estimatedDeviceMemoryGB: 8,
        // A 512 MB JS heap ceiling: half of it is well below the 1 GB tier target.
        jsHeapLimitBytes: 512 * MB,
      })
    );
    expect(budget.targetMemoryBytes).toBe(256 * MB);
    expect(budget.reason).toContain('heap de JavaScript');
  });

  it('never returns a target outside the absolute bounds', () => {
    const tiny = calculateMemoryBudget(
      profileWith({ estimatedDeviceMemoryGB: 4, jsHeapLimitBytes: 1 * MB })
    );
    expect(tiny.targetMemoryBytes).toBe(MIN_TARGET_MEMORY_BYTES);

    const huge = calculateMemoryBudget(
      profileWith({ estimatedDeviceMemoryGB: 1024, memoryOverrideApplied: true })
    );
    expect(huge.targetMemoryBytes).toBeLessThanOrEqual(MAX_TARGET_MEMORY_BYTES);
  });

  it('keeps the chunk size inside its bounds for every device', () => {
    const devices = [undefined, 0.5, 2, 4, 8, 16, 32, 128, 4096];
    for (const gb of devices) {
      const budget = calculateMemoryBudget(
        profileWith(
          gb === undefined
            ? {}
            : { estimatedDeviceMemoryGB: gb, memoryOverrideApplied: true }
        )
      );
      expect(budget.recommendedChunkBytes).toBeGreaterThanOrEqual(MIN_CHUNK_BYTES);
      expect(budget.recommendedChunkBytes).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    }
  });

  it('produces finite numbers for every input, including hostile ones', () => {
    const cases: Partial<DeviceProfile>[] = [
      {},
      { estimatedDeviceMemoryGB: 0.25 },
      { estimatedDeviceMemoryGB: 8, jsHeapLimitBytes: 1 },
      { estimatedDeviceMemoryGB: 1e9, memoryOverrideApplied: true },
      { jsHeapLimitBytes: 64 * MB },
    ];
    for (const overrides of cases) {
      const budget = calculateMemoryBudget(profileWith(overrides));
      for (const value of [
        budget.targetMemoryBytes,
        budget.maxMemoryBytes,
        budget.recommendedChunkBytes,
      ]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(Number.isNaN(value)).toBe(false);
        expect(value).toBeGreaterThan(0);
      }
      expect(budget.maxMemoryBytes).toBeGreaterThan(budget.targetMemoryBytes);
    }
  });
});
