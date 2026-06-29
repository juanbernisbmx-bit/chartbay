"""Punto de entrada del ChartBay Engine: arma la app FastAPI.

Ejecutar en local:
    uvicorn chartbay_engine.main:app --reload --port 8000
"""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from chartbay_engine import __version__
from chartbay_engine.api.v1 import api_router as api_v1_router


def _cors_origins() -> list[str]:
    """Orígenes permitidos para CORS.

    En transición el frontend lo sirve Flask (otro origen), por eso se habilita CORS.
    Configurable con CHARTBAY_ENGINE_CORS_ORIGINS (lista separada por comas); "*" por defecto.
    """
    raw = os.environ.get("CHARTBAY_ENGINE_CORS_ORIGINS", "*").strip()
    if raw == "*" or not raw:
        return ["*"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


def create_app() -> FastAPI:
    """Crea y configura la instancia de FastAPI (app factory)."""
    app = FastAPI(
        title="ChartBay Engine",
        version=__version__,
        description=(
            "Motor cuantitativo de ChartBay: econometría, series de tiempo y, a futuro, "
            "finanzas y machine learning."
        ),
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins(),
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(api_v1_router, prefix="/api/v1")
    return app


app = create_app()
