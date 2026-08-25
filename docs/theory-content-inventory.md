# Inventario de teoria de ChartBay

Este inventario guio la ampliacion de la pestaña **Aprender** de
`web/templates/guia.html`. No define un segundo sistema de contenido: documenta
por que se extendieron los acordeones existentes y que quedo fuera de alcance.

Fuente academica principal: Jeffrey M. Wooldridge, *Introductory Econometrics:
A Modern Approach*, 5th edition (2013). El indice y las secciones citadas se
verificaron en el PDF proporcionado.

| Tema | Teoria anterior | Fuente relevante | Herramienta real | Decision |
| --- | --- | --- | --- | --- |
| Pregunta, datos y modelo econometrico | ✓ Desarrollado | Caps. 1 y 3 | Selector Y/X, muestra listwise, OLS | Flujo empirico, poblacion/muestra, medicion y limites causales |
| OLS, residuos y R2 | ✓ Desarrollado | Caps. 2, 3 y 6 | Lite y Pro | Objetivo SSR, identidades OLS, efecto parcial, ajuste y lectura de residuos |
| Inferencia t, p-value, F e IC | ✓ Desarrollado | Cap. 4 | Lite y Pro; IC en Pro | Error estandar, una/dos colas, tipo I/II, potencia, IC y F conjunto |
| Formas funcionales | △ Las cuatro existian sin exactitud suficiente | Caps. 2.4 y 6.2 | Lin-Lin, Log-Lin, Lin-Log y Log-Log | Agregar tabla de examen, unidades y cambio exacto |
| Dummies, categoria base e interacciones | ✓ Desarrollado | Cap. 7 | Encoding en Lite y Pro | Brecha ajustada, log-dummy e interpretacion de interacciones |
| Restricciones lineales | ✓ Completo para el alcance actual | Cap. 4.5 | RLS Lite y F/Wald Pro | Preservar |
| Multicolinealidad y VIF | △ Dependia de umbrales rigidos | Cap. 3.4 | VIF y reparacion asistida | Agregar formula, matices y limites |
| Heterocedasticidad y Breusch-Pagan | △ Hipotesis presente, pedagogia corta | Cap. 8 | BP Lite/Pro; HC1/HC3 Pro | Completar problema, H0/H1, lectura y siguiente paso |
| Errores robustos HAC | ✗ Faltaba en teoria | Cap. 12.5 | HAC/Newey-West Pro | Incorporar sin modificar el motor |
| Estacionariedad, tendencias y raiz unitaria | ✓ Desarrollado | Caps. 11.1 y 18.2 | Transformaciones y ADF Lite/Pro | Tendencia deterministica/estocastica, diferencias, especificacion y limites |
| ACF, PACF y Ljung-Box | △ Lectura resumida | Caps. 11, 12 y 18 | Lite y Pro | Ampliar autocorrelacion y diagnostico de residuos |
| AR, MA, ARIMA y forecast | ✓ Desarrollado | Cap. 18.5 y contexto de series | ARIMA manual y forecast Pro | Ecuaciones, estabilidad, seleccion, diagnostico y evaluacion fuera de muestra |

Leyenda: **✓** completo para el producto actual; **△** existe pero necesita
mejora; **✗** falta aunque la herramienta correspondiente ya esta disponible.

## Contenido deliberadamente no agregado

- Logit/probit, variables instrumentales, panel y cointegracion: aparecen en el
  libro, pero ChartBay no ofrece hoy un flujo equivalente completo.
- White, Durbin-Watson y otros tests no implementados: no se describen como si
  fueran funciones de ChartBay.
- Auto-ARIMA: se mantiene marcado como roadmap.
- Una LLM en runtime o una base de contenido separada: la teoria sigue siendo
  estatica, versionable y utilizable sin servicios externos.
