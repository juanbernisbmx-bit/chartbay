"""Fixtures compartidas de la suite del ChartBay Engine."""

import pytest
from fastapi.testclient import TestClient

from chartbay_engine.main import app


@pytest.fixture(scope="session")
def client() -> TestClient:
    """Cliente HTTP de pruebas contra la app FastAPI (sin levantar servidor)."""
    return TestClient(app)
