# ChartBay — Plan de Reenfoque de Producto

> **Documento histórico — planificación del 30 de junio de 2026.**
> Es el plan que llevó al reenfoque, no un informe de estado. Lo que quedó
> efectivamente en ChartBay 1.0 está en
> [`V1_RELEASE_SCOPE.md`](V1_RELEASE_SCOPE.md); varias filas de las tablas de
> abajo marcan como "Producción" componentes que hoy están apagados o que nunca
> se desplegaron, entre ellos el motor Python con FastAPI.

---

## 1. Nueva visión del producto

**ChartBay Engine** es un motor web de cálculo para econometría y finanzas cuantitativas.

No es una app de trading. No es un marketplace. No es un dashboard genérico de acciones. Es una plataforma técnica para construir, validar y explorar modelos cuantitativos directamente desde el navegador, con un backend Python que garantiza precisión numérica reproducible.

### Identidad de producto

> Motor web de cálculo para econometría y finanzas cuantitativas.

### Propuesta de valor

- El usuario llega con datos (CSV, series de tiempo, variables macroeconómicas).
- El motor estima modelos, valida supuestos y exporta resultados.
- El rigor numérico está validado contra referencias estándar (statsmodels, scipy).
- El laboratorio web permite exploración sin instalar nada.

### Para quién es

- Economistas y analistas que necesitan herramientas cuantitativas en la web.
- Estudiantes de finanzas cuantitativas y econometría.
- Equipos que quieren correr OLS, ADF, VaR o Markowitz sin configurar Python localmente.

---

## 2. Módulos que deben quedar como núcleo

### 2.1 Motor Python — `backend/chartbay_engine/`

| Módulo | Archivo principal | Estado |
|--------|------------------|--------|
| OLS (QR decomposition) | `core/econometrics/regression/ols.py` | ✅ Producción |
| RLS / Wald (R·β = q) | `core/econometrics/regression/rls.py` | ✅ Producción |
| Inferencia estadística (t, F, χ²) | `core/econometrics/inference.py` | ✅ Producción |
| ADF (test de raíz unitaria) | `core/econometrics/time_series/stationarity.py` | ✅ Producción |
| ACF / PACF / Ljung-Box | `core/econometrics/time_series/autocorrelation.py` | ✅ Producción |
| Detección de colinealidad / VIF | `core/econometrics/diagnostics/collinearity.py` | ✅ Producción |
| API FastAPI `/api/v1/` | `api/v1/` + `services/` | ✅ Producción |
| Tests numéricos vs statsmodels | `backend/tests/` | ✅ Activos |

### 2.2 Laboratorio web — QuantBay (TypeScript)

| Módulo | Ubicación | Rol |
|--------|-----------|-----|
| Bundle TypeScript | `quantbay/src/` + `web/static/js/quantbay.bundle.js` | UI de cálculo, fallback educativo |
| Interfaz de usuario | `web/templates/quantbay.html` (alias `chartbay.html`) | Pantalla principal del laboratorio |
| Validación rápida en browser | `quantbay/src/` | Feedback inmediato antes de llamar al backend |

### 2.3 Datos macroeconómicos — `providers/`

| Proveedor | Archivo | Estado |
|-----------|---------|--------|
| FRED (~60 indicadores US) | `providers/fred.py` | ✅ Activo |
| World Bank (multi-país) | `providers/worldbank.py` | ✅ Activo |
| BCRA | `providers/bcra.py` | ⏳ Plantilla lista, sin implementar |
| OECD | `providers/oecd.py` | ⏳ Plantilla lista, sin implementar |
| IMF | `providers/imf.py` | ⏳ Plantilla lista, sin implementar |
| Exportaciones CSV / TXT | `providers/exporters.py` | ✅ Activo |
| Exportación XLSX | `providers/exporters.py:72` | ❌ Bloqueada (falta openpyxl) |

### 2.4 Infraestructura

| Componente | Ubicación | Mantener |
|-----------|-----------|---------|
| Flask app factory | `web/app.py` | ✅ Sí (como capa web) |
| Configuración `.env` / `config.py` | `config.py`, `.env` | ✅ Sí |
| `requirements.txt` | raíz | ✅ Sí |
| `backend/pyproject.toml` | `backend/` | ✅ Sí |
| Tests de regresión numérica | `backend/tests/` | ✅ Sí |
| `ARCHITECTURE.md` | raíz | ✅ Sí |

