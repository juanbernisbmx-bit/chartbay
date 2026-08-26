import type {
  ADFInput,
  AcfPacfInput,
  ArimaInput,
  BreuschPaganInput,
  CoefficientInput,
  ForecastInput,
  HypothesisTestInput,
  InterpretableResult,
  InterpretationResult,
  LjungBoxInput,
  ModelFitInput,
  VIFInput,
} from './types';

export const DEFAULT_ALPHA = 0.05;
export const SUPPORTED_ALPHA = [0.1, 0.05, 0.01] as const;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function normalizeAlpha(alpha?: number): number {
  return finite(alpha) && alpha > 0 && alpha < 1 ? alpha : DEFAULT_ALPHA;
}

function alphaText(alpha?: number): string {
  return normalizeAlpha(alpha).toFixed(2);
}

function insufficient(
  id: string,
  title: string,
  category: InterpretationResult['category'],
  diagnosticCategory?: string
): InterpretationResult {
  return {
    id,
    severity: 'neutral',
    category,
    title,
    summary: 'No hay información suficiente para generar una interpretación fiable.',
    limitations: ['El resultado es faltante, no finito o incompleto.'],
    nextSteps: [{ label: 'Revisar los datos y el resultado calculado.' }],
    theoryConcepts: [],
    recommendedChecks: ['completitud_del_resultado'],
    diagnosticCategory,
    applicability: 'unavailable',
    unavailableReason: 'invalid_result',
    confidenceHint: 'low',
  };
}

export function interpretPValue(pValue: number | null | undefined, alpha?: number): {
  available: boolean;
  reject: boolean;
  conclusion: string;
} {
  const a = normalizeAlpha(alpha);
  if (!finite(pValue) || pValue < 0 || pValue > 1) {
    return { available: false, reject: false, conclusion: 'El p-value no está disponible o no es válido.' };
  }
  const reject = pValue <= a;
  return {
    available: true,
    reject,
    conclusion: reject
      ? `Con α = ${a.toFixed(2)}, existe evidencia estadística suficiente para rechazar H₀.`
      : `Con α = ${a.toFixed(2)}, no existe evidencia estadística suficiente para rechazar H₀.`,
  };
}

function coefficientMeaning(input: CoefficientInput): string {
  const beta = input.estimate as number;
  const name = input.name || 'la variable';
  if (input.kind === 'intercept') {
    return 'El intercepto es el valor estimado de Y cuando todos los regresores valen cero; puede no tener una interpretación económica si cero queda fuera del rango observado.';
  }
  if (input.kind === 'dummy') {
    const base = input.baseCategory ? ` "${input.baseCategory}"` : ' de referencia';
    return `El coeficiente representa la diferencia estimada respecto de la categoría${base}, manteniendo constantes las demás variables.`;
  }
  if (input.kind === 'interaction') {
    return 'El coeficiente de interacción no es un efecto total aislado: el efecto de una variable depende del valor de la otra.';
  }
  switch (input.functionalForm ?? 'lin-lin') {
    case 'log-lin':
      { const exact = 100 * (Math.exp(beta) - 1);
        return `Una unidad adicional en "${name}" se asocia con aproximadamente ${(100 * beta).toFixed(2)}% de cambio en Y; ` +
          (Number.isFinite(exact) ? `el cambio exacto para una unidad es ${exact.toFixed(2)}%.` : 'el cambio exacto no es numéricamente representable para esta estimación.'); }
    case 'lin-log':
      return `Un aumento de 1% en "${name}" se asocia aproximadamente con un cambio de ${(beta / 100).toFixed(4)} unidades en Y.`;
    case 'log-log':
      return `El coeficiente es una elasticidad: 1% más en "${name}" se asocia aproximadamente con ${beta.toFixed(4)}% de cambio en Y.`;
    default:
      return `Una unidad adicional en "${name}" se asocia con un cambio de ${beta.toFixed(4)} unidades en Y, manteniendo constantes las demás variables.`;
  }
}

