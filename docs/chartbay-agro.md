# ChartBay Agro — MVP

> Estado al 5 de julio de 2026. Vertical agropecuario conectado al flujo de Econometría.

## Qué es

ChartBay Agro es la **capa vertical agropecuaria** de ChartBay. Toma el motor
econométrico existente de ChartBay Econometría (Lite/Pro/Mega Pro) y le agrega
contexto del sector agro: detección de columnas típicas del agro, presets de
modelos, datasets sintéticos de ejemplo, un simulador de margen bruto e
interpretaciones agropecuarias de resultados de regresión — conectado de punta
a punta con el flujo real de carga de CSV y ejecución de modelos.

## Qué problema resuelve

Un usuario del agro (productor, asesor, estudiante de agronegocios) tiene datos
de campañas — rindes, lluvias, precios, costos — pero no sabe qué modelo
plantear ni cómo leer los coeficientes en términos del negocio. Agro cierra esa
brecha: sugiere el modelo, carga los datos en un click, y traduce el resultado
a lenguaje agro, sin reimplementar una sola línea de econometría.

## Flujo MVP actual

1. El usuario entra a **ChartBay Agro** (panel al final de `/econometria`) y
   elige un dataset sintético en el desplegable.
2. Ve las **columnas detectadas** (rol agro + confianza) y los **presets
   sugeridos** (rinde / precio / margen / producción) con la razón de cada uno.
3. Con un click en **"Usar en Econometría"** carga el CSV del dataset en el
   flujo real (mismo camino que subir un archivo a mano) y preselecciona Y/X
   según el preset por defecto del dataset.
4. Alternativamente, cada preset sugerido tiene su propio botón **"Usar este
   preset"**: carga el dataset (si hace falta) y preselecciona ESE preset en
   particular — útil cuando un dataset admite más de un modelo.
5. El usuario **revisa la selección de variables** (nunca se corre solo) y
   hace click en "Calcular regresión" como en cualquier corrida de Econometría.
6. Si la Y corrida coincide con la del preset agro elegido, aparece un panel
   adicional **"Lectura agropecuaria del modelo"** — debajo de la
   interpretación econométrica general, nunca en su lugar — con resumen
   ejecutivo, lectura de coeficientes, lectura agro específica, advertencias y
   limitaciones. Funciona tanto con el motor Lite (TypeScript) como con Pro
   (Pyodide/statsmodels).
7. El **simulador de margen bruto** (mismo panel) calcula ingreso, costos,
   margen, puntos de indiferencia y escenarios ±10%, con botones para
   **copiar el resumen** al portapapeles o **exportarlo como TXT**.

## Cómo usar los datasets demo

Los 3 datasets (`soja_rinde_demo`, `maiz_margen_demo`, `trigo_precio_demo`) son
100% sintéticos — se indica explícitamente en la UI y en el nombre del campo
`synthetic: true`. Sirven para explorar el flujo, no para decisiones reales.

## Cómo se conecta Agro con Econometría

Agro **no reimplementa** la carga de CSV ni el render de variables: reutiliza
el mismo camino que usa una carga manual. El puente es un contrato mínimo
(`AgroEconometriaBridge`, definido en `agroView.ts`) que `main.ts` implementa
reusando su propia orquestación privada (parseo, `renderPreview`,
`renderVarSelectors`, `setVariableSelection`, etc.) — Agro nunca importa
`main.ts` (evita un ciclo, ya que `main.ts` importa el vertical). El único
parser nuevo es `parseCSVText` en `csvParser.ts` (core), que Agro necesitaba
porque el parser de demos existente en `main.ts` no preserva strings en
columnas categóricas (provincia, campaña) — ver justificación abajo.

Tras una corrida exitosa, `main.ts` llama a `presentAgroInterpretationForRegression`
(motor Lite) o `presentAgroInterpretationForPro` (motor Pro) con el resultado
real; estas funciones sólo actúan si hay un contexto agro activo **y** la Y de
la corrida coincide con la del preset elegido — si no, no muestran nada
(nunca interfieren con una regresión no relacionada con Agro).

## Qué comparte con ChartBay Econometría

- Motor de regresión (`runOLS` / `runRegressionMode` / Pro Pyodide): Agro no
  tiene `agroOLS` ni nada equivalente.
- Formas funcionales y su interpretación matemática
  (`interpretFunctionalCoefficient` de `functionalForms.ts`).
- Parsing de CSV, validaciones, estadísticas, gráficos y exportación: todo lo
  que ya existe en Econometría sigue siendo el único camino de cálculo.
- Helpers de UI (`$`, `escapeHtml`) y exportación de archivos
  (`downloadTextFile` de `ui/exports.ts`).

## Módulos propios de Agro (`quantbay/src/verticals/agro/`)