---

## 3. Módulos que deben salir del foco principal

Esta sección **mapea** el código involucrado. **No propone borrar nada todavía.**

### 3.1 Comunidad de bots / Marketplace

**Propósito actual:** usuarios crean bots de trading, los publican, otros los reseñan y califican.

**Por qué sale:** no tiene relación con el motor de cálculo cuantitativo. Es un marketplace de estrategias de trading, no una herramienta analítica.

| Tipo | Nombre / Ruta |
|------|--------------|
| Rutas Flask | `GET /community`, `GET /community/new`, `GET /community/bot/<id>`, `POST /community/bot/create`, `POST /community/bot/<id>/review` |
| Templates | `web/templates/community.html`, `web/templates/bot_detail.html`, `web/templates/bot_new.html` |
| Tabla DB | `bots`, `reviews` (en `web/chartbay.db` y `web/db.py`) |
| Funciones en `app.py` | `community()`, `bot_detail()`, `bot_new()`, `bot_create()`, `review_bot()` |
| Auth dependency | login requerido para `bot_create` y `review_bot` |

**Dependencias de riesgo:**
- `web/db.py` define también la tabla `users` (auth). Si se borra `db.py` completo se rompe el login.
- El navbar incluye enlace a `/community` — si se deja sin ocultar, el enlace lleva a una ruta muerta.

---

### 3.2 Heatmap de correlación

**Propósito actual:** mapa visual de correlaciones entre tickers seleccionados.

**Por qué sale:** es una herramienta de visualización de mercado, no un módulo analítico cuantitativo reutilizable.

| Tipo | Nombre / Ruta |
|------|--------------|
| Ruta Flask | `GET /heatmap` |
| Template | `web/templates/heatmap.html` |
| Función en `app.py` | `heatmap()` |
| Dependencias | `data.py` (descarga OHLCV), `indicators.py` (cálculo de correlaciones) |

**Dependencias de riesgo:**
- `data.py` e `indicators.py` son usados también por el motor técnico central y el CLI (`main.py`). No se pueden borrar solo por esto.
- La ruta puede desactivarse sin tocar esos módulos.

---

### 3.3 Comparador visual de acciones

**Propósito actual:** gráfico side-by-side de dos o más tickers normalizados.

**Por qué sale:** herramienta de trading genérico, no de análisis cuantitativo.

| Tipo | Nombre / Ruta |
|------|--------------|
| Ruta Flask | `GET /compare` |
| Template | `web/templates/compare.html` |
| Función en `app.py` | `compare()` |
| Dependencias | `data.py`, yfinance |

**Dependencias de riesgo:**
- Solo usa `data.py` que es compartido. Sin riesgos de rotura cruzada al deshabilitar la ruta.

---

### 3.4 Dashboard de mercado (tickers / scanner)

**Propósito actual:** tarjetas de precios en tiempo real, indicadores técnicos, scanner de señales.

**Por qué sale:** define la identidad visual actual de ChartBay como "app de trading", que es exactamente la imagen que queremos cambiar.

| Tipo | Nombre / Ruta |
|------|--------------|
| Ruta Flask principal | `GET /` (raíz → dashboard) |
| Template | `web/templates/dashboard.html` |
| API routes | `GET /api/snapshot`, `GET /api/lookup`, `GET /api/news` |
| Función en `app.py` | `dashboard()`, `api_snapshot()`, `api_lookup()`, `api_news()` |
| Dependencias | `data.py`, `indicators.py`, `config.py` (lista de tickers), yfinance |

**Dependencias de riesgo:**
- `/` es la raíz de la app. Si se elimina sin reemplazar, la app muestra 404 en la raíz.
- `config.py` tiene la lista de tickers y parámetros globales — también los usa el CLI y el motor de análisis.
- Las rutas `/api/snapshot` y `/api/lookup` podrían ser consumidas por templates restantes (verificar antes de desactivar).

---

### 3.5 Análisis IA de acciones (Claude API)

**Propósito actual:** genera un análisis en markdown del estado técnico de cada ticker usando Claude.

**Por qué sale:** análisis de mercado genérico con IA no es el foco de un motor de cálculo cuantitativo. Además, genera costos por cada llamada a la API de Claude.