export function interpretCoefficient(input: CoefficientInput): InterpretationResult {
  if (!finite(input.estimate)) return insufficient(`coefficient:${input.name}`, input.name || 'Coeficiente', 'coefficient', 'coefficient');
  const decision = interpretPValue(input.pValue, input.alpha);
  const sign = input.estimate > 0 ? 'positivo' : input.estimate < 0 ? 'negativo' : 'igual a cero';
  const intervalContainsZero = input.confidenceInterval && finite(input.confidenceInterval[0]) && finite(input.confidenceInterval[1])
    ? input.confidenceInterval[0] <= 0 && input.confidenceInterval[1] >= 0
    : undefined;
  const significance = decision.available
    ? decision.reject ? 'estadísticamente significativo' : 'no estadísticamente significativo'
    : 'con significancia estadística no disponible';
  const evidence = [
    `β = ${input.estimate.toFixed(4)}`,
    finite(input.stdError) ? `SE = ${input.stdError.toFixed(4)}` : null,
    finite(input.statistic) ? `t/z = ${input.statistic.toFixed(4)}` : null,
    finite(input.pValue) ? `p = ${input.pValue.toFixed(4)}` : null,
    input.confidenceInterval && finite(input.confidenceInterval[0]) && finite(input.confidenceInterval[1])
      ? `IC = [${input.confidenceInterval[0].toFixed(4)}, ${input.confidenceInterval[1].toFixed(4)}]`
      : null,
  ].filter(Boolean).join(' · ');
  return {
    id: `coefficient:${input.name}`,
    severity: decision.available && decision.reject ? 'positive' : 'neutral',
    category: 'coefficient',
    title: input.kind === 'intercept' ? 'Intercepto' : `Coeficiente: ${input.name}`,
    summary: `El coeficiente estimado es ${sign} y ${significance} al nivel seleccionado.`,
    statisticalConclusion: `${evidence}. ${decision.conclusion}`,
    practicalMeaning: coefficientMeaning(input),
    limitations: [
      'La significancia estadística no demuestra causalidad ni determina si la magnitud es económicamente importante.',
      ...(finite(input.nObs) && input.nObs < 30 ? ['La muestra es pequeña; la inferencia puede tener baja potencia y ser sensible a los supuestos de muestra finita.'] : []),
      ...(intervalContainsZero === true ? ['El intervalo de confianza contiene cero, por lo que es compatible con efectos de ambos signos o con ausencia de efecto al nivel correspondiente.'] : []),
    ],
    nextSteps: [{ label: 'Evaluar unidades, intervalo de confianza y relevancia económica.' }],
    theoryConcepts: ['teoria-ols', 'teoria-inferencia', 'teoria-formas'],
    recommendedChecks: ['forma_funcional', 'exogeneidad', 'intervalo_confianza'],
    diagnosticCategory: 'coefficient',
    evidence: {
      testName: 't/z del coeficiente',
      statistic: input.statistic,
      pValue: input.pValue,
      threshold: normalizeAlpha(input.alpha),
      sampleSize: input.nObs,
    },
    impactHint: 'reading',
  };
}

export function interpretModelFit(input: ModelFitInput): InterpretationResult {
  if (!finite(input.rSquared) || !finite(input.adjustedRSquared)) return insufficient('model-fit', 'Ajuste del modelo', 'model_fit', 'globalSignificance');
  const global = interpretPValue(input.fPValue, input.alpha);
  return {
    id: 'model-fit',
    severity: global.available && global.reject ? 'positive' : 'neutral',
    category: 'model_fit',
    title: 'Ajuste y significancia global',
    summary: `La especificación explica ${(input.rSquared * 100).toFixed(1)}% de la variación muestral de Y; el R² ajustado es ${(input.adjustedRSquared * 100).toFixed(1)}%.`,
    statisticalConclusion: global.available
      ? `${finite(input.fStatistic) ? `F = ${input.fStatistic.toFixed(4)} · ` : ''}${finite(input.fPValue) ? `p = ${input.fPValue.toFixed(4)}. ` : ''}${global.conclusion} En el test F global, H₀ establece que todas las pendientes son cero en conjunto.`
      : 'La significancia global no puede interpretarse porque falta un p-value F válido.',
    practicalMeaning: 'El R² ajustado penaliza la incorporación de regresores y puede ayudar a comparar especificaciones relacionadas estimadas sobre la misma muestra.',
    limitations: [
      'Un R² alto no demuestra causalidad ni garantiza una especificación correcta o buena predicción fuera de muestra.',
      ...(input.hasIntercept === false ? ['La regresión no tiene intercepto: R² y algunas identidades usuales requieren una lectura distinta.'] : []),
    ],
    nextSteps: [{ label: 'Revisar residuos, supuestos y desempeño fuera de muestra.' }],
    theoryConcepts: ['teoria-ols', 'teoria-inferencia', 'teoria-intervalos'],
    recommendedChecks: ['residuos', 'heterocedasticidad', 'especificacion'],
    diagnosticCategory: 'globalSignificance',
    evidence: {
      testName: 'F global',
      statistic: input.fStatistic,
      pValue: input.fPValue,
      threshold: normalizeAlpha(input.alpha),
      sampleSize: input.nObs,
    },
    impactHint: 'reading',
  };
}

