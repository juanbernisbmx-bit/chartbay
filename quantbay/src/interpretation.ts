import type { RegressionResult } from './regression';

export function interpret(result: RegressionResult): string {
  const { rSquared, adjustedRSquared, featureNames, coefficients, yName, nObs } =
    result;
  const r2pct = (rSquared * 100).toFixed(1);
  const ar2pct = (adjustedRSquared * 100).toFixed(1);
  const quality =
    rSquared >= 0.8 ? 'muy bueno' : rSquared >= 0.5 ? 'moderado' : 'débil';

  const lines: string[] = [
    `El modelo explica el ${r2pct}% de la variación en "${yName}" (R² = ${rSquared.toFixed(4)}).`,
    `El ajuste es ${quality} (R² ajustado = ${ar2pct}%, n = ${nObs} observaciones).`,
    '',
    'Lectura de coeficientes (manteniendo el resto constante):',
    ...featureNames.map((name, i) => {
      const c = coefficients[i];
      const dir = c > 0 ? 'aumenta' : 'disminuye';
      return `  • Por cada unidad de aumento en "${name}", "${yName}" ${dir} en ${Math.abs(c).toFixed(4)} unidades.`;
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
