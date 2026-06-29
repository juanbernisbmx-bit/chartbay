"""Detección de colinealidad y deficiencia de rango en la matriz de diseño.

Porta la lógica del motor TS (`quantbay/src/regression.ts`): ortogonalización de
Gram-Schmidt modificada para hallar columnas dependientes y una clasificación legible del
problema (columna constante que duplica el intercepto, colinealidad par casi perfecta, o
combinación lineal genérica). Incluye además el VIF por predictor.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class RankIssue:
    col_idx: int  # índice en la matriz aumentada Xd (0 = intercepto)
    name: str
    reason: str


def find_dependent_columns(xd: np.ndarray) -> set[int]:
    """Índices (en Xd) de columnas linealmente dependientes de las anteriores.

    Procesa de izquierda a derecha, de modo que dentro de un grupo colineal se conserva la
    columna de menor índice y las posteriores se marcan como dependientes.
    """
    n, p = xd.shape
    col_norms = np.sqrt((xd**2).sum(axis=0))
    max_norm = float(col_norms.max()) if p else 0.0
    eps = 1e-10 * np.sqrt(n) * max_norm

    dependent: set[int] = set()
    basis: list[np.ndarray] = []
    for j in range(p):
        v = xd[:, j].astype(float).copy()
        for b in basis:
            v -= float(b @ v) * b
        norm = float(np.sqrt(v @ v))
        if norm < eps:
            dependent.add(j)
        else:
            basis.append(v / norm)
    return dependent


def detect_rank_issues(xd: np.ndarray, all_names: list[str]) -> list[RankIssue] | None:
    """``None`` si Xd tiene rango completo; si no, la lista de problemas detectados.

    ``all_names[0]`` debe ser el nombre del intercepto (p. ej. ``"(intercepto)"``).
    """
    dependent = find_dependent_columns(xd)
    if not dependent:
        return None

    n, p = xd.shape
    col_means = xd.mean(axis=0)
    col_stds = xd.std(axis=0)  # poblacional (ddof=0), como el motor TS

    issues: list[RankIssue] = []
    reported: set[int] = set()

    # Caso A: columna de varianza cero (constante) que duplica el intercepto automático.
    for j in sorted(dependent):
        if j == 0:
            continue  # el intercepto en sí siempre es independiente
        scale = max(abs(float(col_means[j])), 1.0)
        if col_stds[j] / scale < 1e-10:
            issues.append(
                RankIssue(
                    j,
                    all_names[j],
                    f'"{all_names[j]}" tiene varianza cero (columna constante) y duplica '
                    f"el intercepto automático del modelo.",
                )
            )
            reported.add(j)

    # Caso B: correlación par casi perfecta (|r| > 0.9999) con una columna independiente.
    for j in sorted(dependent):
        if j in reported:
            continue
        sj = float(col_stds[j])
        if sj < 1e-15:
            continue
        mj = float(col_means[j])
        col_j = xd[:, j]
        best_corr, best_i = 0.0, -1
        for i in range(p):
            if i == j or i in dependent:
                continue
            si = float(col_stds[i])
            if si < 1e-15:
                continue
            cov = float(((xd[:, i] - col_means[i]) * (col_j - mj)).mean())
            corr = abs(cov / (si * sj))
            if corr > best_corr:
                best_corr, best_i = corr, i
        if best_corr > 0.9999 and best_i >= 0:
            issues.append(
                RankIssue(
                    j,
                    all_names[j],
                    f'"{all_names[j]}" es perfectamente colineal con "{all_names[best_i]}" '
                    f"(|correlación| = {best_corr:.6f}).",
                )
            )
            reported.add(j)

    # Caso C: resto de columnas dependientes — combinación lineal genérica.
    for j in sorted(dependent):
        if j not in reported:
            issues.append(
                RankIssue(
                    j,
                    all_names[j],
                    f'"{all_names[j]}" es combinación lineal de otras columnas del modelo.',
                )
            )
            reported.add(j)

    return issues


def compute_vif(x: np.ndarray) -> list[float]:
    """Factor de inflación de varianza (VIF) por predictor de la matriz X (n×k)."""
    x = np.asarray(x, dtype=float)
    n, k = x.shape
    if k <= 1:
        return [1.0] * k

    vifs: list[float] = []
    for j in range(k):
        target = x[:, j]
        others = np.delete(x, j, axis=1)
        design = np.column_stack([np.ones(n), others])
        try:
            beta, *_ = np.linalg.lstsq(design, target, rcond=None)
            resid = target - design @ beta
            ss_res = float(resid @ resid)
            ss_tot = float(((target - target.mean()) ** 2).sum())
            r2 = 0.0 if ss_tot == 0 else max(0.0, 1.0 - ss_res / ss_tot)
            vifs.append(float("inf") if r2 >= 1 - 1e-10 else 1.0 / (1.0 - r2))
        except np.linalg.LinAlgError:
            vifs.append(float("inf"))
    return vifs
