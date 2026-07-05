import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

function readRepoFile(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

const APP = readRepoFile('web/app.py');
const QUANTBAY = readRepoFile('web/templates/quantbay.html');
const HOME = readRepoFile('web/templates/home.html');
const CHARTBAY = readRepoFile('web/templates/chartbay.html');
const GUIA = readRepoFile('web/templates/guia.html');

describe('ChartBay Agro navigation', () => {
  it('exposes Agro as its own Flask route with QuantBay CSP permissions', () => {
    expect(APP).toContain('@app.route("/agro")');
    expect(APP).toContain('quantbay_module="agro"');
    expect(APP).toContain('"/agro"');
  });

  it('links Agro from the main product hubs and QuantBay navbar', () => {
    for (const html of [HOME, CHARTBAY, QUANTBAY]) {
      expect(html).toContain("url_for('agro')");
      expect(html).toContain('Agro');
    }
  });

  it('renders QuantBay as either Econometria or Agro without duplicating the Agro panel', () => {
    expect(QUANTBAY).toContain("quantbay_module|default('econometria')");
    expect(QUANTBAY).toContain("data-qb-module=\"{{ qb_module }}\"");
    expect(QUANTBAY).toContain('qb-agro-initial');
    expect(QUANTBAY).toMatch(/\{% if qb_module == 'agro' %\}\s*<section class="qb-section" id="qb-agro-panel"/);
    expect(QUANTBAY.match(/id="qb-agro-panel"/g) ?? []).toHaveLength(1);
  });
});

describe('Documentation navigation cleanup', () => {
  it('uses the product navigation instead of legacy market/report options', () => {
    const navStart = GUIA.indexOf('<nav class="mainnav">');
    const navEnd = GUIA.indexOf('</nav>', navStart);
    const nav = GUIA.slice(navStart, navEnd);

    expect(nav).toContain("url_for('econometria')");
    expect(nav).toContain("url_for('agro')");
    expect(nav).toContain('Documentacion');
    expect(nav).not.toContain("url_for('reports')");
    expect(nav).not.toContain("url_for('compare_view')");
    expect(nav).not.toContain("url_for('heatmap')");
    expect(nav).not.toContain("url_for('community')");
  });

  it('starts with non-active guide panels hidden', () => {
    expect(GUIA).toContain('id="area-finanzas"');
    expect(GUIA).toContain('id="area-finanzas" data-area="finanzas" role="tabpanel" aria-labelledby="tab-finanzas" hidden');
    expect(GUIA).toContain('id="area-aprender" data-area="aprender" role="tabpanel" aria-labelledby="tab-aprender" hidden');
    expect(GUIA).toContain('function showDocumentationArea(id)');
  });

  it('switches guide tabs by leaving only one visible panel', () => {
    document.documentElement.innerHTML = GUIA;
    const script = GUIA.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/)?.[1];
    expect(script).toBeTruthy();
    new Function(script!)();

    document.getElementById('tab-aprender')!.click();

    expect(document.getElementById('area-aprender')!.hasAttribute('hidden')).toBe(false);
    expect(document.getElementById('area-econometria')!.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('area-finanzas')!.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('tab-aprender')!.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('tab-econometria')!.getAttribute('aria-selected')).toBe('false');
  });
});
