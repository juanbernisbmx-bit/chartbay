"""Mínimos Cuadrados Restringidos (RLS) con test F/Wald sobre restricciones lineales.

Estima β sujeto a J restricciones lineales R·β = q (R es J×(k+1), q es J-vector; el
intercepto es β0). Fórmula cerrada:

    β_RLS = β_OLS − (X'X)⁻¹ R' [R (X'X)⁻¹ R']⁻¹ (R β_OLS − q)

Inferencia restringida (válida bajo H0: la restricción es cierta):

    Var(β_RLS) = σ²_OLS · M,  M = (X'X)⁻¹ − (X'X)⁻¹ R' [R(X'X)⁻¹R']⁻¹ R (X'X)⁻¹
    σ²_OLS = RSS_OLS / (n−k−1)   (estimador insesgado bajo H0)

Test F/Wald de las J restricciones:

    F = [(RSS_RLS − RSS_OLS)/J] / [RSS_OLS/(n−k−1)]

Replica `quantbay/src/rls.ts` y se valida contra una referencia NumPy/SciPy independiente
en `tests/test_rls.py` (ADR-1).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from chartbay_engine.core.econometrics import inference
from chartbay_engine.core.econometrics.regression.ols import (
    format_equation,
    qr_solve,
    run_ols,
)
from chartbay_engine.core.errors import ConstraintError


@dataclass(frozen=True)
class LinearConstraint:
    """Restricción lineal R·β = q. ``R`` es J×(k+1) (índice 0 = intercepto)."""

    R: list[list[float]]
    q: list[float]
    label: str = ""


@dataclass(frozen=True)
class RLSResult:
    coefficients: list[float]
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
    std_errors: list[float]
    t_stats: list[float]
    p_values: list[float]
    ci95: list[tuple[float, float]]
    df: int
    sigma2: float
    f_stat: float
    f_p_value: float
    # Campos propios de RLS
    rls_constraint: str
    rss_ols: float
    rss_rls: float
    f_stat_constraint: float
    f_p_value_constraint: float
    j_constraints: int
    restricted_inference_available: bool
    method: str = "RLS"


def validate_linear_constraint(constraint: LinearConstraint, parameter_count: int) -> None:
    """Valida dimensiones/finitud de la restricción contra el número de parámetros (k+1)."""
    R, q = constraint.R, constraint.q
    j = len(R)
    if j == 0:
        raise ConstraintError(
            "La restricción RLS está vacía. Definí al menos una restricción lineal "
            "antes de estimar."
        )
    if len(q) != j:
        raise ConstraintError(
            f"La restricción RLS tiene {j} fila(s) en R pero {len(q)} valor(es) en q. "
            "Cada restricción necesita exactamente un valor q."
        )
    if j > parameter_count:
        raise ConstraintError(
            f"La restricción RLS tiene {j} restricciones para {parameter_count} parámetros. "
            "No puede haber más restricciones independientes que parámetros del modelo."
        )
    for row_index, row in enumerate(R):
        if len(row) != parameter_count:
            raise ConstraintError(
                f"La restricción RLS fila {row_index + 1} tiene {len(row)} columnas pero el "
                f"modelo tiene {parameter_count} parámetros."
            )
        if not all(np.isfinite(row)):
            raise ConstraintError(
                f"La restricción RLS fila {row_index + 1} contiene valores no finitos."
            )
    if not all(np.isfinite(q)):
        raise ConstraintError("La restricción RLS contiene valores q no finitos.")
    if np.linalg.matrix_rank(np.asarray(R, dtype=float)) < j:
        raise ConstraintError(
            "La restricción RLS es singular o redundante: las filas de R son colineales.",
            code="singular_constraint",
        )


def _nan_inference(param_count: int):
    nan = float("nan")
    return (
        [nan] * param_count,
        [nan] * param_count,
        [nan] * param_count,
        [(nan, nan)] * param_count,
        False,
    )


def run_rls(
    X,
    y,
    feature_names,
    y_name: str = "y",
    *,
    constraint: LinearConstraint,
) -> RLSResult:
    """Estima un modelo OLS restringido por R·β = q y computa el test F/Wald."""
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float)

    # OLS no restringido: valida n, finitos y rango (lanza si hay deficiencia — intencional).
    ols = run_ols(X, y, feature_names, y_name)
    n, k = ols.n_obs, ols.n_features
    param_count = k + 1

    validate_linear_constraint(constraint, param_count)

    beta_ols = np.array([ols.intercept, *ols.coefficients])
    rss_ols = ols.rss

    xd = np.column_stack([np.ones(n), X])
    _, xtx_inv = qr_solve(xd, y)

    R = np.asarray(constraint.R, dtype=float)
    q = np.asarray(constraint.q, dtype=float)
    j = R.shape[0]

    r_beta_q = R @ beta_ols - q
    rxtxinv = R @ xtx_inv  # J×(k+1)
    rxtxinv_rt = rxtxinv @ R.T  # J×J
    try:
        rxtxinv_rt_inv = np.linalg.inv(rxtxinv_rt)
    except np.linalg.LinAlgError as exc:
        raise ConstraintError(
            "La restricción RLS es singular o redundante: R·(X'X)⁻¹·R' no es invertible "
            "(las restricciones son colineales).",
            code="singular_constraint",
        ) from exc

    correction = xtx_inv @ R.T @ rxtxinv_rt_inv @ r_beta_q
    beta_rls = beta_ols - correction

    predictions = xd @ beta_rls
    residuals = y - predictions
    rss_rls = float(residuals @ residuals)

    y_mean = float(y.mean())
    ss_tot = float(((y - y_mean) ** 2).sum())
    df = n - k - 1
    r_squared = 0.0 if ss_tot == 0 else 1.0 - rss_rls / ss_tot
    adjusted = 1.0 - (1.0 - r_squared) * (n - 1) / df
    sigma2 = rss_rls / df if df > 0 else 0.0

    f_stat_constraint = (
        ((rss_rls - rss_ols) / j) / (rss_ols / df)
        if (df > 0 and rss_ols > 1e-15)
        else 0.0
    )
    f_p_value_constraint = inference.f_sf(max(0.0, f_stat_constraint), j, df)

    f_stat = inference.overall_f_statistic(r_squared, k, df)
    f_p_value = inference.f_sf(f_stat, k, df)

    # ── Inferencia restringida ────────────────────────────────────────────────
    if df <= 0:
        std_errors, t_stats, p_values, ci95, available = _nan_inference(param_count)
    else:
        try:
            sigma2_ols = rss_ols / df
            cov_adj = (xtx_inv @ R.T @ rxtxinv_rt_inv) @ rxtxinv  # (k+1)×(k+1)
            cov_matrix = xtx_inv - cov_adj
            std_errors = list(np.sqrt(np.maximum(0.0, sigma2_ols * np.diag(cov_matrix))))
            t_stats = []
            for b, se in zip(beta_rls, std_errors, strict=True):
                if se > 1e-15:
                    t_stats.append(float(b / se))
                else:
                    t_stats.append(0.0 if b == 0 else float("inf"))
            p_values = [inference.t_two_sided_p_value(t, df) for t in t_stats]
            t_crit = inference.t_critical(0.05, df)
            ci95 = [
                (float(b - t_crit * se), float(b + t_crit * se))
                for b, se in zip(beta_rls, std_errors, strict=True)
            ]
            std_errors = [float(se) for se in std_errors]
            available = True
        except (np.linalg.LinAlgError, FloatingPointError, ValueError):
            std_errors, t_stats, p_values, ci95, available = _nan_inference(param_count)

    return RLSResult(
        coefficients=[float(b) for b in beta_rls[1:]],
        intercept=float(beta_rls[0]),
        r_squared=float(r_squared),
        adjusted_r_squared=float(adjusted),
        predictions=[float(v) for v in predictions],
        residuals=[float(v) for v in residuals],
        rss=rss_rls,
        equation=format_equation(y_name, float(beta_rls[0]), beta_rls[1:], feature_names),
        feature_names=list(feature_names),
        y_name=y_name,
        n_obs=n,
        n_features=k,
        std_errors=std_errors,
        t_stats=t_stats,
        p_values=p_values,
        ci95=ci95,
        df=df,
        sigma2=float(sigma2),
        f_stat=float(f_stat),
        f_p_value=float(f_p_value),
        rls_constraint=constraint.label,
        rss_ols=float(rss_ols),
        rss_rls=float(rss_rls),
        f_stat_constraint=float(f_stat_constraint),
        f_p_value_constraint=float(f_p_value_constraint),
        j_constraints=j,
        restricted_inference_available=available,
    )