| Tipo | Nombre / Ruta |
|------|--------------|
| Módulo | `analyze.py` |
| Rutas Flask | `POST /api/verdict`, `POST /api/verdict_one` |
| Funciones en `app.py` | `api_verdict()`, `api_verdict_one()` |
| Dependencias externas | `anthropic` SDK, clave `ANTHROPIC_API_KEY` |
| Cache | `informes/` (archivos markdown diarios) |

**Dependencias de riesgo:**
- `analyze.py` es independiente. Se puede deshabilitar sin romper nada más.
- El CLI `main.py` también llama a `analyze.py`. Si se elimina, el CLI queda roto.
- Los templates del dashboard muestran el resultado del análisis IA. Si se mueve el dashboard a legacy, esta dependencia desaparece naturalmente.

---

### 3.6 Embeds de TradingView

**Propósito actual:** gráficos interactivos de TradingView embebidos en la UI de tickers.

**Por qué sale:** dependencia de un servicio externo de terceros que refuerza la imagen de app de trading.

| Tipo | Nombre / Ruta |
|------|--------------|
| Configuración | `config.py` → `TRADINGVIEW` dict (mapeo ticker → símbolo TV) |
| Templates | `web/templates/dashboard.html`, posiblemente `bot_detail.html` |
| Dependencia | Solo JavaScript embebido (no hay ruta Flask) |

**Dependencias de riesgo:**
- Es solo configuración + HTML. No hay código Python dependiente. El riesgo es cero si se elimina del template.

---

### 3.7 Historial de reportes (parcialmente)

**Propósito actual:** listado de análisis IA generados (archivos `.md` en `informes/`).

**Evaluación:** si el análisis IA de acciones sale del foco, esta sección pierde razón de ser. Se puede conservar en versión futura si se generan reportes de modelos econométricos.

| Tipo | Nombre / Ruta |
|------|--------------|
| Ruta Flask | `GET /reports` |
| Template | `web/templates/reports.html` |
| Función | `reports()` |
| Dependencia | Lee `informes/*.md` del filesystem |

---

## 4. Arquitectura futura propuesta

```
┌─────────────────────────────────────────────────┐
│                   Usuario                        │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│              UI Web (Jinja2 + Vanilla JS)        │
│  - Formularios de cálculo                        │
│  - Carga de CSV / datos                          │
│  - Visualización de resultados                   │
│  - Exportación (CSV, XLSX, JSON)                 │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│         Flask (capa de enrutamiento web)         │
│  - Auth, sesiones                                │
│  - Sirve templates y archivos estáticos          │
│  - Proxy a FastAPI cuando es necesario           │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│         FastAPI — ChartBay Engine /api/v1/       │
│  - Endpoints de cálculo (OLS, RLS, ADF, …)      │
│  - Validación de entrada (Pydantic v2)           │
│  - Respuestas JSON serializables (SafeJSON)      │
└───────────┬─────────────────────┬───────────────┘
            │                     │
┌───────────▼──────────┐ ┌───────▼───────────────┐
│  Core Econométrico   │ │  Core Finanzas Quant   │
│  - OLS / RLS         │ │  - Retornos, vol       │
│  - ADF, ACF, PACF    │ │  - Sharpe, Sortino     │
│  - Ljung-Box         │ │  - VaR, CVaR           │
│  - Inferencia t/F/χ² │ │  - Markowitz           │
│  - Collinealidad/VIF │ │  - CAPM, Beta          │
└───────────┬──────────┘ │  - Backtesting         │
            │            │  - Valuación DCF        │
            │            └───────────────────────┘
            │
┌───────────▼──────────────────────────────────────┐
│           Providers de Datos Macro               │
│  FRED / World Bank / BCRA / OECD / IMF          │
└───────────┬──────────────────────────────────────┘
            │
┌───────────▼──────────────────────────────────────┐
│           Exportaciones y Reportes               │
│  CSV, XLSX, JSON, Markdown técnico               │
└──────────────────────────────────────────────────┘
```

### Principios de la nueva arquitectura

1. **La UI no calcula.** El TypeScript en `quantbay/` pasa a ser únicamente interfaz: valida formato, muestra resultados, maneja errores de red. El cálculo real ocurre en Python.
2. **El core no habla HTTP.** `core/` sigue siendo matemática pura; `services/` orquesta; `api/` traduce.
3. **Flask es un proxy delgado.** No hace cálculos. Sirve páginas y delega al motor FastAPI.
4. **Los providers son el único punto de entrada de datos externos.**

