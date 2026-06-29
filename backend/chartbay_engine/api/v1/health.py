"""Endpoint de salud: comprueba que el servicio está vivo y reporta su versión."""

from fastapi import APIRouter

from chartbay_engine import __version__
from chartbay_engine.schemas.common import CamelModel

router = APIRouter()


class HealthResponse(CamelModel):
    status: str
    service: str
    version: str


@router.get("/health", response_model=HealthResponse, summary="Estado del servicio")
def health() -> HealthResponse:
    return HealthResponse(status="ok", service="chartbay-engine", version=__version__)
