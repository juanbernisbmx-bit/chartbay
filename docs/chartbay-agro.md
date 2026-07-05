# ChartBay Agro — MVP

> Estado al 5 de julio de 2026. Vertical agropecuario conectado al flujo de
> Econometría, con soporte para datasets grandes y una capa de preparación
> para datos reales (sin APIs todavía).

## Qué es

ChartBay Agro es la **capa vertical agropecuaria** de ChartBay. Toma el motor
econométrico existente de ChartBay Econometría (Lite/Pro/Mega Pro) y le agrega
contexto del sector agro: detección de columnas típicas del agro, presets de
modelos, datasets sintéticos (chicos y grandes), un simulador de margen bruto,
interpretaciones agropecuarias de resultados de regresión, y una capa de
preparación para cargar datos reales — conectado de punta a punta con el flujo
real de carga de CSV y ejecución de modelos.

## Qué problema resuelve

Un usuario del agro (productor, asesor, estudiante de agronegocios) tiene datos
de campañas — rindes, lluvias, precios, costos — pero no sabe qué modelo
plantear, si sus datos alcanzan para ese modelo, ni cómo leer los coeficientes
en términos del negocio. Agro cierra esa brecha: sugiere el modelo, avisa si el
tamaño de la muestra es riesgoso, carga los datos en un click, y traduce el
resultado a lenguaje agro, sin reimplementar una sola línea de econometría.

## Flujo MVP actual

1. El usuario entra a **ChartBay Agro** (panel al final de `/econometria`) y
   elige un dataset sintético en el desplegable, o genera uno grande con
   **"Generar demo grande"** (ver más abajo).
2. Ve las **columnas detectadas** (rol agro + confianza) y los **presets
   sugeridos** (rinde / precio / margen / producción) con la razón de cada uno.
3. Con un click en **"Usar en Econometría"** carga el CSV del dataset en el
   flujo real (mismo camino que subir un archivo a mano) y preselecciona Y/X
   según el preset por defecto del dataset. El mensaje de estado incluye un
   **aviso de capacidad n/k** (ver más abajo) si la combinación de
   observaciones y variables elegidas es riesgosa.
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
8. Más abajo, la sección **"Cargar datos reales"** muestra el catálogo de
   fuentes públicas recomendadas y templates CSV descargables (ver más abajo).

## Datasets reales y de gran escala

### Demo chica vs. demo grande vs. datos reales

| | Demo chica | Demo grande | Datos reales |
|---|---|---|---|
| Filas | 12–30 | ~1000 por defecto (configurable) | Depende de la fuente |
| Generación | Fija, escrita a mano (`agroExamples.ts`) | `generateLargeAgroSyntheticDataset()`, PRNG determinista | Exportadas por el usuario desde una fuente real |
| Uso | Explorar el flujo rápido, entender un preset | Probar el flujo con volumen realista, ver cómo cambia el aviso de capacidad n/k | Análisis real — fuera del alcance actual de este vertical (ChartBay Agro no descarga nada; el usuario sube el CSV) |
| `synthetic` | `true` | `true` | — (dato real, no generado por Agro) |

**Ambas demos (chica y grande) son 100% sintéticas.** Ninguna debe usarse para
decisiones productivas o comerciales — la UI y la descripción de cada dataset
lo aclaran explícitamente.

### Cómo generar más observaciones

Hacé click en **"Generar demo grande"** en el panel Agro. Por defecto genera
`20 campañas × 5 provincias × 10 departamentos = 1000 filas` para soja, con
`generateLargeAgroSyntheticDataset()` (`agroExamples.ts`). Mantiene
`produccion_tn = rinde_kg_ha × superficie_cosechada_ha / 1000` en cada fila y
usa un PRNG determinista (mulberry32, sin dependencias nuevas): la misma
`seed` siempre genera el mismo dataset. Programáticamente aceptás más
opciones (cultivo, cantidad de campañas/provincias/departamentos, qué columnas
incluir, seed) — ver `AgroLargeSyntheticDatasetOptions` en `agroTypes.ts`; la
UI sólo expone el caso por defecto.

### Fuentes públicas recomendadas

Catálogo en `agroDataCatalog.ts` (`AGRO_DATA_CATALOG`), visible en la sección
"Cargar datos reales" del panel:

| Fuente | Organismo | Granularidad | Sirve para |
|---|---|---|---|
| Estimaciones Agrícolas Argentina | MAGyP / Secretaría de Agricultura | cultivo × campaña × provincia × departamento | Rinde, producción |
| Precios FOB Granos Argentina | MAGyP | producto × fecha | Precio, series de tiempo |
| FAOSTAT | FAO | país × año × producto | Comparación internacional |

