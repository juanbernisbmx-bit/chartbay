import { describe, expect, it } from 'vitest';
import { buildModelDoctor, engineFindingFromInterpretation, type ModelContext } from '../src/modelDoctor';
import { interpretBreuschPagan, interpretVIF } from '../src/interpretation';
import { renderModelDoctor } from '../src/ui/modelDoctorView';

const context: ModelContext = {
  mode: 'regression', engine: 'lite', nObs: 100, droppedRows: 0, paramCount: 3,
  hasIntercept: true, standardErrorType: 'classic', hacMaxLags: null,
  functionalForm: 'lin-lin', hasCategorical: false, droppedFeatures: [],
  hasRestriction: false, binaryTarget: false, datasetHasDates: false,
  alpha: 0.05, converged: true,
};

describe('vista Model Doctor', () => {
  it('muestra cobertura, titular y los siete bloques del detalle', () => {
    const report = buildModelDoctor([
      engineFindingFromInterpretation(interpretBreuschPagan({ statistic: 12, pValue: 0.004, nObs: 100 })),
      engineFindingFromInterpretation(interpretVIF({ variable: 'x', value: 6 })),
    ], context);
    const html = renderModelDoctor(report);
    expect(html).toContain('MODEL DOCTOR');
    expect(html).toContain(`${report.coverage.evaluated} de ${report.coverage.applicable} evaluadas`);
    expect(html).toContain('Principal hallazgo:');
    for (let section = 1; section <= 7; section += 1) {
      expect(html).toContain(`${section} ·`);
    }
  });

  it('distingue insuficiente de ok por texto y clase, sin depender solo de color', () => {
    const html = renderModelDoctor(buildModelDoctor([], context));
    expect(html).toContain('qb-doctor-chip-insufficient');
    expect(html).toContain('sin evaluar');
    expect(html).toContain('Qué no puede decirte este diagnóstico');
  });

  it('prioriza un hallazgo accionable por encima de ejes sin evaluar', () => {
    const smallSample = { ...context, nObs: 8, paramCount: 2 };
    const html = renderModelDoctor(buildModelDoctor([
      engineFindingFromInterpretation(interpretBreuschPagan({ statistic: 0.3, pValue: 0.58, nObs: 8 })),
      engineFindingFromInterpretation(interpretVIF({ variable: 'x', value: 1 })),
    ], smallSample));
    expect(html).toContain('Hay 4.0 observaciones por parámetro');
    expect(html.indexOf('Datos y muestra')).toBeLessThan(html.indexOf('Especificación'));
  });

  it('escapa contenido no confiable y conserva enlaces de teoría internos', () => {
    const html = renderModelDoctor(buildModelDoctor([{
      id: 'unsafe', category: 'other', severity: 'warning', summary: '<img src=x onerror=alert(1)>',
      limitations: ['<script>bad()</script>'], recommendedChecks: [], recommendations: [],
      theoryConcepts: ['teoria-supuestos'],
    }], context));
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img');
    expect(html).toContain('/guia#teoria-supuestos');
  });
});
