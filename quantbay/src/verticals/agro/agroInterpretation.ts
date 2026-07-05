// ChartBay Agro — interpretación agropecuaria de resultados econométricos.
//
// Este módulo NO corre modelos: recibe un resultado ya calculado por el motor
// común (Lite/Pro) y le agrega lectura agro. La matemática de cada forma
// funcional se REUTILIZA del core (interpretFunctionalCoefficient, en
// functionalForms.ts); acá sólo se suma vocabulario y cautela agronómica.

import { interpretFunctionalCoefficient, type FunctionalForm } from '../../functionalForms';
import type { RegressionResult } from '../../regression';
import type {
  AgroColumnRole,
  AgroInterpretation,
  AgroInterpretationContext,
} from './agroTypes';
import { agroRoleLabel } from './agroModelPresets';

// Adapter mínimo sobre el resultado de una corrida de regresión, para no
// acoplar la interpretación a un motor puntual (sirve para Lite, Pro o
// cualquier resultado con esta forma). Los coeficientes son SÓLO pendientes,
// sin intercepto.
export interface ModelRunResultLike {
  coefficients: Array<{
    name: string;
    estimate: number;
    pValue?: number;
    standardError?: number;
  }>;
  rSquared?: number;
  adjustedRSquared?: number;
  observations?: number;
  warnings?: string[];
  functionalForm?: FunctionalForm;
}

// Adapta el RegressionResult del motor TypeScript (runOLS / runRegressionMode)
// al shape neutro que consume la interpretación agro. En RegressionResult los
// arrays de inferencia traen el intercepto en el índice 0, por eso el i+1.
export function fromRegressionResult(
  result: RegressionResult,
  form?: FunctionalForm
): ModelRunResultLike {
  return {
    coefficients: result.featureNames.map((name, i) => ({
      name,
      estimate: result.coefficients[i],
      pValue: result.pValues[i + 1],
      standardError: result.stdErrors[i + 1],
    })),
    rSquared: result.rSquared,
    adjustedRSquared: result.adjustedRSquared,
    observations: result.nObs,
    warnings: [],
    functionalForm: form,
  };
}

const MIN_COMFORTABLE_OBS = 30;

function significanceNote(pValue: number | undefined): string {
  if (pValue === undefined || !Number.isFinite(pValue)) return '';
  return pValue < 0.05
    ? ''
    : ` (no significativo estadísticamente, p = ${pValue.toFixed(3)}: este efecto podría deberse al azar muestral)`;
}

function direction(estimate: number, positive: string, negative: string): string {
  return estimate >= 0 ? positive : negative;
}

// Lectura agro específica para un par (rol de Y, rol de X). Devuelve null si
// la combinación no tiene lectura especial.
function agroPairReading(
  targetRole: AgroColumnRole,
  xRole: AgroColumnRole,
  xName: string,
  estimate: number,
  form: FunctionalForm
): string | null {
  const elastic = form === 'log-log';

  if (targetRole === 'yield' && xRole === 'rainfall') {
    return (
      `Lluvia y rinde: el coeficiente de "${xName}" sugiere que campañas con más precipitaciones se asocian con ` +
      `rindes ${direction(estimate, 'más altos', 'más bajos')} (medidos en kg/ha o qq/ha según tus datos). ` +
      `Es una asociación estadística, no un óptimo agronómico: el efecto real del agua depende del momento del ciclo en que llueve.`
    );
  }
  if (targetRole === 'yield' && xRole === 'temperature') {
    return (
      `Temperatura y rinde: el signo ${direction(estimate, 'positivo', 'negativo')} de "${xName}" es consistente con ` +
      `${direction(estimate, 'temperaturas medias más benignas para el cultivo', 'posible estrés térmico en campañas más calurosas')}, ` +
      `pero interpretalo con cautela: la temperatura media esconde olas de calor puntuales y interacciones con la humedad.`
    );
  }
  if (targetRole === 'price' && xRole === 'exchange_rate') {
    return (
      `Tipo de cambio y precio: el coeficiente de "${xName}" mide la sensibilidad del precio local al dólar` +
      `${elastic ? ' (leído como elasticidad por la forma log-log)' : ''}. ` +
      `Un precio local que reacciona al tipo de cambio es típico de bienes transables con referencia internacional.`
    );
  }
  if (targetRole === 'price' && xRole === 'price') {
    return (
      `Transmisión internacional: "${xName}" actúa como precio de referencia externa; su coeficiente ` +
      `${elastic ? 'es la elasticidad de transmisión: qué % del movimiento internacional llega al precio local' : 'estima cuánto del movimiento internacional se traslada al precio local'}. ` +
      `Una transmisión menor a 1 a 1 suele reflejar retenciones, fletes y bases locales.`
    );
  }
  if (targetRole === 'margin' && xRole === 'cost') {
    return estimate < 0
      ? `Costos y margen: el coeficiente negativo de "${xName}" es el esperado — a mayor costo, menor margen bruto, manteniendo rinde y precio constantes.`
      : `Costos y margen: el coeficiente de "${xName}" dio positivo, lo contrario a lo esperado. Puede haber variables omitidas (por ejemplo, campos que gastan más en insumos también logran más rinde); revisá la especificación antes de concluir.`;
  }
  if (targetRole === 'production' && (xRole === 'area_planted' || xRole === 'area_harvested')) {
    return (
      `Escala productiva: "${xName}" captura el efecto de la superficie sobre la producción total. ` +
      `Es la relación más mecánica del modelo (más hectáreas → más toneladas); el resto de las variables ajusta por productividad.`
    );
  }
  return null;
}

