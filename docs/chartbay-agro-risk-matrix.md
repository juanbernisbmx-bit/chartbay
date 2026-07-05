# ChartBay Agro Risk Matrix

## Escala

- Severidad alta: puede romper confianza, generar conclusion incorrecta grave o
  afectar Econometria.
- Severidad media: puede confundir al usuario o degradar la demo, pero tiene
  recuperacion clara.
- Severidad baja: problema cosmetico, pedagogico o de documentacion.
- Probabilidad alta: esperable en uso frecuente.
- Probabilidad media: posible con datasets reales o demos no preparadas.
- Probabilidad baja: requiere caso borde o configuracion especifica.

## Matriz

| Riesgo | Severidad | Probabilidad | Senal de alerta | Mitigacion |
|---|---:|---:|---|---|
| Colinealidad por demasiadas dummies | Alta | Media | Error de rango, coeficientes inestables, variables categoricas con muchas categorias en pocas filas | Usar presets conservadores, advertir antes de incluir muchas dummies, recomendar variables numericas en demo corta |
| Pocas observaciones | Alta | Alta | `n` bajo, demasiadas X, intervalos amplios o modelo no estimable | Mostrar reglas n/k, bloquear o advertir modelos fragiles, usar datasets demo con tamano suficiente |
| Usuario interpreta correlacion como causalidad | Alta | Alta | Frases como "la lluvia causa exactamente X" o "el modelo recomienda aplicar" | Incluir disclaimers en lectura, usar lenguaje de asociacion, entrenar guion de demo |
| Datos sinteticos confundidos con datos reales | Alta | Media | Usuario cita resultados demo como conclusion productiva real | Etiquetar datasets como sinteticos en UI, docs y resumen exportado |
| CSV con unidades mezcladas | Alta | Media | Columnas combinan kg/ha, qq/ha, tn/ha o precios en monedas distintas | Detectar nombres de unidades, pedir normalizacion previa, documentar unidad esperada |
| Costos mal expresados por ha vs por tonelada | Alta | Media | Margen irreal, flete tratado como costo por ha, alquiler tratado como costo por tonelada | Separar inputs por unidad, mostrar labels explicitos, incluir ejemplo validado en QA |
| Precio en USD/tn vs ARS/tn | Alta | Media | Precio muy alto/bajo, margen explosivo, nombres de columna ambiguos | Requerir moneda en headers o UI, mostrar warning si no hay unidad, no asumir conversion |
| Columnas categoricas parseadas como NaN | Media | Media | Provincia, campana o cultivo aparecen vacios o invalidos | Preservar strings en parser, cubrir con tests y QA de CSV con acentos/categorias |
| Integracion Agro rompe Econometria | Alta | Media | Tests no agro fallan, carga manual cambia, panel Agro aparece fuera de contexto | Mantener integracion aditiva, feature flag, pruebas de regresion manual y automatica |
| Import accidental de Pro/Pyodide en Lite | Alta | Baja | Bundle Lite crece, tests de aislamiento fallan, errores de Pyodide en navegador | Usar tipos estructurales, revisar imports, mantener test de aislamiento Lite/Pro |
| Prometer recomendacion agronomica prescriptiva | Alta | Media | Mensajes como "sembrar", "aplicar", "conviene hacer" sin validacion profesional | Posicionar como laboratorio analitico, usar disclaimers, revisar copy antes de demo |
| Usar datasets publicos sin aclarar fuente/fecha | Media | Media | Dataset real sin metadata, imposibilidad de reproducir o auditar | Exigir fuente, fecha de descarga, licencia, transformaciones y notas de calidad |
| Sobreajuste en datasets demo | Media | Media | R2 perfecto o resultados demasiado limpios | Aclarar naturaleza sintetica, agregar ruido razonable, no vender precision como evidencia |
| Seleccion automatica percibida como caja negra | Media | Media | Usuario no entiende por que se eligio Y/X | Mostrar razones del preset, permitir editar seleccion, documentar criterios |
| Warnings ignorados durante la demo | Media | Alta | Se avanza aunque haya alerta de datos, n/k o unidades | Incluir pausa obligatoria en guion, tratar warnings como parte del valor del producto |
| Export usado como informe final | Media | Media | TXT compartido como recomendacion definitiva | Rotular export como resumen de hipotesis, incluir limites y datos usados |

## Riesgos criticos para una demo comercial

Los riesgos mas sensibles para una demo son:

- confundir datos sinteticos con datos reales;
- sugerir causalidad o recomendacion prescriptiva;
- correr un modelo con pocas observaciones y muchas variables;
- mezclar unidades de precio, rinde o costos;
- romper el flujo de Econometria durante la presentacion.

## Mitigaciones operativas antes de demo

- Usar el flujo recomendado con soja/rinde y variables numericas.
- Evitar dummies categoricas en datasets pequenos.
- Decir explicitamente que la demo usa datos sinteticos.
- Verificar `npm test`, `npx tsc --noEmit` y `npm run build`.
- Tener preparado un CSV externo pequeno para probar carga manual.
- Explicar que ChartBay Agro propone modelos revisables, no decisiones
  automaticas.

## Senales para bloquear release

- Falla la carga manual CSV no agro.
- Falla el build o TypeScript.
- Agro muestra lectura cuando no hay contexto activo.
- Lite importa Pro/Pyodide.
- El simulador de margen produce `NaN`, `Infinity` o resultados sin unidades.
- La UI oculta que un dataset es sintetico.