export function interpretFTest(input: HypothesisTestInput): InterpretationResult {
  const decision = interpretPValue(input.pValue, input.alpha);
  if (!finite(input.statistic) || !decision.available) return insufficient('f-test', input.title ?? 'Test F', 'inference', 'globalSignificance');
  return {
    id: 'f-test', severity: decision.reject ? 'warning' : 'neutral', category: 'inference',
    title: input.title ?? 'Test F global',
    summary: decision.conclusion,
    statisticalConclusion: `H₀: ${input.hypothesis ?? 'las pendientes son conjuntamente iguales a cero'}. F = ${input.statistic.toFixed(4)}, p = ${(input.pValue as number).toFixed(4)}.`,
    practicalMeaning: 'El contraste evalúa una hipótesis conjunta; no valida por sí solo la especificación completa.',
    limitations: ['El resultado depende de la matriz de covarianza y de los supuestos del contraste.'],
    nextSteps: [], theoryConcepts: ['teoria-inferencia', 'teoria-intervalos'],
    recommendedChecks: ['covarianza_utilizada'],
    diagnosticCategory: 'globalSignificance',
    evidence: {
      testName: input.title ?? 'Test F global',
      statistic: input.statistic,
      pValue: input.pValue,
      threshold: normalizeAlpha(input.alpha),
      sampleSize: input.nObs,
    },
    impactHint: 'inference',
  };
}

export function interpretWald(input: HypothesisTestInput): InterpretationResult {
  const out = interpretFTest({ ...input, title: input.title ?? 'Restricción lineal (Wald/F)' });
  return {
    ...out,
    id: 'wald',
    statisticalConclusion: `${out.statisticalConclusion ?? ''}${finite(input.restrictions) ? ` Restricciones evaluadas: ${input.restrictions}.` : ''}`,
    practicalMeaning: out.severity === 'warning'
      ? 'Los datos no son compatibles con la restricción al nivel seleccionado; esto no invalida automáticamente el resto del modelo.'
      : 'No se encontró evidencia suficiente contra la restricción; esto no la demuestra verdadera.',
    theoryConcepts: ['teoria-intervalos', 'teoria-supuestos'],
    diagnosticCategory: 'restrictions',
    evidence: {
      testName: input.title ?? 'Wald/F',
      statistic: input.statistic,
      pValue: input.pValue,
      df: input.restrictions,
      threshold: normalizeAlpha(input.alpha),
      sampleSize: input.nObs,
    },
    impactHint: 'inference',
  };
}

export function interpretBreuschPagan(input: BreuschPaganInput): InterpretationResult {
  const decision = interpretPValue(input.pValue, input.alpha);
  if (!finite(input.statistic) || !decision.available) return insufficient('breusch-pagan', 'Breusch-Pagan', 'assumption', 'heteroskedasticity');
  return {
    id: 'breusch-pagan', severity: decision.reject ? 'warning' : 'neutral', category: 'assumption',
    title: 'Breusch-Pagan',
    summary: decision.reject ? 'Hay evidencia compatible con heterocedasticidad.' : 'No se encontró evidencia suficiente de heterocedasticidad con este test.',
    statisticalConclusion: `${decision.conclusion} H₀ establece homocedasticidad; H₁, varianza condicional no constante.`,
    practicalMeaning: decision.reject
      ? 'Bajo exogeneidad, OLS puede seguir siendo insesgado, pero los errores estándar convencionales pueden ser inadecuados y afectar la inferencia.'
      : 'No rechazar H₀ no demuestra homocedasticidad; el test puede tener baja potencia.',
    limitations: ['El test no identifica la causa de la heterocedasticidad ni corrige la especificación.'],
    nextSteps: decision.reject ? [{ label: 'Considerar errores estándar HC1/HC3.' }, { label: 'Inspeccionar residuos y revisar la especificación.' }] : [],
    theoryConcepts: ['teoria-bp', 'teoria-heterocedasticidad', 'teoria-robustos'],
    affectedAssumption: 'homocedasticidad', recommendedChecks: ['residuos_vs_ajustados', 'forma_funcional'],
    diagnosticCategory: 'heteroskedasticity',
    evidence: {
      testName: 'Breusch-Pagan',
      statistic: input.statistic,
      pValue: input.pValue,
      threshold: normalizeAlpha(input.alpha),
      sampleSize: input.nObs,
    },
    impactHint: 'inference',
  };
}

