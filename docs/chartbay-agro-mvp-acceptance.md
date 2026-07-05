# ChartBay Agro MVP Acceptance

## Definicion de listo

ChartBay Agro MVP esta listo cuando puede demostrarse de punta a punta sin
romper ChartBay Econometria, sin depender de backend nuevo y sin prometer mas
de lo que el producto valida. El MVP debe permitir cargar un dataset agro,
detectar columnas, sugerir un preset, correr un modelo, leer una interpretacion
agropecuaria, simular margen y exportar un resumen.

## MVP tecnico

- [ ] `npm test` pasa.
- [ ] `npx tsc --noEmit` pasa.
- [ ] `npm run build` pasa.
- [ ] No hay dependencias nuevas.
- [ ] Feature flag de Agro funciona.
- [ ] Apagar Agro no rompe build.
- [ ] Lite/Pro estan aislados.
- [ ] Lite no importa Pyodide/Pro.
- [ ] Reglas n/k estan testeadas y visibles antes de correr el modelo.
- [ ] No hay regresiones en Econometria.
- [ ] Carga manual CSV sigue funcionando.
- [ ] Demos existentes de Econometria siguen funcionando.
- [ ] No se modifican `regression.ts` ni `functionalForms.ts` para habilitar
      Agro.
- [ ] Errores de datos invalidos se muestran sin romper la app.
- [ ] Tests Agro cubren deteccion, presets, templates, catalogo, demo grande,
      reglas n/k, margen, interpretacion, feature flag y vista.

## MVP producto

- [ ] Usuario puede cargar dataset agro.
- [ ] Sistema detecta columnas relevantes.
- [ ] Sistema sugiere preset.
- [ ] Preset muestra razones de sugerencia.
- [ ] Usuario ve aviso de capacidad n/k antes de correr.
- [ ] Usuario puede revisar Y/X antes de correr.
- [ ] Usuario puede correr modelo.
- [ ] Aparece lectura agropecuaria cuando corresponde.
- [ ] No aparece lectura agropecuaria cuando no corresponde.
- [ ] Simulador de margen funciona.
- [ ] Simulador calcula ingreso, costos, margen y margen por hectarea.
- [ ] Simulador calcula rinde de indiferencia.
- [ ] Simulador calcula precio de indiferencia.
- [ ] Escenarios pesimista/base/optimista funcionan.
- [ ] Export de resumen funciona.
- [ ] Usuario puede generar demo grande sintetica.
- [ ] Usuario puede ver catalogo de fuentes reales de referencia.
- [ ] Usuario puede descargar templates CSV.
- [ ] El producto aclara limites de correlacion, causalidad y datos sinteticos.

## MVP demo para agronomo

- [ ] Se entiende el problema.
- [ ] Se entiende el flujo.
- [ ] Los resultados son interpretables.
- [ ] Se aclaran limites.
- [ ] Se entiende la diferencia entre demo sintetica chica, demo sintetica
      grande y CSV real cargado manualmente.
- [ ] No se promete prediccion perfecta.
- [ ] No se promete recomendacion agronomica prescriptiva.
- [ ] Se diferencia de Excel.
- [ ] Se diferencia de AgTech operativa.
- [ ] El profesional puede discutir supuestos y no solo mirar un resultado.
- [ ] La demo puede completarse en menos de 10 minutos.

## Criterios de bloqueo

El MVP no debe aceptarse si ocurre cualquiera de estos puntos:

- falla `npm test`, `npx tsc --noEmit` o `npm run build`;
- Agro rompe carga CSV manual;
- Agro muestra interpretacion cuando la corrida no coincide con el contexto;
- Lite depende de Pro/Pyodide;
- el simulador devuelve `NaN`, `Infinity` o margenes sin unidad clara;
- datos sinteticos se presentan como datos reales;
- datos reales se presentan como integracion automatica cuando solo hay carga
  manual CSV;
- no se muestra aviso n/k al aplicar un dataset/preset;
- la UI sugiere causalidad o recomendacion prescriptiva;
- se agregan dependencias no justificadas;
- se modifican flujos centrales de Econometria sin necesidad.

## Evidencia minima de aceptacion

Para dar por aceptado el MVP, adjuntar o registrar:

- comandos ejecutados y resultado;
- dataset demo usado;
- captura o nota del modelo corrido;
- resumen exportado del simulador;
- checklist QA manual con observaciones;
- riesgos abiertos y mitigacion propuesta.

## Release interno

Estado sugerido cuando cumple los criterios:

> MVP aceptado para demo controlada con datos sinteticos y usuarios informados
> sobre limites del analisis.

Estado sugerido cuando faltan datos reales:

> MVP funcional para demo sintetica. Pendiente validacion con fuentes reales,
> metadata de origen y reglas n/k para uso externo.
