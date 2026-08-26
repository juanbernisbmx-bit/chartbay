import type { InterpretationResult } from '../interpretation/types';
import type {
  DoctorCategoryKey,
  DoctorConfidence,
  DoctorEvidenceStrength,
  DoctorFinding,
  DoctorImpact,
  DoctorOverallState,
  DoctorReport,
  DoctorSkipReason,
  DoctorState,
  EngineFinding,
  ModelContext,
} from './types';

const CATEGORY_ORDER: DoctorCategoryKey[] = [
  'sample',
  'specification',
  'residuals',
  'inference',
  'heteroskedasticity',
  'multicollinearity',
  'globalSignificance',
  'restrictions',
  'stationarity',
  'serialCorrelation',
  'modelIdentification',
  'arimaResiduals',
  'forecast',
  'stability',
  'other',
];

const CATEGORY_LABELS: Record<DoctorCategoryKey, string> = {
  sample: 'Datos y muestra',
  specification: 'Especificación',
  residuals: 'Residuos',
  inference: 'Inferencia',
  heteroskedasticity: 'Heterocedasticidad',
  multicollinearity: 'Multicolinealidad',
  globalSignificance: 'Significancia global',
  restrictions: 'Restricciones',
  stationarity: 'Estacionariedad',
  serialCorrelation: 'Autocorrelación',
  modelIdentification: 'Identificación temporal',
  arimaResiduals: 'Residuos del ARIMA',
  forecast: 'Pronóstico',
  stability: 'Estabilidad',
  other: 'Otro diagnóstico',
};

const THEORY_BY_CATEGORY: Record<DoctorCategoryKey, string[]> = {
  sample: ['teoria-supuestos'],
  specification: ['teoria-formas', 'teoria-supuestos'],
  residuals: ['teoria-ols', 'teoria-bp'],
  inference: ['teoria-inferencia', 'teoria-robustos'],
  heteroskedasticity: ['teoria-bp', 'teoria-heterocedasticidad', 'teoria-robustos'],
  multicollinearity: ['teoria-vif'],
  globalSignificance: ['teoria-inferencia', 'teoria-intervalos'],
  restrictions: ['teoria-inferencia', 'teoria-supuestos'],
  stationarity: ['teoria-adf', 'teoria-estacionariedad'],
  serialCorrelation: ['teoria-ljung-box', 'teoria-acf-pacf'],
  modelIdentification: ['teoria-acf-pacf', 'teoria-arima'],
  arimaResiduals: ['teoria-ljung-box', 'teoria-arima'],
  forecast: ['teoria-forecast', 'teoria-arima'],
  stability: ['teoria-supuestos'],
  other: ['teoria-supuestos'],
};

export const MODEL_DOCTOR_LIMITS = [
  'No puede establecer si una asociación es causal: eso depende del diseño de identificación.',
  'No puede descartar una variable omitida relevante ni decidir cuál es el modelo correcto.',
  'No puede verificar si la muestra representa a la población sin conocer cómo se recolectaron los datos.',
  'No puede decidir si una magnitud tiene sentido económico; esa lectura requiere teoría y unidades.',
  'Los tests tienen potencia limitada, supuestos propios y pueden dar señales contradictorias.',
];

const STATE_RANK: Record<DoctorState, number> = {
  not_applicable: 0,
  ok: 1,
  mitigated: 2,
  review: 3,
  problem: 4,
  insufficient: 5,
};

const IMPACT_RANK: Record<DoctorImpact, number> = { reading: 1, efficiency: 2, inference: 3, estimation: 4 };
const EVIDENCE_RANK: Record<DoctorEvidenceStrength, number> = { none: 0, borderline: 1, moderate: 2, strong: 3 };
const CONFIDENCE_RANK: Record<DoctorConfidence, number> = { low: 0, medium: 1, high: 2 };

const SKIP_REASONS = new Set<DoctorSkipReason>([
  'not_run',
  'engine_unavailable',
  'sample_too_small',
  'insufficient_df',
  'invalid_result',
  'dependency_unmet',
  'engine_tier',
  'model_shape',
]);
const KNOWN_SEVERITIES = new Set([
  'positive', 'warning', 'neutral', 'critical',
  'none', 'ok', 'info', 'low', 'borderline', 'high', 'violation',
  'unavailable', 'not_run', 'not_applicable',
]);

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function categoryOf(value: string): DoctorCategoryKey {
  return CATEGORY_ORDER.includes(value as DoctorCategoryKey) ? value as DoctorCategoryKey : 'other';
}

function theoryLabel(id: string): string {
  return id.replace(/^teoria-/, '').replace(/-/g, ' ');
}

function skipReason(value: string | undefined, fallback: DoctorSkipReason = 'engine_unavailable'): DoctorSkipReason {
  return value && SKIP_REASONS.has(value as DoctorSkipReason) ? value as DoctorSkipReason : fallback;
}

function evidenceStrength(finding: EngineFinding, alpha: number): DoctorEvidenceStrength {
  const pValue = finding.evidence?.pValue;
  if (finite(pValue) && pValue >= 0 && pValue <= 1) {
    if (pValue >= alpha / 2 && pValue <= 2 * alpha) return 'borderline';
    if (pValue < alpha / 5) return 'strong';
    if (pValue <= alpha) return 'moderate';
    return 'none';
  }
  const statistic = finding.evidence?.statistic;
  if (categoryOf(finding.category) === 'multicollinearity' && finite(statistic)) {
    if (statistic > 30) return 'strong';
    if (statistic > 10) return 'moderate';
    if (statistic >= 5) return 'borderline';
  }
  return finding.severity === 'critical' || finding.severity === 'high' ? 'strong' : 'none';
}

