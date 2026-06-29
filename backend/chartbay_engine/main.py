"""Punto de entrada del ChartBay Engine: arma la app FastAPI.

Ejecutar en local:
    uvicorn chartbay_engine.main:app --reload --port 8000
"""

from __future__ import annotations

import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from chartbay_engine import __version__
from chartbay_engine.api.json_response import SafeJSONResponse
from chartbay_engine.api.v1 import api_router as api_v1_router
from chartbay_engine.core.errors import EngineError

DEFAULT_CORS_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5000",
    "http://127.0.0.1:5000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]


def _cors_origins() -> list[str]:
    """Orígenes permitidos para CORS.

    En transición el frontend lo sirve Flask (otro origen), por eso se habilita CORS.
    Configurable con CHARTBAY_ENGINE_CORS_ORIGINS (lista separada por comas).
    """
    raw = os.environ.get("CHARTBAY_ENGINE_CORS_ORIGINS")
    if raw is None or not raw.strip():
        return DEFAULT_CORS_ORIGINS.copy()
    raw = raw.strip()
    if raw == "*":
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
        default_response_class=SafeJSONResponse,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins(),
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(EngineError)
    async def _engine_error_handler(_request: Request, exc: EngineError) -> JSONResponse:
        """Traduce errores de dominio del núcleo a HTTP 422 con cuerpo estructurado."""
        return JSONResponse(
            status_code=422,
            content={"error": exc.message, "code": exc.code, "details": exc.details},
        )

    app.include_router(api_v1_router, prefix="/api/v1")
    return app


app = create_app()