| Módulo | Qué hace |
|---|---|
| `agroTypes.ts` | Tipos del vertical (cultivos, roles de columnas, presets, margen, interpretación, datasets). |
| `agroColumnDetection.ts` | `detectAgroColumns(headers)`: roles agro por columna con aliases ES/EN, tolerancia a acentos/`kg/ha`/`usd/tn`, confianza y warnings. |
| `agroModelPresets.ts` | 4 presets (rinde, precio, margen, producción) y `suggestAgroModelPresets(detection)` con score, razones y roles faltantes. |
| `agroMargin.ts` | Simulador de margen bruto puro: ingreso, costos, margen/ha, rinde y precio de indiferencia, escenarios ±10%, y `formatAgroMarginSummary` para copiar/exportar. |
| `agroInterpretation.ts` | Interpreta resultados YA calculados por el motor común (Lite y Pro); lecturas específicas (lluvia→rinde, dólar→precio, Chicago→precio, costo→margen, superficie→producción). Incluye `AgroPyodideResultLike`, un tipo estructural que evita importar `pro/` (ver justificación abajo). |
| `agroExamples.ts` | 3 datasets sintéticos coherentes: `soja_rinde_demo`, `maiz_margen_demo`, `trigo_precio_demo` + serialización a CSV. |
| `agroFeatureFlags.ts` | `CHARTBAY_VERTICALS` — Agro se apaga con un flag sin romper build ni Econometría. |
| `agroView.ts` | Panel UI completo: selector de dataset, columnas detectadas, presets con botón "Usar este preset", bridge hacia Econometría, paneles de interpretación agro y simulador de margen con export. |

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

- `quantbay/src/csvParser.ts`: **agrega** `parseCSVText(text)`, un parser de
  CSV en memoria (con soporte de comillas/escapes) que preserva strings en
  columnas no numéricas. Es necesario porque el parser de demos privado de
  `main.ts` (`parseDemoCsv`) convierte TODO con `Number(...)`, perdiendo el
  valor de columnas categóricas como "provincia" o "campaña" (las vuelve
  `NaN`) — aceptable para los demos numéricos existentes de Econometría, pero
  no para datasets agro que sí tienen columnas de texto. No se tocó
  `parseDemoCsv` ni ningún demo existente.
- `quantbay/src/main.ts`: +import, +`agroLoadDataset()` (la implementación del
  bridge, reutilizando la misma orquestación privada de `onFileChange`),
  +2 llamadas a `clearAgroContext()` (en `onFileChange` y `loadDemoCase`, para
  invalidar un contexto agro obsoleto cuando el usuario carga otra cosa),
  +2 llamadas a `presentAgroInterpretationForRegression`/`presentAgroInterpretationForPro`
  tras una corrida exitosa (Lite/Pro), +`hideAgroInterpretationPanels()` en los
  paths de error. Todo aditivo: ningún comportamiento ni mensaje existente
  cambió, y el vertical es no-op con el flag apagado.
- `web/templates/quantbay.html`: 3 bloques nuevos y aditivos — botón "Usar en
  Econometría" + status en el panel Agro, paneles de interpretación agro
  (ocultos por defecto) dentro de `#qb-results` y `#qb-pro-results`, y botones
  de copiar/exportar en el simulador de margen. Ningún elemento existente fue
  modificado.
- **No se tocó** `regression.ts`, `functionalForms.ts`, `timeseries/`, ningún
  archivo bajo `pro/`, ni ningún test existente. `agroInterpretation.ts`
  necesita leer la forma de `PyodideOlsResult` (motor Pro) pero **no la
  importa**: define un tipo estructuralmente equivalente
  (`AgroPyodideResultLike`) para no violar el invariante verificado por
  `tests/pro/liteIsolation.test.ts` (el motor Lite no puede depender de
  Pyodide/Pro). TypeScript acepta un `PyodideOlsResult` real donde se espera
  ese tipo por tipado estructural, sin crear la dependencia de módulo.

## Fuera de alcance por ahora

- Mapas.
- Satélites / NDVI.
- APIs climáticas o de mercado externas.
- Datos reales automáticos (todos los datasets son sintéticos y están marcados como tales).
- Recomendaciones agronómicas prescriptivas (qué sembrar / cuándo aplicar).
- Panel data (efectos fijos por provincia/campaña).
- Machine learning.
- Backend propio de Agro.
- Export del simulador de margen en PDF/Markdown (hoy sólo TXT/portapapeles).

## TODOs explícitos

- La preselección de columnas categóricas (provincia, campaña) como X puede
  generar modelos con multicolinealidad severa si el dataset tiene pocas
  observaciones y muchas dummies (ej. 16 filas × provincia + campaña). El
  flujo ya avisa con el error de rango habitual de Econometría y no corre
  solo, pero un preset más conservador (o un aviso previo específico de Agro)
  mejoraría la experiencia — queda para la próxima iteración.
- Export del resumen del simulador de margen en Markdown/PDF, reutilizando el
  patrón de `proExportView`, si se justifica la demanda.
- Mostrar el `score`/razón del preset activo de forma persistente en el panel
  de resultados (hoy sólo aparece como mensaje de estado al aplicar el preset).

## Roadmap

1. **v0.3** — presets con dummies por provincia/campaña más robustos frente a
   colinealidad; forma funcional sugerida aplicada automáticamente al elegir
   un preset.
2. **v0.4** — series de tiempo agro (precios) sobre el panel Pro existente.
3. **Más adelante** — carga de datos reales curados (fuera del navegador, ver
   módulo Datos Frecuentes), y evaluación de un vertical Finanzas con el mismo
   patrón (`CHARTBAY_VERTICALS.finanzas`).
