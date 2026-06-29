"""Inferencia estadística compartida: p-valores y cuantiles de t, F y χ².

Centraliza el uso de ``scipy.stats`` (DRY) para que OLS, RLS y los diagnósticos de series
de tiempo usen exactamente las mismas distribuciones. Devuelve ``float`` nativos para que el
resultado sea serializable a JSON sin tipos de NumPy.
"""

from __future__ import annotations

import math

from scipy import stats


def t_two_sided_p_value(t: float, df: float) -> float:
    """p-valor bilateral de un estadístico t con ``df`` grados de libertad."""
    if df <= 0:
        return float("nan")
    # |t| = inf  ->  sf = 0  ->  p = 0 (ajuste perfecto).
    return float(2.0 * stats.t.sf(abs(t), df))


def t_critical(alpha_two_sided: float, df: float) -> float:
    """Valor crítico t tal que P(|T| > t) = alpha (para IC bilaterales)."""
    if df <= 0:
        return float("inf")
    return float(stats.t.isf(alpha_two_sided / 2.0, df))


def f_sf(f: float, dfn: float, dfd: float) -> float:
    """Cola superior de la F: P(F > f) con ``dfn`` y ``dfd`` grados de libertad."""
    if dfn <= 0 or dfd <= 0:
        return 1.0
    if not math.isfinite(f):
        return 0.0 if f > 0 else 1.0
    if f <= 0:
        return 1.0
    return float(stats.f.sf(f, dfn, dfd))


def chi2_sf(x: float, df: float) -> float:
    """Cola superior de la χ²: P(χ² > x) con ``df`` grados de libertad."""
    if not math.isfinite(x) or x < 0 or df <= 0:
        return float("nan")
    return float(stats.chi2.sf(x, df))