export function interpretVIF(input: VIFInput): InterpretationResult {
  if (!finite(input.value) || input.value < 1) return insufficient(`vif:${input.variable}`, `VIF: ${input.variable}`, 'multicollinearity', 'multicollinearity');
  const severity = input.value >= 10 ? 'warning' : 'neutral';
  const band = input.value >= 10 ? 'elevado' : input.value >= 5 ? 'moderado' : input.value <= 1.5 ? 'cercano a 1' : 'bajo';
  return {
    id: `vif:${input.variable}`, severity, category: 'multicollinearity', title: `VIF: ${input.variable}`,
    summary: `VIF = ${input.value.toFixed(2)}: nivel orientativo ${band}.`,
    practicalMeaning: input.value >= 5
      ? 'Puede haber poca variación independiente para estimar este coeficiente, aumentando su error estándar e inestabilidad.'
      : 'No aparece una inflación marcada de varianza según esta heurística.',
    limitations: ['Los valores 5 y 10 son reglas prácticas, no tests formales. Un VIF alto no implica automáticamente sesgo OLS ni obliga a eliminar la variable.'],
    nextSteps: input.value >= 5 ? [{ label: 'Revisar la relación entre regresores y el fundamento económico de cada control.' }] : [],
    theoryConcepts: ['teoria-vif'], affectedAssumption: 'ausencia de multicolinealidad severa', recommendedChecks: ['matriz_correlacion', 'especificacion'],
    diagnosticCategory: 'multicollinearity',
    evidence: { testName: `VIF de ${input.variable}`, statistic: input.value },
    impactHint: 'efficiency',
  };
}

export function interpretResiduals(residuals: number[]): InterpretationResult {
  const valid = residuals.filter(finite);
  if (valid.length === 0) return insufficient('residuals', 'Residuos', 'residuals', 'residuals');
  const mean = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  return {
    id: 'residuals', severity: 'neutral', category: 'residuals', title: 'Residuos',
    summary: `La media residual calculada es ${mean.toFixed(6)}.`,
    practicalMeaning: 'Con intercepto, una media cercana a cero es una identidad algebraica de OLS; no prueba exogeneidad, homocedasticidad ni ausencia de patrones.',
    limitations: ['No se infieren patrones visuales sin una métrica computada que los respalde.'],
    nextSteps: [{ label: 'Inspeccionar el gráfico de residuos contra ajustados y los diagnósticos formales.' }],
    theoryConcepts: ['teoria-ols', 'teoria-bp'], recommendedChecks: ['heterocedasticidad', 'autocorrelacion'],
    diagnosticCategory: 'residuals',
    evidence: { testName: 'Media residual', statistic: mean, sampleSize: valid.length },
    confidenceHint: 'low',
    impactHint: 'reading',
  };
}

export function interpretADF(input: ADFInput): InterpretationResult {
  let pValue = input.pValue;
  const a = normalizeAlpha(input.alpha);
  let critical: number | undefined;
  if (a === 0.01) critical = input.criticalValues?.onePercent;
  if (a === 0.05) critical = input.criticalValues?.fivePercent;
  if (a === 0.1) critical = input.criticalValues?.tenPercent;
  const criticalDecision = finite(input.statistic) && finite(critical) ? (input.statistic as number) <= critical : null;
  const pDecision = interpretPValue(pValue, a);
  const reject = criticalDecision ?? (pDecision.available ? pDecision.reject : null);
  if (reject === null) return insufficient('adf', 'ADF (raíz unitaria)', 'time_series', 'stationarity');
  const source = criticalDecision !== null ? 'comparación con el valor crítico correspondiente' : 'p-value';
  return {
    id: 'adf', severity: reject ? 'positive' : 'warning', category: 'time_series', title: 'ADF (raíz unitaria)',
    summary: reject ? 'Hay evidencia para rechazar la presencia de raíz unitaria según la especificación del test.' : 'No hay evidencia suficiente para rechazar la presencia de raíz unitaria.',
    statisticalConclusion: `Con α = ${alphaText(a)}, la decisión se basa en ${source}. H₀: raíz unitaria; H₁: estacionariedad según ${input.specification ?? 'la especificación elegida'}.`,
    practicalMeaning: reject ? 'El resultado es compatible con estacionariedad bajo esta especificación.' : 'La serie puede requerir transformación o una especificación ADF distinta antes de modelar su dinámica.',
    limitations: ['ADF puede tener baja potencia en muestras pequeñas; constante, tendencia y rezagos cambian la conclusión. No rechazar H₀ no confirma una raíz unitaria.'],
    nextSteps: reject ? [{ label: 'Revisar ACF/PACF y estabilidad de la especificación.' }] : [{ label: 'Revisar tendencia, rezagos y considerar diferenciación con criterio económico.' }],
    theoryConcepts: ['teoria-adf', 'teoria-estacionariedad'], affectedAssumption: 'estacionariedad', recommendedChecks: ['acf_pacf', 'especificacion_adf'],
    diagnosticCategory: 'stationarity',
    evidence: {
      testName: 'ADF',
      statistic: input.statistic,
      pValue: input.pValue,
      threshold: a,
      sampleSize: input.nObs,
    },
    impactHint: 'estimation',
  };
}

