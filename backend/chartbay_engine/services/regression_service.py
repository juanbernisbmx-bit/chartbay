"""Lógica de negocio de regresión: orquesta el núcleo matemático con la validación.

Hoy es una capa fina sobre `core`; crecerá con análisis acompañantes (matriz de
correlación, VIF, detección de fugas, logística) sin que la capa HTTP cambie.
"""

from __future__ import annotations

from collections.abc import Sequence

from chartbay_engine.core.econometrics.regression.ols import OLSResult, run_ols


def estimate_ols(
    *,
    x: Sequence[Sequence[float]],
    y: Sequence[float],
    feature_names: Sequence[str],
    y_name: str = "y",
    drop_redundant: bool = False,
) -> OLSResult:
    return run_ols(x, y, feature_names, y_name, drop_redundant=drop_redundant)
