/**
 * What the browser will actually tell us about the machine, and what to do
 * with it.
 *
 * The honest framing matters here. A browser cannot report free RAM, and this
 * module does not pretend otherwise. What exists is a handful of coarse,
 * optional signals — none of them present in every browser, none of them
 * precise — and the job is to turn those into a conservative budget while
 * being explicit about how much confidence they support.
 *
 * Nothing in here throws when an API is missing. Safari exposes neither
 * `deviceMemory` nor `performance.memory`; Firefox exposes neither. That is the
 * common case, not the edge case, and it lands on the unknown-device profile.
 */

import {
  JS_HEAP_SAFETY_FACTOR,
  MAX_CHUNK_BYTES,
  MAX_TARGET_MEMORY_BYTES,
  MEMORY_SAFETY_FACTOR,
  MEMORY_TIERS,
  MIN_CHUNK_BYTES,
  MIN_TARGET_MEMORY_BYTES,
  UNKNOWN_DEVICE_CHUNK_BYTES,
  UNKNOWN_DEVICE_TARGET_BYTES,
} from './processingLimits';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DeviceProfile {
  /**
   * `navigator.deviceMemory`, in GB. Chromium only.
   *
   * It is RAM rounded *down* to a power of two, then clamped. The clamp bound
   * is implementation-defined: Chrome caps it at 8, so there a 32 GB machine
   * and an 8 GB one both report exactly 8 — but not every engine does, and a
   * browser reporting 16 has been observed. So the ambiguous value is 8
   * specifically ("8 or more"), not everything at or above it.
   */
  estimatedDeviceMemoryGB?: number;
  /** `navigator.hardwareConcurrency`. Widely available; may be capped for privacy. */
  logicalCores?: number;
  /** `performance.memory.jsHeapSizeLimit`. Chromium only, non-standard. */
  jsHeapLimitBytes?: number;
  wasmSupported: boolean;
  /** True when the module can run off the main thread. */
  workersSupported: boolean;
  browser?: string;
  platform?: string;
  /** Set when the caller supplied a real memory figure, e.g. a desktop shell. */
  memoryOverrideApplied?: boolean;
  /** Which signals were actually found. Drives `confidence` and the UI. */
  availableApis: {
    deviceMemory: boolean;
    hardwareConcurrency: boolean;
    performanceMemory: boolean;
    userAgentData: boolean;
  };
}

export type BudgetConfidence = 'low' | 'medium' | 'high';

export interface MemoryBudget {
  /** What we aim to stay under. */
  targetMemoryBytes: number;
  /** The wall. Past this the run aborts rather than risk the tab. */
  maxMemoryBytes: number;
  recommendedChunkBytes: number;
  confidence: BudgetConfidence;
  /** Plain-language account of how the number was reached. */
  reason: string;
}

export interface ProfileOptions {
  /**
   * Real device memory in GB, when the host knows it — an Electron or Tauri
   * shell can read it from the OS. Overrides the clamped browser value and
   * unlocks the tiers above 8 GB.
   */
  deviceMemoryOverrideGB?: number;
  /** Injected for tests. Defaults to the ambient globals. */
  navigatorRef?: Partial<Navigator> & Record<string, unknown>;
  performanceRef?: Record<string, unknown>;
}

// ── Detection ─────────────────────────────────────────────────────────────────

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Browser family, used only to explain the confidence level and to decide
 * whether an API is worth looking for. Never used to gate behaviour: feature
 * detection above decides that.
 */