export function interpretLjungBox(input: LjungBoxInput): InterpretationResult {
  const decision = interpretPValue(input.pValue, input.alpha);
  if (!finite(input.statistic) || !decision.available) return insufficient(
    `ljung-box:${input.lag}`,
    'Ljung-Box',
    'time_series',
    input.residuals ? 'arimaResiduals' : 'serialCorrelation'
  );
  return {
    id: `ljung-box:${input.lag}`, severity: decision.reject ? 'warning' : 'positive', category: 'time_series', title: `Ljung-Box (hasta lag ${input.lag})`,
    summary: decision.reject
      ? `Existe evidencia de autocorrelación ${input.residuals ? 'residual ' : ''}conjunta.`
      : `No se encuentra evidencia suficiente de autocorrelación ${input.residuals ? 'residual ' : ''}conjunta hasta los rezagos evaluados.`,
    statisticalConclusion: `${decision.conclusion} H₀: ausencia conjunta de autocorrelación hasta el rezago ${input.lag}.`,
    practicalMeaning: decision.reject && input.residuals ? 'El modelo deja estructura temporal sin capturar.' : 'No rechazar H₀ es una buena señal diagnóstica, no una prueba de ruido blanco perfecto.',
    limitations: ['La conclusión sólo cubre los rezagos incluidos y la potencia disponible.'],
    nextSteps: decision.reject ? [{ label: 'Revisar ACF/PACF, orden del modelo y especificación.' }] : [],
    theoryConcepts: ['teoria-ljung-box', 'teoria-acf-pacf'], affectedAssumption: 'ausencia de autocorrelación', recommendedChecks: ['acf_pacf'],
    diagnosticCategory: input.residuals ? 'arimaResiduals' : 'serialCorrelation',
    evidence: {
      testName: 'Ljung-Box',
      statistic: input.statistic,
      pValue: input.pValue,
      threshold: normalizeAlpha(input.alpha),
      scope: input.residuals ? 'model_residuals' : 'series',
    },
    impactHint: input.residuals ? 'estimation' : 'reading',
  };
}

export function interpretAcfPacf(input: AcfPacfInput): InterpretationResult {
  const acf = input.significantAcfLags;
  const pacf = input.significantPacfLags;
  if (!finite(input.observations) || input.observations < 4) {
    return {
      ...insufficient('acf-pacf', 'ACF y PACF', 'time_series', 'modelIdentification'),
      summary: 'ACF y PACF no están disponibles porque la serie transformada tiene menos de 4 observaciones válidas.',
      limitations: ['Sin una muestra mínima no se calcularon bandas ni rezagos interpretables.'],
      nextSteps: [{ label: 'Revisar la columna de fecha, los valores inválidos y el tamaño de la muestra.' }],
      theoryConcepts: ['teoria-acf-pacf'],
      unavailableReason: 'sample_too_small',
      evidence: {
        testName: 'Bandas ACF/PACF',
        sampleSize: finite(input.observations) ? input.observations : null,
      },
      impactHint: 'reading',
    };
  }
  return {
    id: 'acf-pacf', severity: acf.length || pacf.length ? 'neutral' : 'positive', category: 'time_series', title: 'ACF y PACF',
    summary: acf.length || pacf.length
      ? `Se observan rezagos fuera de las bandas orientativas (ACF: ${acf.join(', ') || 'ninguno'}; PACF: ${pacf.join(', ') || 'ninguno'}).`
      : 'No se observan rezagos fuera de las bandas orientativas calculadas.',
    practicalMeaning: 'Los patrones pueden ser consistentes con persistencia o con órdenes AR/MA candidatos, pero no identifican automáticamente un modelo.',
    limitations: ['Las bandas son aproximadas y la lectura presupone una serie adecuadamente transformada y estacionaria.'],
    nextSteps: [{ label: 'Comparar modelos parsimoniosos con AIC/BIC y diagnosticar sus residuos.' }],
    theoryConcepts: ['teoria-acf-pacf', 'teoria-arima'], recommendedChecks: ['adf', 'ljung_box'],
    diagnosticCategory: 'modelIdentification',
    evidence: {
      testName: 'Bandas ACF/PACF',
      statistic: Math.max(acf.length, pacf.length),
      sampleSize: input.observations,
    },
    impactHint: 'reading',
  };
}

