"""Router agregador de la API v1.

Cada dominio (health, regression, diagnostics, …) aporta su propio APIRouter; acá se
combinan bajo un único `api_router` que `main.py` monta con prefijo `/api/v1`.
"""

from fastapi import APIRouter

from chartbay_engine.api.v1 import health

api_router = APIRouter()
api_router.include_router(health.router, tags=["health"])

# Los routers de regresión y diagnósticos se montan en las etapas siguientes.