Ninguna se descarga automáticamente: **ChartBay Agro no tiene integración con
APIs todavía**. El usuario exporta el recorte que necesita como CSV desde el
sitio del organismo y lo carga a mano en Econometría (`getAgroDataSourcesByModelType(modelType)`
ayuda a elegir la fuente según el tipo de modelo).

### Formatos CSV recomendados

Templates en `agroCsvTemplates.ts` (`AGRO_CSV_TEMPLATES`), descargables desde
el panel ("Descargar template CSV"):

| Template | Columnas requeridas | Modelo |
|---|---|---|
| `rinde` | campaña, provincia, rinde_kg_ha | Rinde |
| `clima-agregado` | zona, campaña, lluvia_total_mm, temperatura_media | Insumo del modelo de rinde |
| `precios` | fecha, precio_local_usd_tn | Precio |
| `margen` | lote, campaña, rinde_kg_ha, precio_usd_tn, costo_usd_ha | Margen |
| `producción` | cultivo, campaña, provincia, superficie_sembrada_ha, produccion_tn | Producción |

Cada template también documenta columnas opcionales y trae 2 filas de
ejemplo — es un punto de partida para armar el CSV propio, no datos reales.

### Reglas n/k: cuándo un modelo es seguro

`assessAgroModelCapacity(rowCount, selectedXCount, categoricalXCount)`
(`agroModelCapacity.ts`) da un veredicto `safe` / `warning` / `unsafe` **antes**
de correr el modelo:

- **unsafe**: `n <= k + 2` (al borde o por debajo del mínimo matemático para estimar).
- **warning**: `n < k * 5` (menos de 5 observaciones por regresor, regla práctica habitual).
- **warning adicional**: hay variables categóricas entre las X y `n < 100`
  (cada categoría agrega una dummy; con pocas filas eso es especialmente riesgoso).
- **safe**: ninguna de las anteriores.

Está integrado en el mensaje de estado que se muestra al usar un dataset o
preset (columna "Revisá la selección..." en el panel Agro) — es la ADVERTENCIA
que hubiera evitado confusión en el demo chico de soja (16 filas + provincia +
campaña como X generan un modelo con colinealidad severa; el motor lo rechaza
igual, pero ahora el usuario lo sabe antes de intentarlo). **No reemplaza** los
chequeos de rango de `regression.ts`: esos siguen siendo la única fuente de
verdad ante un problema numérico real.

### Límites por versión (Lite / Pro / Mega Pro)

Estos límites son de **ChartBay Econometría**, no específicos de Agro — Agro
carga datos por el mismo camino, así que hereda las mismas reglas
(`versioning/chartbayVersions.ts`):

| Versión | Motor | Límite de CSV |
|---|---|---|
| Lite | TypeScript en el navegador | 2 MB |
| Pro | Pyodide/statsmodels en el navegador | 10 MB |
| Mega Pro | Servidor Python (en preparación) | 50 MB |

Un dataset grande de Agro (1000 filas × ~10 columnas) pesa bien por debajo de
2 MB, así que corre sin problema incluso en Lite. Para volúmenes mucho mayores
(decenas de miles de filas), conviene Pro o esperar a Mega Pro.

### Advertencia sobre datos sintéticos

**Todos** los datasets que genera o incluye ChartBay Agro —chicos y
grandes— son sintéticos (`synthetic: true`), generados con fines
pedagógicos y de prueba. No provienen de ninguna fuente real, no deben
citarse como si lo fueran, y no deben usarse para decisiones productivas,
comerciales o de política agropecuaria.

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
- Límites de tamaño de CSV por versión (Lite/Pro/Mega Pro).

## Módulos propios de Agro (`quantbay/src/verticals/agro/`)

