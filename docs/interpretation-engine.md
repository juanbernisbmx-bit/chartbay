# Motor determinístico de interpretación

## Arquitectura

```text
RegressionResult / PyodideOlsResult / diagnósticos TS
                         ↓ adaptadores
              interpretation/engine.ts
                         ↓
             InterpretationResult tipado
                   ↙             ↘
      ui/interpretationView.ts   modelDoctor/engine.ts
                                        ↓
                              DoctorReport tipado
                                        ↓
                              ui/modelDoctorView.ts
```

El motor es TypeScript puro: no conoce DOM, HTML, Flask, Pyodide ni servicios de
IA. Las vistas conservan visibles los resultados calculados y agregan debajo una
sección identificada como **INTERPRETACIÓN DE CHARTBAY**. El renderer sólo
escapa y presenta el objeto estructurado; no decide ninguna conclusión.

## Contrato

`interpretation/types.ts` define una salida portable con `severity`, `category`,
conclusión breve y estadística, significado práctico, limitaciones, próximos
pasos, supuestos afectados, chequeos recomendados y enlaces a conceptos de la
guía. Estos últimos usan los IDs reales `teoria-*` de `guia.html`, de modo que
la interpretación breve no duplique el desarrollo teórico.

Las salidas también incluyen metadatos estructurados para Model Doctor:
`diagnosticCategory`, `evidence`, `applicability`, `unavailableReason`,
`confidenceHint` e `impactHint`. El agregador no analiza textos ni lee el DOM.

## Model Doctor

`modelDoctor/engine.ts` es una segunda capa pura. Recibe todos los hallazgos de
una corrida y un `ModelContext` con hechos del modelo (motor, n, filas
excluidas, covarianza, forma funcional, columnas descartadas y contexto
temporal). Devuelve un `DoctorReport` con:

- estado cualitativo general, sin score numérico;
- un titular ordenado por consecuencia estadística;
- hallazgos con estado, impacto, evidencia y confianza independientes;
- cobertura explícita y motivos para cada eje no evaluado;
- recomendaciones, límites y vínculos a la teoría.

El pipeline normaliza severidades de manera total, separa los flujos de corte
transversal y series, propaga insuficiencia, aplica las reglas R1–R12, ordena
determinísticamente y recién entonces renderiza. Las vistas no toman decisiones
diagnósticas.

Reglas destacadas:

- BP significativo con covarianza clásica compromete la inferencia (R1); con
  HC1/HC3/HAC se muestra como mitigado, no como resuelto (R2).
- F global significativo, VIF alto y coeficientes individuales imprecisos se
  leen juntos sin recomendar quitar variables mecánicamente (R3).
- un ADF que no rechaza en niveles prioriza el riesgo de regresión espuria; una
  transformación declarada lo marca como mitigado (R4).
- Ljung-Box sobre la serie y sobre residuos ARIMA son categorías distintas (R5).
- columnas descartadas por rango y exclusión masiva de filas tienen prioridad
  propia (R10/R11).
- fechas en el flujo de regresión declaran la autocorrelación como no evaluada,
  nunca como ausente (R12).

Los estados `insufficient` y `not_applicable` son distintos de `ok`. El primero
siempre conserva un motivo y afecta la cobertura. El panel se ubica antes de
los resultados calculados y deja la interpretación individual disponible para
profundizar cada output.

## Alpha y decisiones

- El default es `0.05`; el motor acepta cualquier alpha finito entre 0 y 1 y
  documenta 0.10, 0.05 y 0.01 como niveles soportados por producto.
- La regla es determinística: se rechaza H0 cuando `pValue <= alpha`.
- `p = alpha` se trata explícitamente como rechazo.
- Nunca se dice que H0 fue aceptada o que su probabilidad es `1 - p`.
- ADF puede decidir por valores críticos cuando existe el crítico del alpha
  solicitado; esto preserva el criterio finito de Lite. Si no, usa el p-value.

## Convenciones lingüísticas

1. Usar “se asocia con” salvo que un diseño externo justifique causalidad.
2. “No se rechaza H0” no significa que H0 sea verdadera.
3. Separar significancia estadística de magnitud económica.
4. No convertir R2 en una etiqueta de calidad ni elegir un modelo sólo por R2.
5. Describir VIF 5/10 como heurísticas, nunca como tests formales.
6. ACF/PACF sugieren candidatos; no identifican automáticamente un ARIMA.
7. Los robustos corrigen la covarianza, no variables omitidas ni especificación.
8. Si faltan datos o aparecen NaN/Infinity, declarar información insuficiente.

## Agregar un intérprete

1. Crear un input estructurado en `interpretation/types.ts`.
2. Implementar una función pura `interpretX(input)` en
   `interpretation/engine.ts`.
3. Agregarlo al union `InterpretableResult` y al dispatcher `interpretResult`.
4. Reutilizar IDs existentes de la teoría en `theoryConcepts`.
5. Adaptar el resultado real en `interpretation.ts` o en la vista de series,
   sin parsear strings visibles.
6. Agregar tests de rechazo/no rechazo, alpha, igualdad al borde, faltantes y
   lenguaje pedagógico estable.

## Testing

`tests/interpretation.test.ts` prueba las reglas sin DOM. Los tests de vistas
verifican que los números originales y la interpretación permanezcan separados.
Las frases críticas de decisión funcionan como golden tests pequeños; se evita
snapshotear paneles HTML completos para no congelar markup irrelevante.

`tests/modelDoctor.test.ts` cubre normalización total, determinismo, reglas de
combinación, prioridades, flujos, muestras chicas, datos faltantes, no
convergencia e invariantes. `tests/modelDoctorView.test.ts` verifica cobertura,
los siete bloques del detalle, escape HTML y que la insuficiencia no se presente
como un estado favorable.

No se llama a OpenAI, Anthropic, Gemini ni modelos locales en ningún punto del
flujo. Todas las salidas dependen únicamente de inputs numéricos y reglas
versionadas.
