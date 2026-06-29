"""Regresión por Mínimos Cuadrados Ordinarios (OLS).

Estimación vía descomposición QR (``numpy.linalg.qr`` + sustitución hacia atrás), más
estable que las ecuaciones normales con inversión de Gauss-Jordan del motor TS. El
intercepto va siempre primero ([β0, β1, …, βk]); los vectores de inferencia
(`std_errors`, `t_stats`, `p_values`, `ci95`) tienen longitud k+1 con el índice 0 = intercepto,
igual que el contrato `RegressionResult` del frontend.

Validado contra `statsmodels.OLS` en `tests/test_ols.py` (ADR-1).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, replace

import numpy as np
from scipy.linalg import solve_triangular

from chartbay_engine.core.econometrics import inference
from chartbay_engine.core.econometrics.diagnostics.collinearity import detect_rank_issues
from chartbay_engine.core.errors import (
    InsufficientObservationsError,
    InvalidInputError,
    RankDeficiencyError,
)


@dataclass(frozen=True)
class DroppedFeature:
    name: str
    reason: str


@dataclass(frozen=True)
class OLSResult:
    coefficients: list[float]  # pendientes β1..βk (sin intercepto)
    intercept: float
    r_squared: float
    adjusted_r_squared: float
    predictions: list[float]
    residuals: list[float]
    rss: float
    equation: str
    feature_names: list[str]
    y_name: str
    n_obs: int
    n_features: int
    std_errors: list[float]  # longitud k+1: [intercepto, β1, …, βk]
    t_stats: list[float]
    p_values: list[float]
    ci95: list[tuple[float, float]]
    df: int
    sigma2: float
    f_stat: float
    f_p_value: float
    method: str = "OLS"
    dropped_features: list[DroppedFeature] | None = None


def _format_equation(
    y_name: str, intercept: float, coefs: np.ndarray, names: Sequence[str]
) -> str:
    terms = "".join(
        f"{' + ' if c >= 0 else ' - '}{abs(float(c)):.4f}·{name}"
        for c, name in zip(coefs, names, strict=True)
    )
    return f"{y_name} = {intercept:.4f}{terms}"


def run_ols(
    X: Sequence[Sequence[float]] | np.ndarray,
    y: Sequence[float] | np.ndarray,
    feature_names: Sequence[str],
    y_name: str = "y",
    *,
    drop_redundant: bool = False,
) -> OLSResult:
    """Estima un modelo OLS y devuelve coeficientes, inferencia y diagnósticos básicos."""
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float)

    if X.ndim != 2:
        raise InvalidInputError(
            "X debe ser una matriz 2D (filas = observaciones, columnas = variables)."
        )
    n, k = X.shape
    if y.shape[0] != n:
        raise InvalidInputError(f"y tiene {y.shape[0]} observaciones pero X tiene {n}.")
    if len(feature_names) != k:
        raise InvalidInputError(
            f"Se esperaban {k} nombres de variable pero llegaron {len(feature_names)}."
        )
    if not np.all(np.isfinite(X)) or not np.all(np.isfinite(y)):
        raise InvalidInputError(
            "X e y deben contener sólo valores finitos (sin NaN ni infinitos)."
        )
    if n < k + 2:
        raise InsufficientObservationsError(
            f"Se necesitan al menos {k + 2} observaciones para {k} variable(s).",
            details={"observations": n, "features": k, "required": k + 2},
        )

    xd = np.column_stack([np.ones(n), X])
    all_names = ["(intercepto)", *feature_names]

    issues = detect_rank_issues(xd, all_names)
    if issues is not None:
        if not drop_redundant:
            lines = "\n".join(f"  • {issue.reason}" for issue in issues)
            raise RankDeficiencyError(
                f"Deficiencia de rango en la matriz de diseño "
                f"({len(issues)} columna(s) redundante(s)):\n{lines}\n\n"
                f'Corrija la colinealidad o active "dropRedundant" para excluir '
                f"automáticamente las columnas redundantes.",
                details={"issues": [{"name": i.name, "reason": i.reason} for i in issues]},
            )
        drop_set = {issue.col_idx for issue in issues if issue.col_idx > 0}
        keep = [i for i in range(k) if (i + 1) not in drop_set]
        dropped = [
            DroppedFeature(issue.name, issue.reason) for issue in issues if issue.col_idx > 0
        ]
        clean = run_ols(
            X[:, keep], y, [feature_names[i] for i in keep], y_name
        )
        return replace(clean, dropped_features=dropped)

    # ── OLS por QR ────────────────────────────────────────────────────────────
    q, r = np.linalg.qr(xd)
    beta = solve_triangular(r, q.T @ y, lower=False)
    r_inv = solve_triangular(r, np.eye(k + 1), lower=False)
    xtx_inv = r_inv @ r_inv.T  # (X'X)^-1 = R^-1 R^-T

    predictions = xd @ beta
    residuals = y - predictions
    rss = float(residuals @ residuals)

    y_mean = float(y.mean())
    ss_tot = float(((y - y_mean) ** 2).sum())
    df = n - k - 1
    r_squared = 0.0 if ss_tot == 0 else 1.0 - rss / ss_tot
    adjusted = 1.0 - (1.0 - r_squared) * (n - 1) / df
    sigma2 = rss / df if df > 0 else 0.0

    std_errors = np.sqrt(np.maximum(0.0, sigma2 * np.diag(xtx_inv)))
    t_stats = np.empty(k + 1)
    for i in range(k + 1):
        se = std_errors[i]
        if se > 1e-15:
            t_stats[i] = beta[i] / se
        else:
            t_stats[i] = 0.0 if beta[i] == 0 else np.inf
    p_values = [inference.t_two_sided_p_value(float(t), df) for t in t_stats]
    t_crit = inference.t_critical(0.05, df)
    ci95 = [
        (float(b - t_crit * se), float(b + t_crit * se))
        for b, se in zip(beta, std_errors, strict=True)
    ]

    f_stat = ((r_squared / k) / ((1 - r_squared) / df)) if (k > 0 and df > 0) else 0.0
    f_p_value = inference.f_sf(f_stat, k, df)

    return OLSResult(
        coefficients=[float(b) for b in beta[1:]],
        intercept=float(beta[0]),
        r_squared=float(r_squared),
        adjusted_r_squared=float(adjusted),
        predictions=[float(v) for v in predictions],
        residuals=[float(v) for v in residuals],
        rss=rss,
        equation=_format_equation(y_name, float(beta[0]), beta[1:], feature_names),
        feature_names=list(feature_names),
        y_name=y_name,
        n_obs=n,
        n_features=k,
        std_errors=[float(s) for s in std_errors],
        t_stats=[float(t) for t in t_stats],
        p_values=[float(p) for p in p_values],
        ci95=ci95,
        df=df,
        sigma2=float(sigma2),
        f_stat=float(f_stat),
        f_p_value=float(f_p_value),
    )