| Módulo | Qué hace |
|---|---|
| `agroTypes.ts` | Tipos del vertical (cultivos, roles, presets, margen, interpretación, datasets, catálogo, templates, capacidad n/k). |
| `agroColumnDetection.ts` | `detectAgroColumns(headers)`: roles agro por columna con aliases ES/EN (incluye `fecha`/`date`), tolerancia a acentos/`kg/ha`/`usd/tn`, confianza y warnings. |
| `agroModelPresets.ts` | 4 presets (rinde, precio, margen, producción) y `suggestAgroModelPresets(detection)` con score, razones y roles faltantes. |
| `agroMargin.ts` | Simulador de margen bruto puro: ingreso, costos, margen/ha, rinde y precio de indiferencia, escenarios ±10%, y `formatAgroMarginSummary` para copiar/exportar. |
| `agroInterpretation.ts` | Interpreta resultados YA calculados por el motor común (Lite y Pro); lecturas específicas (lluvia→rinde, dólar→precio, Chicago→precio, costo→margen, superficie→producción). Incluye `AgroPyodideResultLike`, un tipo estructural que evita importar `pro/` (ver justificación abajo). |
| `agroExamples.ts` | 3 datasets sintéticos chicos + `generateLargeAgroSyntheticDataset()` (dataset grande, PRNG determinista) + `rowsToCsv`/`csvEscape`/`agroDatasetToCsv`. |
| `agroDataCatalog.ts` | Catálogo de fuentes reales de referencia (`AGRO_DATA_CATALOG`), sólo informativo — sin URLs ni fetch. |
| `agroCsvTemplates.ts` | 5 templates de CSV recomendados (`AGRO_CSV_TEMPLATES`) con columnas requeridas/opcionales, ejemplo de filas y export a CSV. |
| `agroModelCapacity.ts` | `assessAgroModelCapacity(n, k, categóricas)`: reglas n/k para avisar si un modelo es seguro antes de correrlo. |
| `agroFeatureFlags.ts` | `CHARTBAY_VERTICALS` — Agro se apaga con un flag sin romper build ni Econometría. |
| `agroView.ts` | Panel UI completo: selector de dataset (fijo o generado), columnas detectadas, presets con botón "Usar este preset", bridge hacia Econometría, aviso de capacidad n/k, paneles de interpretación agro, simulador de margen con export, y sección de datos reales. |

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
- `quantbay/src/verticals/agro/agroColumnDetection.ts`: agrega los alias
  `fecha`/`date` al rol `season` (las series de precios reales suelen traer
  una columna de fecha en vez de campaña). Aditivo, no cambia ninguna
  detección existente.
- `quantbay/src/main.ts`: +import, +`agroLoadDataset()` (la implementación del
  bridge, reutilizando la misma orquestación privada de `onFileChange`),
  +2 llamadas a `clearAgroContext()` (en `onFileChange` y `loadDemoCase`, para
  invalidar un contexto agro obsoleto cuando el usuario carga otra cosa),
  +2 llamadas a `presentAgroInterpretationForRegression`/`presentAgroInterpretationForPro`
  tras una corrida exitosa (Lite/Pro), +`hideAgroInterpretationPanels()` en los
  paths de error. Todo aditivo: ningún comportamiento ni mensaje existente
  cambió, y el vertical es no-op con el flag apagado.
- `web/templates/quantbay.html`: bloques nuevos y aditivos — botón "Usar en
  Econometría" + "Generar demo grande" + status en el panel Agro, sección
  "Cargar datos reales" (fuentes + templates), paneles de interpretación agro
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
- APIs climáticas o de mercado externas (el catálogo de fuentes es sólo
  referencia; no hay integración ni descarga automática).
- Carga automática de datos reales (siempre manual, vía CSV exportado por el usuario).
- Recomendaciones agronómicas prescriptivas (qué sembrar / cuándo aplicar).
- Panel data (efectos fijos por provincia/campaña).
- Machine learning.
- Backend propio de Agro.
- Export del simulador de margen en PDF/Markdown (hoy sólo TXT/portapapeles).

## TODOs explícitos

- La preselección automática de columnas categóricas (provincia, campaña)
  como X puede seguir siendo riesgosa con datasets muy chicos; el aviso de
  capacidad n/k ya lo señala, pero un preset que agrupe categorías poco
  frecuentes automáticamente sería una mejora futura.
- Export del resumen del simulador de margen en Markdown/PDF, reutilizando el
  patrón de `proExportView`, si se justifica la demanda.
- Mostrar el `score`/razón del preset activo de forma persistente en el panel
  de resultados (hoy sólo aparece como mensaje de estado al aplicar el preset).
- El generador de dataset grande sólo expone sus opciones por defecto en la
  UI (botón único); exponer un formulario con cultivo/campañas/provincias
  configurables sería el siguiente paso natural.

## Roadmap

1. **v0.3** — formulario de opciones para el generador de dataset grande;
   forma funcional sugerida aplicada automáticamente al elegir un preset.
2. **v0.4** — series de tiempo agro (precios) sobre el panel Pro existente.
3. **Más adelante** — integración real con alguna de las fuentes del
   catálogo (requiere decisión explícita sobre APIs, hoy fuera de alcance), y
   evaluación de un vertical Finanzas con el mismo patrón
   (`CHARTBAY_VERTICALS.finanzas`).
