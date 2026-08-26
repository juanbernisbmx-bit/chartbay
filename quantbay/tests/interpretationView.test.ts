import { describe, expect, it } from 'vitest';
import { renderInterpretationResults } from '../src/ui/interpretationView';
import { interpretCoefficient } from '../src/interpretation';

describe('renderer de interpretación estructurada', () => {
  it('diferencia explícitamente cálculo e interpretación', () => {
    const html = renderInterpretationResults([
      interpretCoefficient({ name: 'x', estimate: 2, pValue: 0.01 }),
    ]);
    expect(html).toContain('INTERPRETACIÓN DE CHARTBAY');
    expect(html).toContain('No modifican ni reemplazan los valores numéricos');
    expect(html).toContain('<details open>');
  });

  it('usa disclosure y deja sólo el primer resultado abierto', () => {
    const html = renderInterpretationResults([
      interpretCoefficient({ name: 'x1', estimate: 2, pValue: 0.01 }),
      interpretCoefficient({ name: 'x2', estimate: 3, pValue: 0.2 }),
    ]);
    expect((html.match(/<details/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((html.match(/<details open>/g) ?? []).length).toBe(1);
  });

  it('enlaza IDs reales de la teoría', () => {
    const html = renderInterpretationResults([
      interpretCoefficient({ name: 'x', estimate: 2, pValue: 0.01 }),
    ]);
    expect(html).toContain('/guia#teoria-ols');
    expect(html).toContain('/guia#teoria-inferencia');
  });

  it('escapa nombres y textos antes de insertarlos en HTML', () => {
    const html = renderInterpretationResults([
      interpretCoefficient({ name: '<img src=x onerror=alert(1)>', estimate: 2, pValue: 0.01 }),
    ]);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});
