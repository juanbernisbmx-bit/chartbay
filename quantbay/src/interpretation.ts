import type { RegressionResult } from './regression';

export function interpret(result: RegressionResult): string {
  const { rSquared, adjustedRSquared, featureNames, coefficients, yName, nObs, pValues } =
    result;
  const r2pct = (rSquared * 100).toFixed(1);
  const ar2pct = (adjustedRSquared * 100).toFixed(1);
  const quality =
    rSquared >= 0.8 ? 'muy bueno' : rSquared >= 0.5 ? 'moderado' : 'débil';
  const sigCount = pValues.slice(1).filter(p => p < 0.05).length;
  const totalCoef = featureNames.length;

  const lines: string[] = [
    `El modelo explica el ${r2pct}% de la variación en "${yName}" (R² = ${rSquared.toFixed(4)}).`,
    `El ajuste es ${quality} (R² ajustado = ${ar2pct}%, n = ${nObs} observaciones).`,
    '',
    sigCount === totalCoef
      ? 'Significancia: todas las variables son estadísticamente significativas (p < 0.05).'
      : sigCount === 0
      ? 'Significancia: ninguna variable resulta estadísticamente significativa (p < 0.05). El modelo puede estar mal especificado o los datos ser insuficientes.'
      : `Significancia: ${sigCount} de ${totalCoef} variable(s) son estadísticamente significativas (p < 0.05).`,
    '',
    'Lectura de coeficientes (manteniendo el resto constante):',
    ...featureNames.map((name, i) => {
      const c = coefficients[i];
      const dir = c > 0 ? 'aumenta' : 'disminuye';
      const pSig =
        pValues[i + 1] < 0.05 ? '' : ' (no significativo estadísticamente)';
      return `  • Por cada unidad de aumento en "${name}", "${yName}" ${dir} en ${Math.abs(c).toFixed(4)} unidades${pSig}.`;
    }),
    '',
    rSquared < 0.3
      ? '⚠ El R² bajo sugiere que las variables seleccionadas explican poca variación. Considerá agregar más predictores o revisar los datos.'
      : rSquared > 0.95
      ? '⚠ Un R² muy alto puede indicar sobreajuste o multicolinealidad. Verificá que las variables sean independientes entre sí.'
      : '',
    '',
    'Nota: OLS asume linealidad, homocedasticidad e independencia de los residuos. Verificá estos supuestos antes de usar el modelo.',
  ];

  return lines
    .filter((line, i, a) => !(line === '' && (i === 0 || a[i - 1] === '')))
    .join('\n');
}
