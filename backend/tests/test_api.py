"""Tests de contrato de la API (capa HTTP) vía TestClient."""

import numpy as np
import pytest

from chartbay_engine.api.json_response import to_json_safe


def test_health_ok(client):
    resp = client.get("/api/v1/health")
    assert resp.status_code == 200

    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "chartbay-engine"
    assert "version" in body and body["version"]


def test_openapi_served(client):
    """El esquema OpenAPI se genera (sirve de smoke test de toda la app)."""
    resp = client.get("/openapi.json")
    assert resp.status_code == 200
    assert resp.json()["info"]["title"] == "ChartBay Engine"


def _ols_payload() -> dict:
    rng = np.random.default_rng(1)
    n = 30
    x1 = rng.uniform(-3, 3, n)
    x2 = rng.uniform(-3, 3, n)
    y = 1.5 + 2.0 * x1 - 0.5 * x2 + rng.normal(0, 0.1, n)
    return {
        "X": [[float(a), float(b)] for a, b in zip(x1, x2, strict=True)],
        "y": [float(v) for v in y],
        "featureNames": ["x1", "x2"],
        "yName": "y",
    }


def test_ols_endpoint_contract(client):
    resp = client.post("/api/v1/regression/ols", json=_ols_payload())
    assert resp.status_code == 200

    body = resp.json()
    for key in (
        "coefficients", "intercept", "rSquared", "adjustedRSquared", "predictions",
        "residuals", "rss", "equation", "stdErrors", "tStats", "pValues", "ci95",
        "df", "sigma2", "fStat", "fPValue", "method",
    ):
        assert key in body, f"falta el campo {key} en la respuesta"

    assert body["method"] == "OLS"
    assert len(body["coefficients"]) == 2
    assert len(body["stdErrors"]) == 3  # intercepto + 2 pendientes
    assert body["rSquared"] > 0.99  # datos casi deterministas


def test_ols_endpoint_shape_mismatch_returns_422(client):
    payload = _ols_payload()
    payload["y"] = payload["y"][:-1]  # longitudes inconsistentes -> validación Pydantic
    resp = client.post("/api/v1/regression/ols", json=payload)
    assert resp.status_code == 422


def test_ols_endpoint_collinearity_returns_structured_422(client):
    payload = {
        "X": [[float(i), float(2 * i)] for i in range(1, 9)],  # x2 = 2*x1
        "y": [float(i) for i in range(1, 9)],
        "featureNames": ["x1", "x2"],
        "yName": "y",
    }
    resp = client.post("/api/v1/regression/ols", json=payload)
    assert resp.status_code == 422
    assert resp.json()["code"] == "rank_deficiency"


def test_ols_response_omits_rls_only_fields(client):
    """OLS no debe arrastrar campos específicos de RLS (response_model_exclude_none)."""
    body = client.post("/api/v1/regression/ols", json=_ols_payload()).json()
    assert "method" in body and body["method"] == "OLS"
    for rls_only in ("rssOLS", "rssRLS", "fStatConstraint", "jConstraints"):
        assert rls_only not in body


def _rls_payload(constraint: dict | None = None) -> dict:
    rng = np.random.default_rng(3)
    n = 40
    x1 = rng.uniform(-3, 3, n)
    x2 = rng.uniform(-3, 3, n)
    y = 1.0 + 0.6 * x1 + 0.4 * x2 + rng.normal(0, 0.1, n)
    return {
        "X": [[float(a), float(b)] for a, b in zip(x1, x2, strict=True)],
        "y": [float(v) for v in y],
        "featureNames": ["x1", "x2"],
        "yName": "y",
        "constraint": constraint or {"R": [[0, 1, 1]], "q": [1.0], "label": "beta1+beta2=1"},
    }


def test_rls_endpoint_contract(client):
    resp = client.post("/api/v1/regression/rls", json=_rls_payload())
    assert resp.status_code == 200

    body = resp.json()
    for key in (
        "method", "coefficients", "stdErrors", "tStats", "pValues", "rSquared",
        "adjustedRSquared", "rss", "residuals", "rssOLS", "rssRLS", "fStatConstraint",
        "fPValueConstraint", "jConstraints", "restrictedInferenceAvailable", "equation",
    ):
        assert key in body, f"falta el campo {key} en la respuesta RLS"

    assert body["method"] == "RLS"
    assert body["jConstraints"] == 1
    assert body["restrictedInferenceAvailable"] is True
    # la restricción beta1 + beta2 = 1 debe cumplirse exactamente
    assert body["coefficients"][0] + body["coefficients"][1] == pytest.approx(1.0, abs=1e-6)


def test_rls_endpoint_invalid_dimension_returns_422(client):
    payload = _rls_payload(constraint={"R": [[0, 1]], "q": [0.0], "label": "bad"})
    resp = client.post("/api/v1/regression/rls", json=payload)
    assert resp.status_code == 422
    assert resp.json()["code"] == "invalid_constraint"


def test_rls_endpoint_singular_constraint_returns_422(client):
    payload = _rls_payload(
        constraint={"R": [[0, 1, -1], [0, 2, -2]], "q": [0.0, 0.0], "label": "redundant"}
    )
    resp = client.post("/api/v1/regression/rls", json=payload)
    assert resp.status_code == 422
    assert resp.json()["code"] == "singular_constraint"


def test_to_json_safe_nulls_non_finite():
    payload = {"a": float("inf"), "b": [1.0, float("nan"), float("-inf")], "c": "x", "d": 3}
    assert to_json_safe(payload) == {"a": None, "b": [1.0, None, None], "c": "x", "d": 3}

