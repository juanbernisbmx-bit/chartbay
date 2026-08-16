import { describe, expect, it, vi } from 'vitest';

import { renderDeviceProfile } from '../../../cleaner/js/deviceProfileView';
import { calculateMemoryBudget, type DeviceProfile } from '../../../cleaner/js/deviceProfiler';
import { preflight, type PreflightResult } from '../../../cleaner/js/preflight';

const MB = 1024 * 1024;

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

function fakeFile(totalBytes: number, head: string): Blob {
  return {
    size: totalBytes,
    slice(start = 0, end = totalBytes) {
      const text = head.slice(start, Math.min(end, head.length));
      return { text: async () => text } as unknown as Blob;
    },
  } as unknown as Blob;
}

const csvHead =
  'fecha;pais;pbi\n' +
  Array.from({ length: 500 }, (_, i) => `0${(i % 9) + 1}/03/2024;Argentina;1.234,50\n`).join('');

async function planFor(sizeBytes: number, profile: DeviceProfile): Promise<PreflightResult> {
  return preflight(fakeFile(sizeBytes, csvHead), calculateMemoryBudget(profile));
}

describe('renderDeviceProfile', () => {
  it('renders a summary a non-technical reader can act on', async () => {
    const profile = profileWith({ estimatedDeviceMemoryGB: 8, logicalCores: 8 });
    const plan = await planFor(50 * MB, profile);
    const container = document.createElement('div');

    renderDeviceProfile(container, { profile, budget: plan.budget, preflight: plan });

    const text = container.textContent ?? '';
    expect(text).toContain('Dispositivo y procesamiento');
    expect(text).toContain('SEGURO');
    expect(text).toContain('Núcleos');
    // The clamped value must not be presented as a precise reading.
    expect(text).toContain('8 GB o más');
    expect(container.querySelector('.cb-profile__badge--safe')).not.toBeNull();
  });

  it('never claims a memory figure the browser did not give', async () => {
    const profile = profileWith();
    const plan = await planFor(50 * MB, profile);
    const container = document.createElement('div');

    renderDeviceProfile(container, { profile, budget: plan.budget, preflight: plan });
    expect(container.textContent).toContain('no informada por el navegador');
  });

  it('hides the technical numbers behind an expander, and says they are estimates', async () => {
    const profile = profileWith({ estimatedDeviceMemoryGB: 8, jsHeapLimitBytes: 4096 * MB });
    const plan = await planFor(50 * MB, profile);
    const container = document.createElement('div');

    renderDeviceProfile(container, { profile, budget: plan.budget, preflight: plan });

    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    // Collapsed by default: the summary above is what most people should read.
    expect(details?.hasAttribute('open')).toBe(false);
    const detailText = details?.textContent ?? '';
    expect(detailText).toContain('Presupuesto de memoria');
    expect(detailText).toContain('wasm32');
    expect(detailText).toContain('APIs disponibles');
    expect(detailText).toContain('estimaciones');
  });

  it('shows a verdict per mode and reports the choice back', async () => {
    const profile = profileWith({ estimatedDeviceMemoryGB: 4 });
    const plan = await planFor(3000 * MB, profile);
    const onModeChange = vi.fn();
    const container = document.createElement('div');

    renderDeviceProfile(container, {
      profile,
      budget: plan.budget,
      preflight: plan,
      onModeChange,
    });

    const buttons = container.querySelectorAll<HTMLButtonElement>('.cb-profile__mode');
    expect(buttons.length).toBe(4);
    // A 3 GB file on a 4 GB device: scanning is fine, the heavier modes are not.
    expect(buttons[0].dataset.status).toBe('safe');
    expect(buttons[3].dataset.status).not.toBe('safe');

    buttons[1].click();
    expect(onModeChange).toHaveBeenCalledWith('standard-clean');
  });

  it('renders before a file is chosen, with only the device half', () => {
    const profile = profileWith({ estimatedDeviceMemoryGB: 8 });
    const container = document.createElement('div');
    expect(() =>
      renderDeviceProfile(container, { profile, budget: calculateMemoryBudget(profile) })
    ).not.toThrow();
    expect(container.textContent).toContain('Memoria reservada');
    expect(container.textContent).not.toContain('Filas estimadas');
  });

  it('re-rendering replaces the panel instead of stacking copies', async () => {
    const profile = profileWith({ estimatedDeviceMemoryGB: 8 });
    const plan = await planFor(50 * MB, profile);
    const container = document.createElement('div');

    renderDeviceProfile(container, { profile, budget: plan.budget, preflight: plan });
    renderDeviceProfile(container, { profile, budget: plan.budget, preflight: plan });

    expect(container.querySelectorAll('.cb-profile__header').length).toBe(1);
  });
});
