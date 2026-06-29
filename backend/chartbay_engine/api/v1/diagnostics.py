"""Endpoints de diagnósticos de series de tiempo: ADF (ACF/PACF/Ljung-Box en Etapa E)."""

from fastapi import APIRouter

from chartbay_engine.schemas.diagnostics import (
    ADFRequest,
    ADFResultSchema,
    AutocorrelationRequest,
    AutocorrelationResultSchema,
)
from chartbay_engine.services import diagnostics_service

router = APIRouter(prefix="/diagnostics", tags=["diagnostics"])


@router.post(
    "/adf",
    response_model=ADFResultSchema,
    response_model_exclude_none=True,
    summary="Test ADF de estacionariedad",
)
def adf(request: ADFRequest) -> ADFResultSchema:
    result = diagnostics_service.adf(values=request.values, lag=request.lag)
    return ADFResultSchema.model_validate(result)


@router.post(
    "/autocorrelation",
    response_model=AutocorrelationResultSchema,
    summary="ACF, PACF y Ljung-Box",
)
def autocorrelation(request: AutocorrelationRequest) -> AutocorrelationResultSchema:
    result = diagnostics_service.autocorrelation(
        values=request.values, max_lag=request.max_lag
    )
    return AutocorrelationResultSchema.model_validate(result)