function confidenceOf(
  finding: EngineFinding,
  context: ModelContext,
  evidence: DoctorEvidenceStrength
): DoctorConfidence {
  if (finding.confidenceHint) return finding.confidenceHint;
  if (!KNOWN_SEVERITIES.has(finding.severity)) return 'low';
  const n = finding.evidence?.sampleSize ?? context.nObs;
  const category = categoryOf(finding.category);
  if ((category === 'heteroskedasticity' || category === 'stationarity') && finite(n) && n < 30) return 'low';
  if (context.paramCount > 0 && context.nObs / context.paramCount < 10) return 'low';
  if (evidence === 'borderline') return 'medium';
  if (finite(n) && n >= 100) return 'high';
  return 'medium';
}

function initialState(
  finding: EngineFinding,
  category: DoctorCategoryKey,
  evidence: DoctorEvidenceStrength,
  confidence: DoctorConfidence,
  alpha: number
): DoctorState {
  if (finding.applicability === 'not_applicable' || finding.severity === 'not_applicable') return 'not_applicable';
  if (finding.applicability === 'unavailable' || finding.severity === 'unavailable' || finding.severity === 'not_run') {
    return 'insufficient';
  }
  if (!KNOWN_SEVERITIES.has(finding.severity)) return 'review';
  if (evidence === 'borderline') return 'review';

  const statistic = finding.evidence?.statistic;
  const pValue = finding.evidence?.pValue;
  if (category === 'multicollinearity' && finite(statistic)) {
    if (statistic > 10) return 'problem';
    if (statistic >= 5) return 'review';
    return confidence === 'low' ? 'insufficient' : 'ok';
  }
  if (category === 'globalSignificance' && finite(pValue)) {
    return pValue <= alpha ? 'ok' : 'review';
  }
  if (category === 'serialCorrelation' && finding.evidence?.scope === 'series') {
    return confidence === 'low' ? 'insufficient' : 'ok';
  }
  if (category === 'modelIdentification' && finite(statistic) && statistic > 0 && finding.severity !== 'critical') {
    return 'review';
  }
  if (
    (category === 'heteroskedasticity' || category === 'stationarity' || category === 'arimaResiduals') &&
    finding.severity === 'warning'
  ) {
    return 'problem';
  }
  if (finding.severity === 'critical' || finding.severity === 'high' || finding.severity === 'violation') return 'problem';
  if (finding.severity === 'warning' || finding.severity === 'low' || finding.severity === 'borderline') return 'review';
  if (confidence === 'low') return 'insufficient';
  return 'ok';
}

function impactOf(finding: EngineFinding, category: DoctorCategoryKey): DoctorImpact {
  if (finding.impactHint) return finding.impactHint;
  switch (category) {
    case 'sample':
    case 'specification':
    case 'stationarity':
    case 'arimaResiduals': return 'estimation';
    case 'inference':
    case 'heteroskedasticity':
    case 'restrictions': return 'inference';
    case 'multicollinearity':
    case 'residuals': return 'efficiency';
    default: return 'reading';
  }
}

function evidenceLines(finding: EngineFinding, alpha: number): Array<{ label: string; value: string }> {
  const evidence = finding.evidence;
  if (!evidence) return [];
  const lines: Array<{ label: string; value: string }> = [];
  if (evidence.testName) lines.push({ label: 'Test', value: evidence.testName });
  if (finite(evidence.statistic)) lines.push({ label: 'Estadístico', value: evidence.statistic.toFixed(4) });
  if (finite(evidence.pValue)) lines.push({ label: 'p-value', value: evidence.pValue.toFixed(4) });
  if (finite(evidence.df)) lines.push({ label: 'Grados de libertad', value: String(evidence.df) });
  if (finite(evidence.threshold)) lines.push({ label: 'Umbral', value: evidence.threshold.toFixed(4) });
  else if (finite(evidence.pValue)) lines.push({ label: 'α', value: alpha.toFixed(2) });
  if (finite(evidence.sampleSize)) lines.push({ label: 'Observaciones', value: String(evidence.sampleSize) });
  return lines;
}

function fallbackRecommendation(category: DoctorCategoryKey): string {
  switch (category) {
    case 'sample': return 'Revisar el n efectivo, las filas excluidas y los grados de libertad.';
    case 'specification': return 'Comparar la forma funcional con teoría económica y revisar el gráfico de residuos.';
    case 'inference': return 'Revisar qué matriz de covarianza respalda los errores estándar, t, p e intervalos.';
    case 'heteroskedasticity': return 'Inspeccionar residuos contra ajustados y evaluar errores estándar robustos.';
    case 'multicollinearity': return 'Revisar la matriz de correlación y el rol teórico de cada regresor antes de quitar variables.';
    case 'stationarity': return 'Revisar la transformación, los términos determinísticos y los rezagos del ADF.';
    case 'serialCorrelation': return 'Revisar ACF, PACF y los rezagos evaluados.';
    case 'modelIdentification': return 'Comparar órdenes parsimoniosos y diagnosticar los residuos del modelo.';
    case 'arimaResiduals': return 'Revisar ACF/PACF de residuos, órdenes ARIMA y posibles componentes estacionales.';
    case 'forecast': return 'Validar el pronóstico fuera de muestra contra una referencia simple.';
    default: return 'Revisar la evidencia y el concepto teórico asociado antes de cambiar el modelo.';
  }
}

