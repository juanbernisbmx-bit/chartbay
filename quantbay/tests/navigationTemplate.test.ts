import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHARTBAY_VERTICALS } from '../src/verticals/agro/agroFeatureFlags';

const ROOT = join(__dirname, '..', '..');

function readRepoFile(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

const APP = readRepoFile('web/app.py');
const TOPBAR = readRepoFile('web/templates/_topbar_v2.html');
const QUANTBAY = readRepoFile('web/templates/quantbay.html');
const GUIA = readRepoFile('web/templates/guia.html');

describe('ChartBay product navigation', () => {
  it('keeps Agro and Mercados disabled behind the current feature flags', () => {
    expect(APP).toContain('"econometria": True');
    expect(APP).toContain('"limpiador": True');
    expect(APP).toContain('"datos": False');
    expect(APP).toContain('"agro": False');
    expect(APP).toContain('"mercados": False');

    expect(CHARTBAY_VERTICALS).toEqual({
      econometria: true,
      agro: false,
      finanzas: false,
    });

    expect(APP).toContain('@app.route("/agro")');
    expect(APP).toMatch(/@app\.route\("\/agro"\)\s*@seccion\("agro"\)/);
    expect(APP).toContain('quantbay_module="agro"');
    expect(APP).toMatch(/@app\.route\("\/chartbay"\)\s*@seccion\("mercados"\)/);
  });

  it('shows active sections and feature-gates disabled ones in the shared navbar', () => {
    expect(TOPBAR).toContain("url_for('dashboard')");
    expect(TOPBAR).toContain("url_for('econometria')");
    expect(TOPBAR).toMatch(/\{% if secciones\.datos %\}[\s\S]*url_for\('frequent_data'\)[\s\S]*\{% endif %\}/);
    expect(TOPBAR).toContain("url_for('limpiador')");
    expect(TOPBAR).toContain("url_for('guia')");
    expect(TOPBAR).toContain("url_for('source_archive')");
    expect(TOPBAR).toContain('rel="source"');
    expect(TOPBAR).toContain('Código fuente');
    expect(TOPBAR).toMatch(/\{% if secciones\.agro %\}[\s\S]*url_for\('agro'\)[\s\S]*\{% endif %\}/);
    expect(TOPBAR).toMatch(/\{% if secciones\.mercados %\}[\s\S]*url_for\('finanzas'\)[\s\S]*\{% endif %\}/);
  });

  it('renders QuantBay as either Econometria or Agro without duplicating the Agro panel', () => {
    expect(QUANTBAY).toContain("quantbay_module|default('econometria')");
    expect(QUANTBAY).toContain("data-qb-module=\"{{ qb_module }}\"");
    expect(QUANTBAY).toContain('qb-agro-initial');
    expect(QUANTBAY).toMatch(/\{% if qb_module == 'agro' %\}\s*<section class="qb-section" id="qb-agro-panel"/);
    expect(QUANTBAY.match(/id="qb-agro-panel"/g) ?? []).toHaveLength(1);
    expect(QUANTBAY).toMatch(/id="qb-version-beta"[^>]*\shidden(?:\s|>)/);
    expect(QUANTBAY).not.toContain('MutationObserver');
  });
});

describe('Documentation navigation cleanup', () => {
  it('uses the shared product navigation instead of a legacy local navbar', () => {
    expect(GUIA).toContain("{% set active = 'guia' %}");
    expect(GUIA).toContain("{% include '_topbar_v2.html' with context %}");
    expect(GUIA).not.toContain('<nav class="mainnav">');
  });

  it('starts with non-active guide panels hidden', () => {
    expect(GUIA).toContain('id="area-aprender" data-area="aprender" role="tabpanel" aria-labelledby="tab-aprender" hidden');
    expect(GUIA).toContain('function showDocumentationArea(id)');
  });

  it('no longer ships the unplugged Finanzas area', () => {
    expect(GUIA).not.toContain('area-finanzas');
    expect(GUIA).not.toContain('tab-finanzas');
  });

  it('switches guide tabs by leaving only one visible panel', () => {
    document.documentElement.innerHTML = GUIA;
    const script = GUIA.match(/<script[^>]*>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/)?.[1];
    expect(script).toBeTruthy();
    new Function(script!)();

    document.getElementById('tab-aprender')!.click();

    expect(document.getElementById('area-aprender')!.hasAttribute('hidden')).toBe(false);
    expect(document.getElementById('area-econometria')!.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('tab-aprender')!.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('tab-econometria')!.getAttribute('aria-selected')).toBe('false');
  });
});
