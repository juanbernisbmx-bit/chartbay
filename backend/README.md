# ChartBay Engine

Motor de cálculo cuantitativo de ChartBay, en Python. Reemplaza progresivamente al motor
econométrico que hoy corre en el navegador (`quantbay/` en TypeScript) **sin romper el
frontend actual**: el bundle TS sigue funcionando y este servicio queda disponible en
paralelo para una migración endpoint-por-endpoint ("strangler fig").

Pensado como plataforma cuantitativa a largo plazo (no sólo una calculadora econométrica):
la estructura ya contempla finanzas (portafolio, riesgo, valuación) y machine learning,
aunque la primera etapa entrega econometría y diagnósticos de series de tiempo.

## Stack

Python 3.12+ · FastAPI · Pydantic v2 · NumPy · SciPy · Pandas · Statsmodels · Pytest · Uvicorn

## Arquitectura

Separación estricta en tres capas (ADR-6), de adentro hacia afuera:

```
chartbay_engine/
  core/            # MATEMÁTICA PURA. Sin imports de FastAPI/Pydantic.
    econometrics/
      regression/  # OLS, RLS/Wald
      time_series/ # ADF (estacionariedad), ACF/PACF/Ljung-Box
      diagnostics/ # colinealidad / VIF / chequeo de rango
      inference.py # distribuciones t/F/χ² (envuelve scipy.stats) — compartido (DRY)
    finance/       # portfolio / risk / valuation  (esqueletos para crecer)
    machine_learning/ forecasting/                 (esqueleto para crecer)
  services/        # LÓGICA DE NEGOCIO: orquesta core + validación de entrada.
  schemas/         # CONTRATOS Pydantic (camelCase, espejan las interfaces TS).
  api/v1/          # CAPA HTTP fina: routers FastAPI versionados.
  main.py          # create_app(): arma FastAPI, CORS y monta /api/v1.
tests/             # pytest; compara contra Statsmodels como oráculo independiente.
```

`core` no conoce HTTP ni Pydantic: recibe y devuelve estructuras Python puras
(`dataclasses`/`dict`/`numpy`). Eso permite testearlo de forma aislada y reutilizarlo desde
otros frontends (CLI, notebooks, jobs) sin arrastrar FastAPI.

## Decisiones de arquitectura (ADR)

- **ADR-1 — Núcleo propio, validado contra Statsmodels (no un wrapper).** OLS se estima con
  descomposición QR (`numpy.linalg`), más estable que las ecuaciones normales + Gauss-Jordan
  del motor TS; RLS en forma cerrada. Statsmodels se usa **sólo en los tests** como oráculo
  independiente, de modo que los tests son significativos (no circulares) y el contrato de
  salida es propio y estable.
- **ADR-2 — Contratos camelCase que espejan las interfaces TS.** Los esquemas replican
  `RegressionResult`, `ADFResult` y `AutocorrelationResult` (`rSquared`, `stdErrors`,
  `criticalValues`, …). El frontend puede cambiar `runOLS(...)` por `fetch(...)` con cambios
  mínimos.
- **ADR-3 — Servicio autónomo, runtime aislado.** Vive en `backend/` con su propio
  `pyproject.toml` y venv (`backend/.venv`, Python 3.12); no toca `requirements.txt`,
  `web/app.py` ni el bundle TS. CORS habilitado para la transición.
- **ADR-4 — ADF con p-valor de MacKinnon.** El motor TS devuelve `pValue: null`; acá se
  añade un p-valor aproximado y el estadístico se valida contra `statsmodels`.
- **ADR-5 — API versionada `/api/v1`** para estabilidad de contratos a largo plazo.
- **ADR-6 — Separación estricta** `core` → `services` → `api` (arriba).

## Puesta en marcha (local)

```bash
# crear venv (Python 3.12) e instalar en modo editable con extras de desarrollo
python -m venv .venv
.venv/Scripts/activate        # Windows ;  source .venv/bin/activate en Unix
pip install -e ".[dev]"

# levantar el servicio
uvicorn chartbay_engine.main:app --reload --port 8000
# -> docs interactivas en http://127.0.0.1:8000/docs
# -> health           en http://127.0.0.1:8000/api/v1/health
```

## Tests

```bash
pip install -e ".[dev]"
pytest          # corre tests/, comparando resultados contra Statsmodels
```

## Estado (primera etapa)

| Capacidad                         | Endpoint                                | Estado |
| --------------------------------- | --------------------------------------- | ------ |
| Health                            | `GET  /api/v1/health`                   | ✅     |
| OLS                               | `POST /api/v1/regression/ols`           | ⏳     |
| RLS / Wald                        | `POST /api/v1/regression/rls`           | ⏳     |
| ADF                               | `POST /api/v1/diagnostics/adf`          | ⏳     |
| ACF / PACF / Ljung-Box            | `POST /api/v1/diagnostics/autocorrelation` | ⏳  |

(Se completa por etapas; ver el plan del proyecto.)