function normalizeFinding(finding: EngineFinding, context: ModelContext): DoctorFinding {
  const category = categoryOf(finding.category);
  const evidence = evidenceStrength(finding, context.alpha);
  const confidence = confidenceOf(finding, context, evidence);
  const state = initialState(finding, category, evidence, confidence, context.alpha);
  const recommendations = finding.recommendations.length > 0
    ? finding.recommendations
    : state === 'problem' || state === 'review'
      ? [{ text: fallbackRecommendation(category) }]
      : [];
  const theory = (finding.theoryConcepts.length > 0 ? finding.theoryConcepts : THEORY_BY_CATEGORY[category])
    .map(id => ({ id, label: theoryLabel(id) }));
  return {
    category,
    state,
    impact: impactOf(finding, category),
    evidence,
    confidence,
    headlineText: finding.summary || CATEGORY_LABELS[category],
    detail: {
      evidence: evidenceLines(finding, context.alpha),
      conclusion: finding.statisticalConclusion ?? finding.summary,
      whyItMatters: finding.practicalMeaning ?? 'Este resultado contextualiza qué parte del modelo puede leerse con confianza.',
      whatToCheck: recommendations,
      whatItDoesNot: finding.limitations,
      confidenceNote: confidence === 'low'
        ? 'Baja. La muestra, los grados de libertad o la información disponible no alcanzan para una conclusión firme.'
        : confidence === 'high'
          ? 'Alta para este diagnóstico puntual; no reemplaza la evaluación de supuestos que este test no cubre.'
          : 'Media. La conclusión se limita al test, la muestra y la especificación usados.',
      theory,
    },
    sources: [finding.id],
    appliedRules: [],
    insufficientReason: state === 'insufficient' ? skipReason(finding.unavailableReason) : undefined,
  };
}

function syntheticFinding(
  category: DoctorCategoryKey,
  state: DoctorState,
  impact: DoctorImpact,
  headlineText: string,
  detail: Partial<DoctorFinding['detail']> = {},
  options: Partial<Pick<DoctorFinding, 'evidence' | 'confidence' | 'sources' | 'appliedRules' | 'insufficientReason'>> = {}
): DoctorFinding {
  return {
    category,
    state,
    impact,
    evidence: options.evidence ?? 'none',
    confidence: options.confidence ?? 'medium',
    headlineText,
    detail: {
      evidence: detail.evidence ?? [],
      conclusion: detail.conclusion ?? headlineText,
      whyItMatters: detail.whyItMatters ?? 'Este eje cambia cómo deben leerse los resultados del modelo.',
      whatToCheck: detail.whatToCheck ?? (state === 'problem' || state === 'review'
        ? [{ text: fallbackRecommendation(category) }]
        : []),
      whatItDoesNot: detail.whatItDoesNot ?? ['Este resultado aislado no determina la calidad general del modelo.'],
      confidenceNote: detail.confidenceNote ?? 'Media. La lectura se limita a la información que ChartBay pudo evaluar.',
      theory: detail.theory ?? THEORY_BY_CATEGORY[category].map(id => ({ id, label: theoryLabel(id) })),
    },
    sources: options.sources ?? [],
    appliedRules: options.appliedRules ?? [],
    insufficientReason: options.insufficientReason,
  };
}

function missingFinding(category: DoctorCategoryKey, reason: DoctorSkipReason, explanation: string): DoctorFinding {
  return syntheticFinding(
    category,
    'insufficient',
    category === 'specification' || category === 'stationarity' ? 'estimation' : 'reading',
    `${CATEGORY_LABELS[category]}: información insuficiente`,
    {
      conclusion: explanation,
      whyItMatters: 'La ausencia de este diagnóstico no es evidencia de que el problema esté ausente.',
      whatToCheck: [{ text: fallbackRecommendation(category) }],
      whatItDoesNot: ['No significa que este eje esté resuelto ni que el supuesto se cumpla.'],
      confidenceNote: 'Baja. Este eje no pudo evaluarse con los resultados disponibles.',
    },
    { confidence: 'low', insufficientReason: reason }
  );
}

function mergeFinding(current: DoctorFinding | undefined, next: DoctorFinding): DoctorFinding {
  if (!current) return next;
  const nextWins = STATE_RANK[next.state] > STATE_RANK[current.state]
    || (STATE_RANK[next.state] === STATE_RANK[current.state] && IMPACT_RANK[next.impact] > IMPACT_RANK[current.impact])
    || (STATE_RANK[next.state] === STATE_RANK[current.state] && IMPACT_RANK[next.impact] === IMPACT_RANK[current.impact]
      && EVIDENCE_RANK[next.evidence] > EVIDENCE_RANK[current.evidence]);
  const winner = nextWins ? next : current;
  const other = nextWins ? current : next;
  return {
    ...winner,
    detail: {
      ...winner.detail,
      evidence: [...winner.detail.evidence, ...other.detail.evidence]
        .filter((line, index, all) => all.findIndex(candidate => candidate.label === line.label && candidate.value === line.value) === index),
      whatToCheck: [...winner.detail.whatToCheck, ...other.detail.whatToCheck]
        .filter((item, index, all) => all.findIndex(candidate => candidate.text === item.text) === index),
      whatItDoesNot: [...winner.detail.whatItDoesNot, ...other.detail.whatItDoesNot]
        .filter((item, index, all) => all.indexOf(item) === index),
      theory: [...winner.detail.theory, ...other.detail.theory]
        .filter((item, index, all) => all.findIndex(candidate => candidate.id === item.id) === index),
    },
    sources: Array.from(new Set([...winner.sources, ...other.sources])),
    appliedRules: Array.from(new Set([...winner.appliedRules, ...other.appliedRules])),
  };
}

