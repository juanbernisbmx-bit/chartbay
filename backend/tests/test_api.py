"""Tests de contrato de la API (capa HTTP) vía TestClient."""

import numpy as np


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
