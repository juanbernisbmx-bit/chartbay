"""Tests de contrato de la API (capa HTTP) vía TestClient."""


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