function sampleFinding(context: ModelContext): DoctorFinding {
  const total = context.nObs + context.droppedRows;
  const droppedShare = total > 0 ? context.droppedRows / total : 0;
  const observationsPerParameter = context.paramCount > 0 ? context.nObs / context.paramCount : 0;
  const evidence = [
    { label: 'n efectivo', value: String(context.nObs) },
    { label: 'Filas excluidas', value: `${context.droppedRows} (${(droppedShare * 100).toFixed(1)}%)` },
    { label: 'Parámetros', value: String(context.paramCount) },
  ];
  if (!Number.isInteger(context.nObs) || context.nObs <= 0 || context.nObs <= context.paramCount) {
    return syntheticFinding('sample', 'insufficient', 'estimation', 'No hay grados de libertad suficientes para diagnosticar el modelo.', {
      evidence,
      conclusion: 'Las observaciones efectivas no superan a los parámetros estimados.',
      whyItMatters: 'Sin grados de libertad residuales no hay una base válida para inferencia ni diagnósticos posteriores.',
      whatToCheck: [{ text: 'Reducir la cantidad de parámetros o ampliar la muestra antes de interpretar el ajuste.' }],
    }, { confidence: 'low', insufficientReason: 'insufficient_df' });
  }
  if (droppedShare > 0.3) {
    return syntheticFinding('sample', 'problem', 'estimation', `Se excluyó ${(droppedShare * 100).toFixed(1)}% de las filas: la muestra estimada puede no representar al conjunto original.`, {
      evidence,
      conclusion: 'La exclusión por datos faltantes supera 30% de las filas disponibles.',
      whyItMatters: 'Si los faltantes no son aleatorios, los coeficientes pueden quedar sesgados.',
      whatToCheck: [{ text: 'Revisar en qué variables y grupos se concentran los faltantes.' }, { text: 'Reportar el n efectivo junto al modelo.' }],
      whatItDoesNot: ['No prueba que exista sesgo; identifica un riesgo que depende del mecanismo de faltantes.'],
    }, { evidence: 'strong', confidence: 'high', appliedRules: ['R11'] });
  }
  if (droppedShare > 0.1 || observationsPerParameter < 10) {
    return syntheticFinding('sample', 'review', droppedShare > 0.1 ? 'estimation' : 'efficiency',
      droppedShare > 0.1
        ? `Se excluyó ${(droppedShare * 100).toFixed(1)}% de las filas; conviene revisar el patrón de faltantes.`
        : `Hay ${observationsPerParameter.toFixed(1)} observaciones por parámetro: la estimación puede ser imprecisa.`, {
        evidence,
        conclusion: droppedShare > 0.1 ? 'La exclusión supera la referencia orientativa de 10%.' : 'La relación n/parámetros está por debajo de la referencia orientativa de 10.',
        whatToCheck: [{ text: 'Revisar el n efectivo, los faltantes y la sensibilidad a una especificación más parsimoniosa.' }],
      }, { evidence: 'borderline', confidence: context.nObs < 30 ? 'low' : 'medium', appliedRules: droppedShare > 0.1 ? ['R11'] : [] });
  }
  return syntheticFinding('sample', 'ok', 'efficiency', 'La muestra efectiva no muestra una señal inmediata por tamaño o exclusión de filas.', {
    evidence,
    conclusion: 'El n efectivo y los grados de libertad permiten ejecutar los diagnósticos disponibles.',
    whyItMatters: 'Una muestra suficiente mejora la precisión, pero no corrige sesgos de selección o especificación.',
  }, { confidence: context.nObs < 30 ? 'low' : context.nObs >= 100 ? 'high' : 'medium' });
}

function expectedCategories(context: ModelContext): DoctorCategoryKey[] {
  if (context.mode === 'timeseries') {
    return [
      'sample',
      'stationarity',
      'serialCorrelation',
      'modelIdentification',
      ...(context.timeSeries?.arimaOrders ? ['arimaResiduals' as const] : []),
      ...(context.timeSeries?.forecastHorizon ? ['forecast' as const] : []),
      'stability',
    ];
  }
  return [
    'sample',
    'specification',
    'residuals',
    'inference',
    'heteroskedasticity',
    'multicollinearity',
    'globalSignificance',
    ...(context.hasRestriction ? ['restrictions' as const] : []),
    ...(context.datasetHasDates ? ['serialCorrelation' as const] : []),
    'stability',
  ];
}

function setFinding(map: Map<DoctorCategoryKey, DoctorFinding>, finding: DoctorFinding): void {
  map.set(finding.category, mergeFinding(map.get(finding.category), finding));
}