export function interpretArima(input: ArimaInput): InterpretationResult {
  return {
    id: 'arima', severity: input.converged === false ? 'critical' : 'neutral', category: 'time_series', title: `ARIMA(${input.p},${input.d},${input.q})`,
    summary: `El modelo usa ${input.p} término(s) AR, ${input.d} diferenciación(es) y ${input.q} término(s) MA.`,
    statisticalConclusion: [finite(input.aic) ? `AIC = ${input.aic.toFixed(3)}` : '', finite(input.bic) ? `BIC = ${input.bic.toFixed(3)}` : ''].filter(Boolean).join(' · ') || undefined,
    practicalMeaning: 'Es un modelo predictivo de dependencia temporal; no proporciona una explicación causal.',
    limitations: [input.converged === false ? 'El modelo no convergió: sus parámetros y pronósticos no son fiables.' : 'AIC y BIC sólo son comparables entre modelos estimados sobre la misma serie y muestra.'],
    nextSteps: input.converged === false ? [{ label: 'Probar un orden más simple y revisar estacionariedad.' }] : [{ label: 'Revisar Ljung-Box sobre residuos y comparar órdenes parsimoniosos.' }],
    theoryConcepts: ['teoria-arima', 'teoria-ljung-box'], recommendedChecks: ['convergencia', 'residuos_arima'],
    diagnosticCategory: 'modelIdentification',
    applicability: input.converged === false ? 'unavailable' : 'applies',
    unavailableReason: input.converged === false ? 'invalid_result' : undefined,
    confidenceHint: input.converged === false ? 'low' : 'medium',
    impactHint: 'estimation',
  };
}

export function interpretForecast(input: ForecastInput): InterpretationResult {
  if (!Number.isInteger(input.steps) || input.steps <= 0) return insufficient('forecast', 'Forecast', 'forecast', 'forecast');
  return {
    id: 'forecast', severity: input.converged === false ? 'critical' : 'neutral', category: 'forecast', title: 'Forecast',
    summary: `Se generó un pronóstico a ${input.steps} período(s)${finite(input.confidenceLevel) ? ` con intervalos al ${(100 * input.confidenceLevel).toFixed(0)}%` : ''}.`,
    practicalMeaning: 'Los intervalos expresan incertidumbre predictiva e incluyen shocks futuros no observados; no son una promesa ni una afirmación causal.',
    limitations: input.hasIntervals ? ['La validez depende de la estabilidad del patrón histórico y de la especificación ARIMA.'] : ['No hay intervalos completos: la incertidumbre predictiva no puede cuantificarse de forma fiable.'],
    nextSteps: [{ label: 'Evaluar el pronóstico fuera de muestra contra una referencia simple.' }],
    theoryConcepts: ['teoria-forecast', 'teoria-arima'], recommendedChecks: ['validacion_fuera_de_muestra'],
    diagnosticCategory: 'forecast',
    applicability: input.converged === false ? 'unavailable' : 'applies',
    unavailableReason: input.converged === false ? 'dependency_unmet' : undefined,
    confidenceHint: input.converged === false ? 'low' : 'medium',
    impactHint: 'reading',
  };
}

export function interpretResult(input: InterpretableResult): InterpretationResult {
  switch (input.type) {
    case 'coefficient': return interpretCoefficient(input.result);
    case 'model_fit': return interpretModelFit(input.result);
    case 'breusch_pagan': return interpretBreuschPagan(input.result);
    case 'vif': return interpretVIF(input.result);
    case 'adf': return interpretADF(input.result);
    case 'ljung_box': return interpretLjungBox(input.result);
    case 'acf_pacf': return interpretAcfPacf(input.result);
    case 'arima': return interpretArima(input.result);
    case 'forecast': return interpretForecast(input.result);
  }
}
