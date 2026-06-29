"""Endpoints de regresión: OLS y RLS (mínimos cuadrados restringidos / Wald)."""

from fastapi import APIRouter

from chartbay_engine.schemas.regression import OLSRequest, RegressionResult, RLSRequest
from chartbay_engine.services import regression_service

router = APIRouter(prefix="/regression", tags=["regression"])


@router.post(
    "/ols",
    response_model=RegressionResult,
    response_model_exclude_none=True,
    summary="Regresión OLS",
)
def ols(request: OLSRequest) -> RegressionResult:
    result = regression_service.estimate_ols(
        x=request.x,
        y=request.y,
        feature_names=request.feature_names,
        y_name=request.y_name,
        drop_redundant=request.drop_redundant,
    )
    return RegressionResult.model_validate(result)


@router.post(
    "/rls",
    response_model=RegressionResult,
    response_model_exclude_none=True,
    summary="Regresión con restricciones lineales (RLS / Wald)",
)
def rls(request: RLSRequest) -> RegressionResult:
    result = regression_service.estimate_rls(
        x=request.x,
        y=request.y,
        feature_names=request.feature_names,
        y_name=request.y_name,
        constraint_r=request.constraint.r,
        constraint_q=request.constraint.q,
        constraint_label=request.constraint.label,
    )
    return RegressionResult.model_validate(result)