function applyRules(
  map: Map<DoctorCategoryKey, DoctorFinding>,
  sourceFindings: EngineFinding[],
  context: ModelContext
): void {
  const hetero = map.get('heteroskedasticity');
  const inference = map.get('inference');
  const robust = context.standardErrorType !== 'classic';

  const residualSource = sourceFindings.find(finding => categoryOf(finding.category) === 'residuals');
  const residualMean = residualSource?.evidence?.statistic;
  if (context.hasIntercept && finite(residualMean) && Math.abs(residualMean) > 1e-6) {
    map.set('residuals', syntheticFinding('residuals', 'problem', 'estimation',
      'La media residual no es cercana a cero pese a que el modelo tiene intercepto.', {
        evidence: [{ label: 'Media residual', value: residualMean.toFixed(6) }],
        conclusion: 'La identidad algebraica de OLS con intercepto no se cumple dentro de la tolerancia numérica.',
        whyItMatters: 'Esto señala un resultado degenerado o un error de cálculo; no es un supuesto que deba corregir el estudiante.',
        whatToCheck: [{ text: 'Recalcular y revisar la matriz de diseño antes de interpretar cualquier coeficiente.' }],
        whatItDoesNot: ['No es evidencia de una relación económica ni un diagnóstico de exogeneidad.'],
      }, { evidence: 'strong', confidence: 'high', sources: residualSource ? [residualSource.id] : [] }));
  }

  if (hetero && hetero.state === 'problem' && inference && !robust) {
    map.set('inference', {
      ...inference,
      state: 'problem',
      impact: 'inference',
      evidence: hetero.evidence,
      confidence: hetero.confidence,
      headlineText: 'Tus errores estándar, t, p-valores e intervalos pueden no ser confiables con la covarianza clásica.',
      detail: {
        ...inference.detail,
        evidence: hetero.detail.evidence,
        conclusion: 'Breusch-Pagan detecta heterocedasticidad y el modelo usa errores estándar clásicos.',
        whyItMatters: 'Los coeficientes puntuales pueden seguir siendo insesgados bajo exogeneidad; la parte comprometida es la inferencia convencional.',
        whatToCheck: [{ text: 'Evaluar errores estándar robustos HC3 y revisar la especificación.' }, ...inference.detail.whatToCheck],
        whatItDoesNot: ['No significa que los coeficientes OLS estén automáticamente sesgados.', ...inference.detail.whatItDoesNot],
        theory: THEORY_BY_CATEGORY.inference.map(id => ({ id, label: theoryLabel(id) })),
      },
      sources: Array.from(new Set([...inference.sources, ...hetero.sources])),
      appliedRules: Array.from(new Set([...inference.appliedRules, 'R1'])),
      insufficientReason: undefined,
    });
  }

  if (hetero && hetero.state === 'problem' && robust) {
    map.set('heteroskedasticity', {
      ...hetero,
      state: 'mitigated',
      impact: 'efficiency',
      headlineText: `La heterocedasticidad está atendida para inferencia con ${context.standardErrorType}.`,
      detail: {
        ...hetero.detail,
        whyItMatters: 'La covarianza robusta protege la inferencia, aunque no recupera eficiencia ni corrige una posible mala especificación.',
        whatToCheck: [{ text: 'Mantener la lectura robusta y revisar si el patrón residual sugiere una forma funcional distinta.' }],
      },
      appliedRules: Array.from(new Set([...hetero.appliedRules, 'R2'])),
    });
    if (inference && inference.state !== 'insufficient') {
      map.set('inference', {
        ...inference,
        state: 'ok',
        headlineText: `La inferencia usa errores estándar ${context.standardErrorType}; la heterocedasticidad detectada está cubierta para t, p e intervalos.`,
        appliedRules: Array.from(new Set([...inference.appliedRules, 'R2'])),
      });
    }
  }

  const coefficients = sourceFindings.filter(finding => finding.category === 'coefficient');
  const nonSignificant = coefficients.filter(finding => {
    const p = finding.evidence?.pValue;
    return finite(p) && p > context.alpha;
  }).length;
  const globalP = sourceFindings.find(finding => categoryOf(finding.category) === 'globalSignificance')?.evidence?.pValue;
  const multi = map.get('multicollinearity');
  if (multi && (multi.state === 'review' || multi.state === 'problem') && coefficients.length > 0
    && nonSignificant > coefficients.length / 2 && finite(globalP) && globalP <= context.alpha) {
    map.set('multicollinearity', {
      ...multi,
      impact: 'efficiency',
      headlineText: 'El conjunto explica, pero los datos separan con poca precisión el aporte de cada regresor.',
      detail: {
        ...multi.detail,
        conclusion: 'El F global es significativo mientras la mayoría de los coeficientes individuales no lo es, junto con VIF elevados.',
        whyItMatters: 'La multicolinealidad puede inflar errores estándar sin sesgar por sí sola los coeficientes OLS.',
        whatToCheck: [
          { text: 'Definir si interesa el efecto individual o la predicción conjunta.' },
          { text: 'No descartar variables solo por VIF: podría introducir sesgo por variable omitida.', cost: 'Quitar un control relevante cambia la estimación.' },
        ],
      },
      appliedRules: Array.from(new Set([...multi.appliedRules, 'R3'])),
    });
  }

  const stationarity = map.get('stationarity');
  const d = context.timeSeries?.arimaOrders?.d ?? 0;
  const transformed = context.timeSeries?.transformation && !['original', 'level', 'levels'].includes(context.timeSeries.transformation);
  if (stationarity?.state === 'problem') {
    if (d > 0 || transformed) {
      map.set('stationarity', {
        ...stationarity,
        state: 'mitigated',
        impact: 'efficiency',
        headlineText: 'La serie original muestra no estacionariedad, pero el análisis usa una transformación que la atiende.',
        detail: {
          ...stationarity.detail,
          whyItMatters: 'La transformación reduce el riesgo de regresión espuria; no garantiza estacionariedad ni conserva automáticamente la relación de largo plazo.',
        },
        appliedRules: Array.from(new Set([...stationarity.appliedRules, 'R4'])),
      });
    } else {
      map.set('stationarity', {
        ...stationarity,
        impact: 'estimation',
        headlineText: 'La serie en niveles puede producir relaciones espurias: un R² alto o t grandes no validan el modelo.',
        detail: {
          ...stationarity.detail,
          whyItMatters: 'Con series no estacionarias en niveles, el ajuste puede reflejar tendencias compartidas y no una relación estable.',
          whatItDoesNot: ['No rechazar el ADF no prueba que exista una raíz unitaria; el test puede tener poca potencia.', ...stationarity.detail.whatItDoesNot],
        },
        appliedRules: Array.from(new Set([...stationarity.appliedRules, 'R4'])),
      });
    }
  }

  const arimaResiduals = map.get('arimaResiduals');
  if (arimaResiduals?.state === 'problem') {
    const model = map.get('modelIdentification') ?? missingFinding('modelIdentification', 'dependency_unmet', 'Falta evaluar la identificación temporal.');
    map.set('modelIdentification', {
      ...model,
      state: 'problem',
      impact: 'estimation',
      evidence: arimaResiduals.evidence,
      confidence: arimaResiduals.confidence,
      headlineText: 'El ARIMA dejó estructura temporal sin capturar; sus intervalos de pronóstico pueden estar mal calibrados.',
      detail: {
        ...model.detail,
        evidence: arimaResiduals.detail.evidence,
        conclusion: 'Ljung-Box rechaza ausencia de autocorrelación en los residuos del ARIMA.',
        whyItMatters: 'Los órdenes elegidos no describen toda la dinámica temporal remanente.',
        whatToCheck: [{ text: 'Revisar ACF/PACF de residuos, órdenes p y q, y posibles componentes estacionales.' }],
      },
      sources: Array.from(new Set([...model.sources, ...arimaResiduals.sources])),
      appliedRules: Array.from(new Set([...model.appliedRules, 'R5'])),
      insufficientReason: undefined,
    });
  }

  const forecast = map.get('forecast');
  const horizon = context.timeSeries?.forecastHorizon;
  if (forecast && forecast.state === 'ok' && finite(horizon) && context.nObs > 0 && horizon > context.nObs * 0.2) {
    map.set('forecast', {
      ...forecast,
      state: 'review',
      impact: 'reading',
      evidence: 'borderline',
      headlineText: `El horizonte de ${horizon} períodos supera 20% de la muestra y amplifica la incertidumbre del pronóstico.`,
      detail: {
        ...forecast.detail,
        whyItMatters: 'Cuanto más lejos se proyecta respecto de la historia observada, más depende el resultado de la estabilidad del modelo.',
        whatToCheck: [{ text: 'Acortar el horizonte o validar por bloques fuera de muestra.' }],
      },
    });
  }

  if (finite(context.rSquared) && context.rSquared >= 0.8) {
    const compromised = map.get('specification');
    const nonStationary = map.get('stationarity');
    if ((compromised && (compromised.state === 'review' || compromised.state === 'problem')) || nonStationary?.state === 'problem') {
      const global = map.get('globalSignificance');
      if (global) {
        global.detail.whatItDoesNot = Array.from(new Set([
          ...global.detail.whatItDoesNot,
          'Un R² alto mide ajuste dentro de la muestra; no valida la especificación y también puede aparecer en una regresión espuria.',
        ]));
        global.appliedRules = Array.from(new Set([...global.appliedRules, 'R6']));
      }
    }
  }

  const updatedInference = map.get('inference');
  const significantNames = coefficients.filter(finding => {
    const p = finding.evidence?.pValue;
    return finite(p) && p <= context.alpha;
  });
  if (updatedInference && (updatedInference.state === 'problem' || updatedInference.state === 'insufficient') && significantNames.length > 0) {
    updatedInference.detail.whatItDoesNot = Array.from(new Set([
      ...updatedInference.detail.whatItDoesNot,
      'Las significancias individuales son provisorias mientras la covarianza o sus prerrequisitos estén comprometidos.',
    ]));
    updatedInference.appliedRules = Array.from(new Set([...updatedInference.appliedRules, 'R7']));
  }

  const serial = map.get('serialCorrelation');
  const activeHetero = map.get('heteroskedasticity');
  if (serial && activeHetero && ['review', 'problem'].includes(serial.state)
    && ['review', 'problem'].includes(activeHetero.state) && context.standardErrorType !== 'HAC') {
    const currentInference = map.get('inference');
    if (currentInference) {
      map.set('inference', {
        ...currentInference,
        state: 'problem',
        impact: 'inference',
        headlineText: 'Hay heterocedasticidad y autocorrelación: HC1/HC3 no cubren ambas; la inferencia requiere una covarianza HAC.',
        detail: {
          ...currentInference.detail,
          whatToCheck: [{ text: 'Evaluar HAC (Newey-West) con un rezago justificado.' }],
        },
        appliedRules: Array.from(new Set([...currentInference.appliedRules, 'R9'])),
      });
    }
  }

  if (context.droppedFeatures.length > 0) {
    map.set('specification', syntheticFinding('specification', 'problem', 'estimation',
      `Se estimó un modelo distinto del pedido: se excluyeron ${context.droppedFeatures.join(', ')}.`, {
        evidence: [{ label: 'Columnas descartadas', value: context.droppedFeatures.join(', ') }],
        conclusion: 'El motor descartó columnas por deficiencia de rango; todo el diagnóstico corresponde al modelo reducido.',
        whyItMatters: 'Los coeficientes estimados responden a una especificación distinta de la selección original.',
        whatToCheck: [{ text: 'Revisar duplicados, combinaciones lineales y la definición de cada variable antes de reestimar.' }],
        whatItDoesNot: ['No implica que las variables descartadas sean irrelevantes en términos económicos.'],
      }, { evidence: 'strong', confidence: 'high', appliedRules: ['R10'] }));
  }

  if (context.mode === 'regression' && context.datasetHasDates) {
    map.set('serialCorrelation', missingFinding(
      'serialCorrelation',
      'not_run',
      'Los datos contienen fechas, pero el flujo de corte transversal no evaluó autocorrelación. Usá el flujo de series de tiempo o HAC cuando corresponda.'
    ));
    map.get('serialCorrelation')!.appliedRules.push('R12');
    if (context.standardErrorType !== 'HAC') {
      const temporalInference = missingFinding(
        'inference',
        'dependency_unmet',
        'Los datos parecen temporales y no se evaluó autocorrelación; la inferencia actual no puede considerarse firme sin ese eje.'
      );
      temporalInference.appliedRules.push('R12');
      map.set('inference', temporalInference);
    }
  }

  if (context.binaryTarget) {
    const existing = map.get('specification');
    const binary = syntheticFinding('specification', 'review', 'reading',
      'La variable dependiente es binaria: OLS debe leerse como un modelo de probabilidad lineal.', {
        conclusion: 'Con Y binaria, la varianza condicional no es constante por construcción y las predicciones pueden salir de [0,1].',
        whyItMatters: 'Los errores estándar clásicos no son apropiados y la interpretación difiere de una regresión lineal continua.',
        whatToCheck: [{ text: 'Comparar la lectura con el modelo logístico y usar inferencia robusta si se conserva OLS.' }],
        whatItDoesNot: ['No convierte automáticamente al modelo logístico en la única especificación válida.'],
      }, { confidence: 'high' });
    map.set('specification', existing?.state === 'problem' ? existing : binary);
    const binaryHetero = map.get('heteroskedasticity');
    if (binaryHetero && (binaryHetero.state === 'problem' || binaryHetero.state === 'review')) {
      map.set('heteroskedasticity', {
        ...binaryHetero,
        state: 'review',
        impact: 'reading',
        headlineText: 'Con una Y binaria, la heterocedasticidad es esperable por construcción y no diagnostica por sí sola una mala especificación.',
        detail: {
          ...binaryHetero.detail,
          whyItMatters: 'La consecuencia práctica sigue siendo usar una covarianza robusta si se interpreta el modelo de probabilidad lineal.',
        },
      });
    }
  }

  if (!context.hasIntercept) {
    for (const category of ['globalSignificance', 'residuals'] as const) {
      map.set(category, missingFinding(category, 'model_shape', 'El modelo no tiene intercepto; R², F y algunas identidades residuales cambian de significado.'));
    }
  }
}