---

## 5. Roadmap técnico de limpieza

### Fase 1 — Limpieza visual y navegación (sin tocar código de lógica)

**Objetivo:** cambiar lo que el usuario ve sin romper nada funcional.

- [ ] Reescribir el navbar de `base.html`: dejar solo **Inicio, Econometría, Finanzas Quant, Datos, Documentación**.
- [ ] Mover o reemplazar la ruta `/` (dashboard de tickers) por una landing page centrada en el motor de cálculo.
- [ ] Ocultar del menú: `/community`, `/heatmap`, `/compare`, scanner de señales.
- [ ] Reescribir los textos del `README.md` y la UI principal con la nueva identidad de producto.
- [ ] Eliminar embeds de TradingView de los templates principales.

**Riesgo:** Bajo. Solo CSS, HTML y texto.

---

### Fase 2 — Aislar código heredado (sin borrar)

**Objetivo:** mover las rutas no centrales a un espacio "legacy" claro y documentado.

- [ ] Agrupar en `app.py` las rutas heredadas bajo un comentario `# === LEGACY — pendiente de eliminar ===`.
- [ ] Crear `web/templates/legacy/` y mover: `community.html`, `bot_detail.html`, `bot_new.html`, `heatmap.html`, `compare.html`, `dashboard.html` (versión de mercado).
- [ ] Documentar en `docs/LEGACY_ROUTES.md` qué está desactivado y por qué.
- [ ] No tocar `web/db.py`, `data.py`, `indicators.py` ni `analyze.py` — son compartidos.

**Riesgo:** Medio. Requiere verificar que ningún template activo importe macros o blocks de los templates movidos.

---

### Fase 3 — Consolidar motor de cálculo (migración TS → Python)

**Objetivo:** el calculador web llama al backend FastAPI en lugar de ejecutar TS en el browser.

- [ ] Para cada módulo del laboratorio QuantBay (OLS, RLS, ADF, ACF): cambiar la llamada a `fetch('/api/v1/regression/ols', ...)` en lugar de ejecutar el módulo TypeScript local.
- [ ] Mantener el bundle TypeScript como **fallback educativo** (modo offline / demo sin backend).
- [ ] Añadir manejo de errores HTTP: si el engine está caído, mostrar mensaje claro en lugar de fallar silenciosamente.
- [ ] Verificar que la serialización camelCase de FastAPI sea compatible con lo que espera el frontend TypeScript.

**Riesgo:** Medio-alto. Requiere pruebas de regresión numérica (TS vs Python) para confirmar que los resultados coinciden.

---

### Fase 4 — Construir módulos financieros en `core/finance/`

**Objetivo:** implementar los esqueletos vacíos con matemática real.

Módulos en orden de prioridad:

| Módulo | Ubicación destino | Prioridad |
|--------|------------------|-----------|
| Retornos simples y logarítmicos | `core/finance/returns.py` | Alta |
| Volatilidad histórica, EWMA | `core/finance/volatility.py` | Alta |
| Drawdown máximo | `core/finance/drawdown.py` | Alta |
| Sharpe ratio | `core/finance/portfolio/sharpe.py` | Alta |
| Sortino ratio | `core/finance/portfolio/sortino.py` | Alta |
| Beta vs benchmark | `core/finance/portfolio/beta.py` | Alta |
| CAPM | `core/finance/portfolio/capm.py` | Media |
| VaR (histórico, paramétrico, Monte Carlo) | `core/finance/risk/var.py` | Alta |
| CVaR / Expected Shortfall | `core/finance/risk/cvar.py` | Alta |
| Markowitz (frontera eficiente) | `core/finance/portfolio/markowitz.py` | Media |
| Backtesting de estrategias | `core/finance/backtesting/` | Media |
| Valuación DCF | `core/finance/valuation/dcf.py` | Baja |
| Múltiplos de valoración | `core/finance/valuation/multiples.py` | Baja |

Cada módulo debe seguir el patrón ADR-1: implementación propia validada contra referencia (numpy-financial, scipy, o cálculo manual).

---

### Fase 5 — Producto profesional