// Interpreta un resultado de regresión YA calculado, en clave agropecuaria.
// No re-estima nada ni valida los datos originales.
export function interpretAgroRegressionResult(
  result: ModelRunResultLike,
  context: AgroInterpretationContext
): AgroInterpretation {
  const form = result.functionalForm ?? context.form;
  const targetLabel = agroRoleLabel(context.targetRole);

  // ── Resumen ejecutivo ──────────────────────────────────────────────────
  const parts: string[] = [];
  if (result.rSquared !== undefined && Number.isFinite(result.rSquared)) {
    parts.push(
      `El modelo explica el ${(result.rSquared * 100).toFixed(1)}% de la variación de "${context.targetColumn}" (${targetLabel})`
    );
  } else {
    parts.push(`Modelo estimado para "${context.targetColumn}" (${targetLabel})`);
  }
  if (result.observations !== undefined) parts.push(`con ${result.observations} observaciones`);
  const cropNote = context.crop && context.crop !== 'otro' ? ` para ${context.crop}` : '';
  const executiveSummary =
    `${parts.join(' ')}${cropNote}. ` +
    `La estimación la hace el motor econométrico común de ChartBay; esta lectura sólo la traduce al contexto agropecuario.`;

  // ── Lectura matemática de cada coeficiente (reutiliza el core) ─────────
  const coefficientReadings = result.coefficients.map(coefficient => {
    const base = interpretFunctionalCoefficient(form, coefficient.name, coefficient.estimate);
    return `${base.approxRule}${significanceNote(coefficient.pValue)}`;
  });

  // ── Lectura agro específica por pares (rol Y, rol X) ───────────────────
  const pairReadings = result.coefficients.reduce<string[]>((acc, coefficient) => {
    const xRole = context.columnRoles[coefficient.name] ?? 'unknown';
    const reading = agroPairReading(context.targetRole, xRole, coefficient.name, coefficient.estimate, form);
    if (reading) acc.push(reading);
    return acc;
  }, []);
  const agroReading =
    pairReadings.length > 0
      ? pairReadings.join('\n')
      : 'No hay una lectura agro específica para esta combinación de variables; aplican las lecturas econométricas generales de arriba.';

  // ── Advertencias ────────────────────────────────────────────────────────
  const warnings: string[] = [
    'Correlación no implica causalidad: el modelo describe asociaciones en los datos, no efectos causales.',
  ];
  if (result.observations !== undefined && result.observations < MIN_COMFORTABLE_OBS) {
    warnings.push(
      `Muestra chica (n = ${result.observations}): con menos de ${MIN_COMFORTABLE_OBS} observaciones las conclusiones son frágiles y los p-values poco confiables.`
    );
  }
  if (result.warnings && result.warnings.length > 0) {
    warnings.push(...result.warnings);
  }

  // ── Limitaciones ────────────────────────────────────────────────────────
  const limitations = [
    'Los resultados dependen de la calidad y representatividad del dataset (campañas, zonas y cultivos incluidos).',
    'Variables omitidas (suelo, genética, manejo, napas) pueden sesgar los coeficientes estimados.',
    'Interpretá con criterio agronómico y económico: el modelo no reemplaza el conocimiento del lote ni del mercado.',
  ];

  return { executiveSummary, coefficientReadings, agroReading, warnings, limitations };
}