function detectBrowser(userAgent: string | undefined): string | undefined {
  if (!userAgent) return undefined;
  // Order matters: Edge and Chrome both claim "Chrome", Chrome claims "Safari".
  if (/Edg\//.test(userAgent)) return 'Edge';
  if (/OPR\//.test(userAgent)) return 'Opera';
  if (/Firefox\//.test(userAgent)) return 'Firefox';
  if (/Chrome\//.test(userAgent)) return 'Chrome';
  if (/Safari\//.test(userAgent)) return 'Safari';
  return undefined;
}

function detectWasm(): boolean {
  try {
    if (typeof WebAssembly !== 'object') return false;
    return typeof WebAssembly.instantiate === 'function';
  } catch {
    return false;
  }
}

export function detectDeviceProfile(options: ProfileOptions = {}): DeviceProfile {
  const nav = options.navigatorRef ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  const perf =
    options.performanceRef ??
    (typeof performance !== 'undefined' ? (performance as unknown as Record<string, unknown>) : undefined);

  const deviceMemory = finitePositive((nav as Record<string, unknown> | undefined)?.deviceMemory);
  const cores = finitePositive((nav as Record<string, unknown> | undefined)?.hardwareConcurrency);

  // performance.memory is non-standard; reading it must never throw.
  let jsHeapLimit: number | undefined;
  let sawPerformanceMemory = false;
  try {
    const memory = perf?.memory as Record<string, unknown> | undefined;
    if (memory) {
      sawPerformanceMemory = true;
      jsHeapLimit = finitePositive(memory.jsHeapSizeLimit);
    }
  } catch {
    /* Some embedders throw on access rather than returning undefined. */
  }

  const uaData = (nav as Record<string, unknown> | undefined)?.userAgentData as
    | { platform?: string; brands?: unknown }
    | undefined;
  const userAgent = (nav as Record<string, unknown> | undefined)?.userAgent as string | undefined;

  const override = finitePositive(options.deviceMemoryOverrideGB);

  return {
    estimatedDeviceMemoryGB: override ?? deviceMemory,
    logicalCores: cores,
    jsHeapLimitBytes: jsHeapLimit,
    wasmSupported: detectWasm(),
    workersSupported: typeof Worker !== 'undefined',
    browser: detectBrowser(userAgent),
    platform: uaData?.platform ?? ((nav as Record<string, unknown> | undefined)?.platform as string | undefined),
    memoryOverrideApplied: override !== undefined,
    availableApis: {
      deviceMemory: deviceMemory !== undefined,
      hardwareConcurrency: cores !== undefined,
      performanceMemory: sawPerformanceMemory && jsHeapLimit !== undefined,
      userAgentData: uaData !== undefined,
    },
  };
}

// ── Budget ────────────────────────────────────────────────────────────────────

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function tierFor(memoryGB: number): (typeof MEMORY_TIERS)[number] {
  for (const tier of MEMORY_TIERS) {
    if (memoryGB <= tier.maxDeviceMemoryGB) return tier;
  }
  return MEMORY_TIERS[MEMORY_TIERS.length - 1];
}

function formatMB(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Turns a profile into a budget.
 *
 * The algorithm, in order:
 *
 * 1. Pick a tier from estimated device memory. With no memory signal at all,
 *    use the unknown-device defaults, which match the smallest tier.
 * 2. If `jsHeapSizeLimit` is known, cap the target at half of it. That number
 *    bounds the JS heap rather than WASM memory, but a process with a small JS
 *    ceiling is a constrained process, and the JS-side copies do live there.
 * 3. Clamp to the absolute floor and ceiling, so no tier or cap can produce
 *    something absurd.
 * 4. Derive the abort threshold as target × MEMORY_SAFETY_FACTOR.
 * 5. Clamp the chunk size into [MIN_CHUNK_BYTES, MAX_CHUNK_BYTES].
 *
 * Confidence reflects the inputs, not the arithmetic: two independent signals
 * is `high`, one is `medium`, none is `low`. A clamped `deviceMemory` of 8 is
 * downgraded, because it could mean anything from 8 GB to 128 GB.
 */
export function calculateMemoryBudget(profile: DeviceProfile): MemoryBudget {
  const reasons: string[] = [];
  const memoryGB = profile.estimatedDeviceMemoryGB;

  let target: number;
  let chunk: number;

  if (memoryGB === undefined) {
    target = UNKNOWN_DEVICE_TARGET_BYTES;
    chunk = UNKNOWN_DEVICE_CHUNK_BYTES;
    reasons.push(
      'El navegador no expone ninguna señal de memoria, así que se usa el perfil ' +
        `conservador (${formatMB(target)}).`
    );
  } else {
    const tier = tierFor(memoryGB);
    target = tier.targetMemoryBytes;
    chunk = tier.chunkBytes;
    if (profile.memoryOverrideApplied) {
      reasons.push(`Memoria informada por el entorno: ${memoryGB} GB.`);
    } else if (memoryGB === 8) {
      reasons.push(
        'navigator.deviceMemory informa 8 GB, que es donde varios navegadores topean ' +
          'el valor: la máquina puede tener 8 GB o mucho más. Se toma como 8.'
      );
    } else {
      reasons.push(`navigator.deviceMemory informa ~${memoryGB} GB.`);
    }
    reasons.push(`Presupuesto base del tramo: ${formatMB(target)}.`);
  }

  if (profile.jsHeapLimitBytes !== undefined) {
    const heapCap = profile.jsHeapLimitBytes * JS_HEAP_SAFETY_FACTOR;
    if (heapCap < target) {
      reasons.push(
        `Limitado a ${formatMB(heapCap)} porque el heap de JavaScript tope en ` +
          `${formatMB(profile.jsHeapLimitBytes)} y se reserva la mitad.`
      );
      target = heapCap;
    }
  }

  const clampedTarget = clamp(target, MIN_TARGET_MEMORY_BYTES, MAX_TARGET_MEMORY_BYTES);
  if (clampedTarget !== target) {
    reasons.push(
      `Ajustado a ${formatMB(clampedTarget)} por los límites absolutos configurados.`
    );
    target = clampedTarget;
  }

  const signals =
    (profile.availableApis.deviceMemory || profile.memoryOverrideApplied ? 1 : 0) +
    (profile.availableApis.performanceMemory ? 1 : 0);
  let confidence: BudgetConfidence = signals >= 2 ? 'high' : signals === 1 ? 'medium' : 'low';
  // Exactly 8 is where the common clamp lands, so it tells us a floor rather
  // than a value. A higher figure came from an engine that does not clamp
  // there, and is worth taking at face value.
  if (!profile.memoryOverrideApplied && memoryGB === 8 && confidence === 'high') {
    confidence = 'medium';
    reasons.push('Confianza reducida a media: el valor de deviceMemory está topeado.');
  }

  return {
    targetMemoryBytes: Math.round(target),
    maxMemoryBytes: Math.round(target * MEMORY_SAFETY_FACTOR),
    recommendedChunkBytes: Math.round(clamp(chunk, MIN_CHUNK_BYTES, MAX_CHUNK_BYTES)),
    confidence,
    reason: reasons.join(' '),
  };
}

/** Convenience: detect and budget in one call. */
export function profileDevice(options: ProfileOptions = {}): {
  profile: DeviceProfile;
  budget: MemoryBudget;
} {
  const profile = detectDeviceProfile(options);
  return { profile, budget: calculateMemoryBudget(profile) };
}