function propagateDependencies(
  map: Map<DoctorCategoryKey, DoctorFinding>,
  expected: DoctorCategoryKey[],
  context: ModelContext
): void {
  const degrade = (category: DoctorCategoryKey, prerequisite: DoctorCategoryKey): void => {
    const current = map.get(category);
    if (!current || current.state === 'not_applicable') return;
    const degraded = missingFinding(
      category,
      'dependency_unmet',
      `${CATEGORY_LABELS[category]} no puede evaluarse con firmeza porque ${CATEGORY_LABELS[prerequisite].toLowerCase()} quedó sin evaluar.`
    );
    degraded.sources = current.sources;
    degraded.appliedRules = current.appliedRules;
    map.set(category, degraded);
  };

  if (map.get('sample')?.state === 'insufficient') {
    for (const category of expected) if (category !== 'sample') degrade(category, 'sample');
    return;
  }
  if (context.mode === 'regression' && map.get('inference')?.state === 'insufficient') {
    degrade('globalSignificance', 'inference');
    if (context.hasRestriction) degrade('restrictions', 'inference');
  }
  if (context.mode === 'timeseries' && map.get('stationarity')?.state === 'insufficient') {
    degrade('serialCorrelation', 'stationarity');
    degrade('modelIdentification', 'stationarity');
  }
  if (context.mode === 'timeseries' && map.get('modelIdentification')?.state === 'insufficient') {
    if (context.timeSeries?.arimaOrders) degrade('arimaResiduals', 'modelIdentification');
    if (context.timeSeries?.forecastHorizon) degrade('forecast', 'modelIdentification');
  }
  if (context.mode === 'timeseries' && context.timeSeries?.forecastHorizon
    && map.get('arimaResiduals')?.state === 'insufficient') {
    degrade('forecast', 'arimaResiduals');
  }
}

