# ChartBay Agro QA Checklist

## Uso

Este checklist sirve para QA manual antes de una demo o release del MVP Agro.
Marcar cada item con fecha, navegador, dataset usado y observaciones. Cuando un
resultado dependa de datos sinteticos, dejarlo indicado en la nota de prueba.

## Datos de la sesion

- [ ] Fecha:
- [ ] Tester:
- [ ] Navegador:
- [ ] Build o branch:
- [ ] Feature flag Agro:
- [ ] Dataset demo:
- [ ] CSV externo:

## Carga de datasets

- [ ] Dataset demo carga sin romper la carga manual CSV.
- [ ] Cargar CSV manual despues de usar Agro funciona correctamente.
- [ ] Columnas categoricas se preservan.
- [ ] Columnas numericas se parsean correctamente.
- [ ] Headers con acentos funcionan.
- [ ] Headers con espacios funcionan.
- [ ] Headers con guiones bajos funcionan.
- [ ] `kg/ha` se detecta o se conserva de forma util.
- [ ] `qq/ha` se detecta o se conserva de forma util.
- [ ] `usd/tn` se detecta o se conserva de forma util.
- [ ] Un CSV con columnas no agropecuarias no rompe la pantalla.
- [ ] Un CSV vacio o invalido muestra error comprensible.

## Presets

- [ ] Sugiere modelo de rinde.
- [ ] Sugiere modelo de precio.
- [ ] Sugiere modelo de margen.
- [ ] Sugiere modelo de produccion.
- [ ] No corre modelos automaticamente.
- [ ] Preselecciona Y/X de forma revisable.
- [ ] Muestra razones de sugerencia.
- [ ] Permite cambiar la variable Y antes de correr.
- [ ] Permite quitar o agregar variables X antes de correr.
- [ ] Si faltan columnas clave, el preset no se presenta como certeza.
- [ ] La UI distingue sugerencia de decision del usuario.

## Capacidad n/k

- [ ] Al usar un dataset o preset, la UI muestra un mensaje de capacidad n/k.
- [ ] Con `n <= k + 2`, el mensaje advierte que el modelo es inseguro o limite.
- [ ] Con `n < k * 5`, el mensaje advierte menos de 5 observaciones por regresor.
- [ ] Con X categoricas y menos de 100 observaciones, advierte riesgo por
      dummies.
- [ ] La demo grande muestra margen comodo cuando se seleccionan pocas X.
- [ ] El aviso n/k no reemplaza los errores reales del motor econometrico.

## Datos reales, templates y demo grande

- [ ] La seccion de fuentes reales se muestra sin prometer descarga automatica.
- [ ] El catalogo indica carga manual CSV.
- [ ] Los templates CSV se renderizan y descargan.
- [ ] Template `rinde` dispara preset de rinde.
- [ ] Template `precios` dispara preset de precio.
- [ ] Template `margen` dispara preset de margen.
- [ ] Template `produccion` dispara preset de produccion.
- [ ] Template `clima-agregado` puede disparar preset de rinde si se completa
      `rinde_kg_ha`.
- [ ] Generar demo grande agrega un dataset seleccionable.
- [ ] Demo grande indica 100% sintetico y no usar para decisiones reales.

## Corrida econometrica

- [ ] Lite corre como antes.
- [ ] Pro corre como antes.
- [ ] Agro solo agrega lectura si hay contexto agro activo.
- [ ] Si la Y corrida no coincide con el preset activo, no muestra lectura agro
      incorrecta.
- [ ] `clearAgroContext` funciona al cargar un CSV externo.
- [ ] `clearAgroContext` funciona al cargar un demo no agro.
- [ ] Errores de rango, NaN o columnas invalidas se muestran sin romper la UI.
- [ ] Los resultados econometricos generales siguen visibles.
- [ ] La lectura agro aparece como complemento, no como reemplazo.
- [ ] No hay promesas de causalidad automatica.

## Simulador de margen

- [ ] Calcula ingreso.
- [ ] Calcula costos.
- [ ] Calcula margen.
- [ ] Calcula margen por hectarea.
- [ ] Calcula rinde de indiferencia.
- [ ] Calcula precio de indiferencia.
- [ ] Escenario pesimista funciona.
- [ ] Escenario base funciona.
- [ ] Escenario optimista funciona.
- [ ] Cambiar precio actualiza resultados.
- [ ] Cambiar rinde actualiza resultados.
- [ ] Cambiar hectareas actualiza resultados.
- [ ] `kg/ha` funciona.
- [ ] `qq/ha` funciona.
- [ ] `tn/ha` funciona.
- [ ] Costos por hectarea y flete por tonelada no se mezclan silenciosamente.
- [ ] Inputs negativos se rechazan o muestran warning claro.
- [ ] Copiar resumen funciona.
- [ ] Export TXT funciona.
- [ ] El resumen exportado incluye inputs, resultados, escenarios y puntos de
      indiferencia.

## Aislamiento

- [ ] Apagar feature flag de Agro no rompe build.
- [ ] Econometria funciona sin Agro.
- [ ] Lite no importa Pyodide/Pro.
- [ ] No hay dependencias nuevas innecesarias.
- [ ] `regression.ts` no fue modificado por Agro.
- [ ] `functionalForms.ts` no fue modificado por Agro.
- [ ] El flujo de carga CSV existente sigue funcionando.
- [ ] Los demos existentes de Econometria siguen funcionando.
- [ ] Tests no agro siguen pasando.

## UX

- [ ] Usuario entiende que hacer primero.
- [ ] Los warnings son pedagogicos.
- [ ] No parece que el sistema decide por el usuario.
- [ ] No promete causalidad donde solo hay correlacion.
- [ ] Se aclara cuando un dataset es sintetico.
- [ ] Se distingue demo chica, demo grande y CSV real cargado por el usuario.
- [ ] El texto diferencia analisis exploratorio de recomendacion prescriptiva.
- [ ] Los botones principales tienen resultado visible.
- [ ] Los estados de error son recuperables.
- [ ] La demo puede explicarse sin abrir herramientas de desarrollo.

## Regresion sobre ChartBay Econometria

- [ ] Carga manual CSV no agro.
- [ ] Seleccion manual Y/X.
- [ ] Corrida Lite con dataset historico.
- [ ] Corrida Pro si esta disponible.
- [ ] Exportaciones existentes siguen funcionando.
- [ ] No aparecen paneles Agro cuando no corresponde.

## Quality gates

- [ ] `npm test`
- [ ] `npx tsc --noEmit`
- [ ] `npm run build`
- [ ] `npm run lint` si existe script configurado.

## Resultado de QA

- [ ] Aprobado para demo.
- [ ] Aprobado con observaciones.
- [ ] Bloqueado.

Notas:

- Hallazgos criticos:
- Hallazgos menores:
- Riesgos para demo:
- Recomendaciones:
