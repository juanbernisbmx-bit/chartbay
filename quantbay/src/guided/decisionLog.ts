// Registro de decisiones: cómo se redacta y cómo se exporta.
//
// Todo acá es puro. session.ts guarda las decisiones; este archivo decide qué
// dicen y cómo se leen. Separarlos es lo que permite testear la redacción sin
// navegador y cambiarla sin tocar el estado.
//
// Regla de frontera, la misma que en el resto de la guía: acá no se evalúa
// nada. El registro cuenta QUÉ decidió el estudiante y CUÁNDO, nunca si estuvo
// bien. Un registro que dictaminara sería un veredicto disfrazado de bitácora.

import { CHANGE_LABEL, type ChangeKind } from './invalidation';
import type { AnalysisType, GuidedMode, GuidedSession, SpecSignature, UserDecision } from './types';

/** hh:mm:ss local. Formato fijo para que el registro se lea igual en todos lados. */
export function clockOf(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Valor nuevo de cada campo, tal como lo vería el estudiante en el control.
 *
 * Un Record y no un switch, igual que CHANGE_LABEL acá al lado: sumar una
 * clase de cambio obliga a decidir cómo se lee, en vez de caer en un default
 * que la dejaría muda en el registro.
 *
 * La ausencia se nombra ("sin restricción", "ninguna"): un paréntesis vacío
 * no distingue entre no haber elegido nada y un valor que no se pudo leer.
 */
const VALUE_OF: Record<ChangeKind, (sig: SpecSignature) => string> = {
  dataset: sig => sig.dataset || 'sin nombre',
  y: sig => sig.yName || 'ninguna',
  x: sig => (sig.xNames === '' ? 'ninguna' : sig.xNames.split('|').join(', ')),
  form: sig => sig.form,
  seType: sig => sig.seType,
  missingPolicy: sig => (sig.dropIncomplete ? 'descartar filas incompletas' : 'conservar todas las filas'),
  restriction: sig => sig.restriction || 'sin restricción',
  transformation: sig => sig.transformation || 'original',
  arimaOrders: sig => (sig.arimaOrders === '' ? 'sin ARIMA' : sig.arimaOrders),
};

/** "la forma funcional (log-lin)" — el campo que cambió, con su valor nuevo. */
export function describeChange(change: ChangeKind, sig: SpecSignature): string {
  return `${CHANGE_LABEL[change]} (${VALUE_OF[change](sig)})`;
}

/**
 * Une varios cambios en una sola frase: "la Y (precio) y las X (m2, barrio)".
 *
 * Distinta de describeChanges de invalidation.ts, que nombra los campos sin
 * valores para redactar avisos de "esto quedó viejo". Acá el valor es el punto:
 * un registro que dijera solo "cambiaste la forma funcional" no sirve para
 * reconstruir qué se hizo.
 */
export function describeSpecChanges(changes: ChangeKind[], sig: SpecSignature): string {
  const parts = changes.map(c => describeChange(c, sig));
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`;
}

/**
 * Qué se estimó, en la notación en la que el estudiante lo escribiría.
 *
 * La transformación distingue los dos flujos: solo el contexto de series la
 * completa, así que sirve de discriminante sin tener que pasar el modo aparte.
 */
export function describeEstimation(sig: SpecSignature): string {
  if (sig.transformation !== '') {
    const arima = sig.arimaOrders === '' ? '' : ` con ARIMA(${sig.arimaOrders})`;
    return `Analizaste la serie (${sig.transformation})${arima}`;
  }
  const xs = sig.xNames === '' ? 'sin regresores' : sig.xNames.split('|').join(' + ');
  return `Estimaste ${sig.yName || 'Y'} ~ ${xs} · ${sig.form}`;
}

const TYPE_LABEL: Record<AnalysisType, string> = {
  cross_section: 'corte transversal',
  time_series: 'series de tiempo',
  descriptive: 'análisis descriptivo',
};

const MODE_LABEL: Record<GuidedMode, string> = {
  guided: 'guiado',
  free: 'libre',
  practice: 'práctica',
};

export interface DecisionLogMeta {
  dataset: string | null;
  analysisType: AnalysisType | null;
  mode: GuidedMode;
  /** Momento de la exportación, inyectado para que el texto sea determinista. */
  generatedAt: number;
}

function line(decision: UserDecision, index: number): string {
  const from = decision.fromRecommendation ? ` [${decision.fromRecommendation}]` : '';
  return `${index + 1}. ${clockOf(decision.at)} — ${decision.summary}${from}`;
}

/**
 * El registro como texto entregable.
 *
 * En orden cronológico, al revés que en el panel: leído de corrido cuenta la
 * sesión como sucedió, que es para lo que sirve fuera de la pantalla.
 */
export function buildDecisionLogText(session: GuidedSession, meta: DecisionLogMeta): string {
  const dismissed = session.decisions.filter(d => d.kind === 'dismiss_recommendation');
  const out: string[] = [
    '# Registro de decisiones — ChartBay',
    '',
    `Dataset: ${meta.dataset ?? 'ninguno cargado'}`,
    `Tipo de análisis: ${meta.analysisType ? TYPE_LABEL[meta.analysisType] : 'sin confirmar'}`,
    `Modo: ${MODE_LABEL[meta.mode]}`,
    `Generado: ${new Date(meta.generatedAt).toISOString()}`,
    `Decisiones registradas: ${session.decisions.length}`,
    '',
    '## Qué hiciste, en orden',
    '',
  ];

  out.push(
    session.decisions.length === 0
      ? 'Todavía no hay decisiones registradas en esta sesión.'
      : session.decisions.map(line).join('\n')
  );

  if (dismissed.length > 0) {
    out.push(
      '',
      '## Recomendaciones que decidiste no atender',
      '',
      // Se listan aparte porque son las que más adelante explican un resultado
      // raro. Que estén registradas es el punto: la decisión fue del
      // estudiante y quedó anotada, no escondida.
      ...dismissed.map(d => `- ${clockOf(d.at)} — ${d.summary}`)
    );
  }

  out.push(
    '',
    '## Sobre este registro',
    '',
    'Documenta qué decidiste y cuándo. No certifica que el modelo esté bien',
    'especificado ni que las conclusiones sean válidas: eso depende de la teoría',
    'que respalde la pregunta y de los diagnósticos, no de haber seguido pasos.',
    ''
  );

  return out.join('\n');
}