function compareFindings(a: DoctorFinding, b: DoctorFinding): number {
  return IMPACT_RANK[b.impact] - IMPACT_RANK[a.impact]
    || STATE_RANK[b.state] - STATE_RANK[a.state]
    || EVIDENCE_RANK[b.evidence] - EVIDENCE_RANK[a.evidence]
    || CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]
    || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
}

function overallState(findings: DoctorFinding[], applicable: number): DoctorOverallState {
  const visible = findings.filter(finding => finding.state !== 'not_applicable');
  const insufficient = visible.filter(finding => finding.state === 'insufficient').length;
  const evaluated = visible.filter(finding => finding.state !== 'insufficient');
  const r8 = evaluated.length > 0
    && evaluated.every(finding => finding.state === 'ok' || finding.state === 'mitigated')
    && evaluated.some(finding => finding.confidence === 'low');
  if (visible.some(finding => finding.state === 'problem' && finding.impact === 'estimation')) return 'attention';
  if (insufficient > applicable / 2 || r8) return 'partial';
  if (visible.some(finding => finding.state === 'problem') || visible.filter(finding => finding.state === 'review').length > 0) return 'review';
  return 'clear';
}

function chooseHeadline(findings: DoctorFinding[], overall: DoctorOverallState): DoctorFinding | null {
  const priority = findings.find(finding => finding.appliedRules.includes('R10'))
    ?? findings.find(finding => finding.appliedRules.includes('R4') && finding.state === 'problem');
  if (priority) return priority;
  const candidates = findings
    .filter(finding => (finding.state === 'problem' || finding.state === 'review')
      && finding.impact !== 'reading' && finding.confidence !== 'low')
    .sort(compareFindings);
  if (candidates[0]) return candidates[0];
  if (overall === 'partial') return null;
  return findings.find(finding => finding.state === 'ok' && finding.confidence !== 'low') ?? null;
}

