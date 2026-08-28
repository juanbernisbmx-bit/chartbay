import { beforeEach, describe, expect, it } from 'vitest';
import { renderVersionInfo } from '../src/ui/versionView';
import { getVersionConfig } from '../src/versioning/chartbayVersions';

beforeEach(() => {
  document.body.innerHTML = `
    <select id="qb-version"></select>
    <strong id="qb-version-engine"></strong>
    <strong id="qb-version-limit"></strong>
    <strong id="qb-version-status"></strong>
    <p id="qb-version-beta" hidden>Pro está en beta.</p>
    <p id="qb-version-desc"></p>`;
});

describe('renderVersionInfo', () => {
  it('shows Pro v1 as beta from the version configuration', () => {
    renderVersionInfo(getVersionConfig('pro'));

    expect(document.getElementById('qb-version-status')?.textContent).toBe('Beta');
    expect(document.getElementById('qb-version-beta')?.hidden).toBe(false);
    const desc = document.getElementById('qb-version-desc')?.textContent ?? '';
    expect(desc).toContain('ChartBay Pro v1');
    expect(desc).toContain('statsmodels');
    expect(desc).toContain('índice temporal opcional');
  });

  it('describe Lite por su motor, no por su lugar en una escalera', () => {
    renderVersionInfo(getVersionConfig('lite'));

    expect(document.getElementById('qb-version-status')?.textContent).toBe('Disponible');
    expect(document.getElementById('qb-version-beta')?.hidden).toBe(true);
    const desc = document.getElementById('qb-version-desc')?.textContent ?? '';
    expect(desc).toContain('Motor TypeScript');
    expect(desc).toContain('archivos grandes');
  });
});
