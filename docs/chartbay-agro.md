# ChartBay Agro — MVP

> Estado al 5 de julio de 2026. Primera versión funcional del vertical agropecuario.

## Qué es

ChartBay Agro es la **capa vertical agropecuaria** de ChartBay. Toma el motor
econométrico existente de ChartBay Econometría (Lite/Pro/Mega Pro) y le agrega
contexto del sector agro: detección de columnas típicas del agro, presets de
modelos, datasets sintéticos de ejemplo, un simulador de margen bruto e
interpretaciones agropecuarias de resultados de regresión.

## Qué problema resuelve

Un usuario del agro (productor, asesor, estudiante de agronegocios) tiene datos
de campañas — rindes, lluvias, precios, costos — pero no sabe qué modelo
plantear ni cómo leer los coeficientes en términos del negocio. Agro cierra esa
brecha: sugiere el modelo, y traduce el resultado a lenguaje agro, sin
reimplementar una sola línea de econometría.

## Arquitectura

```
core econométrico común (quantbay/src/)        capa vertical Agro
─────────────────────────────────────────      ─────────────────────────────────
regression.ts        (OLS/QR, VIF)        ◄──  agroInterpretation.ts (adapter
functionalForms.ts   (4 formas + lectura  ◄──  fromRegressionResult; reutiliza
                      de coeficientes)         interpretFunctionalCoefficient)
csvParser.ts, statistics.ts, timeseries/,      agroColumnDetection.ts
pro/ (Pyodide), ui/, services/                 agroModelPresets.ts
                                               agroMargin.ts   (puro, sin motor)
                                               agroExamples.ts (datos sintéticos)
                                               agroFeatureFlags.ts
                                               agroView.ts     (panel UI)
```

Regla de dependencias: `verticals/agro` importa del core; **el core nunca
importa de Agro**. El único punto de contacto es `main.ts`, que llama a
`initAgroVertical()` (no-op si el flag está apagado o el panel no existe en el
HTML).

## Qué comparte con ChartBay Econometría

- Motor de regresión (`runOLS` / `runRegressionMode` / Pro Pyodide): Agro no
  tiene `agroOLS` ni nada equivalente.
- Formas funcionales y su interpretación matemática
  (`interpretFunctionalCoefficient` de `functionalForms.ts`).
- Parsing de CSV, validaciones, estadísticas, gráficos y exportación: todo lo
  que ya existe en Econometría sigue siendo el único camino de cálculo.
- Helpers de UI (`$`, `escapeHtml`) y estilos (`qb-*`).

## Módulos propios de Agro (`quantbay/src/verticals/agro/`)

| Módulo | Qué hace |
|---|---|
| `agroTypes.ts` | Tipos del vertical (cultivos, roles de columnas, presets, margen, interpretación, datasets). |
| `agroColumnDetection.ts` | `detectAgroColumns(headers)`: roles agro por columna con aliases ES/EN, tolerancia a acentos/`kg/ha`/`usd/tn`, confianza y warnings. |
| `agroModelPresets.ts` | 4 presets (rinde, precio, margen, producción) y `suggestAgroModelPresets(detection)` con score, razones y roles faltantes. |
| `agroMargin.ts` | Simulador de margen bruto puro: ingreso, costos, margen/ha, rinde y precio de indiferencia, escenarios ±10%. |
| `agroInterpretation.ts` | Interpreta resultados YA calculados por el motor común; lecturas específicas (lluvia→rinde, dólar→precio, Chicago→precio, costo→margen, superficie→producción). |
| `agroExamples.ts` | 3 datasets sintéticos coherentes: `soja_rinde_demo`, `maiz_margen_demo`, `trigo_precio_demo` + serialización a CSV. |
| `agroFeatureFlags.ts` | `CHARTBAY_VERTICALS` — Agro se apaga con un flag sin romper build ni Econometría. |
| `agroView.ts` | Panel UI inicial (selector de dataset, columnas detectadas, presets, simulador de margen). |

## Cómo correr los tests

```bash
cd quantbay
npm test                      # suite completa (incluye tests/agro/)
npx vitest run tests/agro     # sólo el vertical Agro
npx tsc --noEmit              # TypeScript estricto
npm run build                 # bundle → web/static/js/quantbay.bundle.js
```

No existe `npm run lint` en este proyecto (no hay linter configurado).

## Cambios en archivos existentes (justificación)

- `quantbay/src/main.ts`: +2 líneas (import + `initAgroVertical()` al final de
  `init()`). Necesario porque el bundle es una IIFE única: sin ese hook el
  vertical sería inalcanzable. Es no-op con el flag apagado.
- `web/templates/quantbay.html`: una sección nueva `#qb-agro-panel`, **oculta
  por defecto** (`display:none`); sólo la muestra `initAgroVertical()` si el
  flag está activo. Ningún elemento existente fue modificado.
- No se tocó `regression.ts`, `functionalForms.ts`, `timeseries/`, `pro/`,
  Pyodide ni ningún test existente.

## Fuera de alcance por ahora

- Mapas.
- Satélites / NDVI.
- APIs climáticas o de mercado externas.
- Datos reales automáticos (todos los datasets son sintéticos y están marcados como tales).
- Recomendaciones agronómicas prescriptivas (qué sembrar / cuándo aplicar).
- Panel data (efectos fijos por provincia/campaña).
- Machine learning.
- Backend propio de Agro.

## TODOs explícitos

- **Cargar un dataset Agro directamente en el flujo de Econometría** con un
  click (hoy el panel sugiere el modelo y el usuario carga el CSV en el flujo
  normal). Requiere refactorizar `loadDemoCase`/`onFileChange` en `main.ts`
  para aceptar CSV en memoria; se dejó fuera para no tocar el flujo existente.
- Mostrar la interpretación agro (`interpretAgroRegressionResult`) en la UI
  después de una corrida real del motor: el módulo está listo y testeado, la
  conexión visual queda para la iteración siguiente.
- Export del resultado del simulador de margen (Markdown/CSV) reutilizando el
  patrón de `proExportView`.

## Roadmap

1. **v0.2** — dataset Agro → flujo Econometría con un click; interpretación
   agro visible tras cada corrida; export del simulador.
2. **v0.3** — presets con dummies por provincia/campaña (usa el encoding
   categórico existente); forma funcional sugerida aplicada automáticamente.
3. **v0.4** — series de tiempo agro (precios) sobre el panel Pro existente.
4. **Más adelante** — carga de datos reales curados (fuera del navegador, ver
   módulo Datos Frecuentes), y evaluación de un vertical Finanzas con el mismo
   patrón (`CHARTBAY_VERTICALS.finanzas`).
