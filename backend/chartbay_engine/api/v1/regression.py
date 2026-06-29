"""Endpoints de regresión: OLS (y RLS en la etapa siguiente)."""

from fastapi import APIRouter

from chartbay_engine.schemas.regression import OLSRequest, RegressionResult
from chartbay_engine.services import regression_service

router = APIRouter(prefix="/regression", tags=["regression"])


@router.post("/ols", response_model=RegressionResult, summary="Regresión OLS")
def ols(request: OLSRequest) -> RegressionResult:
    result = regression_service.estimate_ols(
        x=request.x,
        y=request.y,
        feature_names=request.feature_names,
        y_name=request.y_name,
        drop_redundant=request.drop_redundant,
    )
    return RegressionResult.model_validate(result)
