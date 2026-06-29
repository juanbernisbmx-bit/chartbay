"""Tests de contrato de la API (capa HTTP) vía TestClient."""

import numpy as np
import pytest

from chartbay_engine.api.json_response import to_json_safe
from chartbay_engine.main import _cors_origins


def _schema_allows_null(schema: dict) -> bool:
    return any(option.get("type") == "null" for option in schema.get("anyOf", []))


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


def test_openapi_marks_non_finite_regression_fields_nullable(client):
    schema = client.get("/openapi.json").json()["components"]["schemas"]["RegressionResult"]
    props = schema["properties"]

    for key in ("fStat", "fPValue"):
        assert _schema_allows_null(props[key])

    for key in ("stdErrors", "tStats", "pValues"):
        assert _schema_allows_null(props[key]["items"])

    for ci_item in props["ci95"]["items"]["prefixItems"]:
        assert _schema_allows_null(ci_item)


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


def test_ols_perfect_fit_serializes_nullable_f_stat(client):
    payload = {
        "X": [[float(i)] for i in range(1, 7)],
        "y": [2.0 * i + 1.0 for i in range(1, 7)],
        "featureNames": ["x"],
    }
    resp = client.post("/api/v1/regression/ols", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["fStat"] is None
    assert body["fPValue"] == 0.0


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


def _adf_values(seed: int = 1, n: int = 200, phi: float = 0.5) -> list[float]:
    rng = np.random.default_rng(seed)
    e = rng.normal(0.0, 1.0, n)
    x = np.empty(n)
    x[0] = e[0]
    for t in range(1, n):
        x[t] = phi * x[t - 1] + e[t]
    return [float(v) for v in x]


def test_adf_endpoint_contract(client):
    resp = client.post("/api/v1/diagnostics/adf", json={"values": _adf_values(), "lag": 4})
    assert resp.status_code == 200

    body = resp.json()
    for key in (
        "available", "statistic", "pValue", "usedLag", "nObs", "criticalValues", "isStationary",
    ):
        assert key in body, f"falta el campo {key} en la respuesta ADF"
    assert body["available"] is True
    assert body["usedLag"] == 4
    assert 0.0 <= body["pValue"] <= 1.0
    for key in ("onePercent", "fivePercent", "tenPercent"):
        assert key in body["criticalValues"]


def test_adf_endpoint_optional_lag(client):
    resp = client.post("/api/v1/diagnostics/adf", json={"values": _adf_values()})
    assert resp.status_code == 200
    assert resp.json()["available"] is True


def test_adf_endpoint_negative_lag_returns_422(client):
    resp = client.post("/api/v1/diagnostics/adf", json={"values": _adf_values(), "lag": -1})
    assert resp.status_code == 422
    assert resp.json()["code"] == "invalid_input"


def test_adf_endpoint_non_finite_value_returns_422(client):
    resp = client.post(
        "/api/v1/diagnostics/adf",
        content='{"values":[1,2,3,NaN,5,6,7,8,9]}',
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "invalid_input"


def test_adf_endpoint_constant_series_available_false(client):
    resp = client.post("/api/v1/diagnostics/adf", json={"values": [5.0] * 40})
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is False
    assert "reason" in body


def test_autocorrelation_endpoint_contract(client):
    resp = client.post(
        "/api/v1/diagnostics/autocorrelation", json={"values": _adf_values(), "maxLag": 10}
    )
    assert resp.status_code == 200

    body = resp.json()
    for key in (
        "observations", "requestedMaxLag", "maxLag", "threshold", "rows", "pacf",
        "ljungBox", "warnings", "interpretation", "pacfInterpretation",
    ):
        assert key in body, f"falta el campo {key} en la respuesta de autocorrelación"
    assert len(body["rows"]) == 10
    assert {"lag", "autocorrelation", "threshold", "outsideThreshold"} <= body["rows"][0].keys()
    pacf_keys = {"lag", "partialAutocorrelation", "threshold", "outsideThreshold"}
    assert pacf_keys <= body["pacf"][0].keys()
    assert {"lag", "qStatistic", "pValue", "interpretation"} <= body["ljungBox"][0].keys()


def test_autocorrelation_endpoint_optional_max_lag(client):
    resp = client.post("/api/v1/diagnostics/autocorrelation", json={"values": _adf_values()})
    assert resp.status_code == 200
    assert resp.json()["maxLag"] == 12  # default


def test_autocorrelation_endpoint_non_finite_value_returns_422(client):
    resp = client.post(
        "/api/v1/diagnostics/autocorrelation",
        content='{"values":[1,2,3,Infinity,5,6,7,8,9]}',
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "invalid_input"


def test_cors_default_origins_are_not_wildcard(monkeypatch):
    monkeypatch.delenv("CHARTBAY_ENGINE_CORS_ORIGINS", raising=False)
    origins = _cors_origins()
    assert "*" not in origins
    assert "http://localhost:5000" in origins