export function engineFindingFromInterpretation(result: InterpretationResult): EngineFinding {
  return {
    id: result.id,
    category: result.diagnosticCategory ?? result.category,
    severity: result.severity,
    summary: result.summary,
    statisticalConclusion: result.statisticalConclusion,
    practicalMeaning: result.practicalMeaning,
    limitations: result.limitations,
    recommendedChecks: result.recommendedChecks,
    recommendations: result.nextSteps.map(step => ({ text: step.label, cost: step.rationale })),
    theoryConcepts: result.theoryConcepts,
    evidence: result.evidence,
    applicability: result.applicability,
    unavailableReason: result.unavailableReason,
    confidenceHint: result.confidenceHint,
    impactHint: result.impactHint,
  };
}

export function buildModelDoctor(input: EngineFinding[], context: ModelContext): DoctorReport {
  const flow = context.mode === 'regression' ? 'cross-section' : 'time-series';
  if (context.converged === false) {
    const failure = syntheticFinding('specification', 'problem', 'estimation', 'No hay un modelo convergido que diagnosticar.', {
      conclusion: 'La estimación no convergió o devolvió un resultado inválido.',
      whyItMatters: 'Los parámetros, tests y pronósticos de una estimación no convergida no son una base fiable para el diagnóstico.',
      whatToCheck: [{ text: 'Probar una especificación más simple, revisar escala, colinealidad y estacionariedad.' }],
      whatItDoesNot: ['No identifica por sí solo cuál de esas causas produjo la falla.'],
    }, { evidence: 'strong', confidence: 'high', insufficientReason: 'invalid_result' });
    return {
      overallState: 'attention',
      headline: failure,
      findings: [failure],
      coverage: { evaluated: 0, applicable: 1, skipped: [{ category: 'specification', reason: 'invalid_result' }] },
      limits: MODEL_DOCTOR_LIMITS,
      flow,
    };
  }

  const map = new Map<DoctorCategoryKey, DoctorFinding>();
  const sourceFindings = input;
  for (const finding of sourceFindings) {
    if (finding.category === 'coefficient') continue;
    setFinding(map, normalizeFinding(finding, context));
  }
  map.set('sample', sampleFinding(context));

  const expected = expectedCategories(context);
  for (const category of expected) {
    if (map.has(category)) continue;
    const reason: DoctorSkipReason = category === 'stability' ? 'not_run'
      : category === 'restrictions' && context.engine === 'lite' ? 'engine_tier'
        : 'engine_unavailable';
    const explanation = category === 'stability'
      ? 'ChartBay todavía no ejecuta un test de quiebre estructural como Chow o CUSUM.'
      : `El motor no devolvió un resultado estructurado para ${CATEGORY_LABELS[category].toLowerCase()}.`;
    map.set(category, missingFinding(category, reason, explanation));
  }

  if (context.mode === 'regression') {
    const hetero = map.get('heteroskedasticity');
    map.set('inference', hetero?.state === 'insufficient'
      ? missingFinding('inference', 'dependency_unmet', 'Sin un diagnóstico de varianza y autocorrelación no se puede validar la covarianza usada para t, p e intervalos.')
      : syntheticFinding('inference', 'ok', 'inference',
        `La inferencia está calculada con errores estándar ${context.standardErrorType}.`, {
          conclusion: `Los t, p-valores e intervalos usan la covarianza ${context.standardErrorType}.`,
          whyItMatters: 'La validez de la significancia depende de que esa covarianza cubra los problemas detectados.',
          whatItDoesNot: ['No cubre endogeneidad, variables omitidas ni una forma funcional incorrecta.'],
        }, { confidence: hetero?.confidence ?? 'medium' }));
  }

  applyRules(map, sourceFindings, context);
  propagateDependencies(map, expected, context);

  const findings = Array.from(map.values())
    .filter(finding => expected.includes(finding.category) || finding.category === 'other')
    .sort(compareFindings);
  const applicable = findings.filter(finding => finding.state !== 'not_applicable').length;
  const evaluated = findings.filter(finding => finding.state !== 'not_applicable' && finding.state !== 'insufficient').length;
  const skipped = findings
    .filter(finding => finding.state === 'insufficient')
    .map(finding => ({ category: finding.category, reason: finding.insufficientReason ?? 'engine_unavailable' }));
  const overall = overallState(findings, applicable);

  return {
    overallState: overall,
    headline: chooseHeadline(findings, overall),
    findings,
    coverage: { evaluated, applicable, skipped },
    limits: MODEL_DOCTOR_LIMITS,
    flow,
  };
}