**Objetivo:** plataforma estable, documentada y con CI/CD.

- [ ] Migrar base de datos a PostgreSQL (eliminar dependencia de SQLite ephemeral en Render).
- [ ] Configurar CI/CD: GitHub Actions con tests numéricos en cada PR.
- [ ] Documentación API automática (ya disponible en `/docs` via Swagger — publicar URL).
- [ ] Generación de reportes técnicos: resultados de modelos exportables como PDF/Markdown estructurado.
- [ ] Tests de regresión numérica en CI: OLS, RLS, ADF, ACF, cada módulo financiero nuevo.
- [ ] Deploy estable con healthcheck en `/api/v1/health`.

---

## 6. Riesgos de sacar módulos

| Módulo a sacar | Riesgo si se elimina directamente | Mitigación |
|---------------|-----------------------------------|------------|
| **`/` (dashboard de mercado)** | App muestra 404 en la raíz | Reemplazar con landing page antes de eliminar |
| **`web/db.py`** | Rompe login/auth porque también define tabla `users` | Separar `users` de `bots/reviews` primero |
| **`data.py`** | Lo usan `dashboard`, `heatmap`, `compare`, `indicators.py`, `main.py` | No borrar; desactivar solo las rutas que lo consumen |
| **`indicators.py`** | Lo usan `dashboard`, `main.py`, `heatmap` | Ídem anterior |
| **`analyze.py`** | Lo usa el CLI `main.py` además del dashboard | Si se borra, el pipeline CLI queda roto |
| **`community.html` / rutas community** | Enlace en navbar lleva a 404 | Ocultar del navbar primero, luego eliminar |
| **`config.py` (lista de tickers)** | Lo usan `main.py`, `analyze.py`, `data.py` | Solo limpiar el dict de TradingView; no borrar el archivo |
| **Rutas `/api/snapshot`, `/api/lookup`** | Podrían ser consumidas por JS en templates activos | Buscar `fetch('/api/snapshot'` en todos los templates antes de desactivar |
| **`informes/` (directorio de reportes)** | Sin rutas activas que los sirvan, se vuelven huérfanos | Archivar o redirigir si se quiere conservar el histórico |

---

## 7. Recomendación final

### Estrategia: ocultar → mover a legacy → borrar

**No borrar directamente.** El patrón recomendado en tres pasos:

1. **Ocultar de la navegación** (Fase 1): el usuario no ve los módulos, pero el código sigue disponible. Riesgo cero de rotura.

2. **Mover a legacy** (Fase 2): agrupar rutas y templates en un espacio claramente marcado. Permite hacer rollback si algo falla. Riesgo bajo.

3. **Borrar** (post-Fase 3): una vez que el motor está integrado y la UI nueva funciona, se hace un PR de limpieza agresiva con tests pasando en CI.

### Qué borrar eventualmente vs qué conservar

| Módulo | Recomendación |
|--------|--------------|
| `/community`, `/community/new`, `/community/bot/<id>` | **Borrar** en Fase 3 |
| `web/templates/community.html`, `bot_detail.html`, `bot_new.html` | **Borrar** en Fase 3 |
| Tablas `bots` y `reviews` en DB | **Borrar** junto con las rutas |
| `/heatmap`, `/compare` | **Borrar** en Fase 3 |
| `web/templates/heatmap.html`, `compare.html` | **Borrar** en Fase 3 |
| Dashboard de tickers (`dashboard.html`) | **Reescribir** como landing page del motor |
| `analyze.py` | **Mantener** pero desvincular del dashboard; mover al CLI |
| `data.py`, `indicators.py` | **Mantener** — son infraestructura compartida |
| Embeds de TradingView en templates | **Borrar** del HTML directamente |
| `config.py` → dict `TRADINGVIEW` | **Borrar** el dict, mantener el resto |
| `informes/` | **Archivar** o redirigir a sección de reportes del motor |

### Por qué no reescribir desde cero

El motor FastAPI (`backend/chartbay_engine/`) ya está construido, probado y validado. La arquitectura de tres capas es correcta. Los providers de datos funcionan. La UI Flask es sólida. Lo que hay que hacer es limpiar capas encima de una base que ya es buena — no tirar y empezar de nuevo.

---

*Documento generado como auditoría de producto. Ninguna línea de código fue modificada.*
