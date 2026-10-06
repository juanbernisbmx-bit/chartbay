# Base de datos: actualización automática con revisión

Estado: diseño, con casi todo implementado. En `servicio_datos/`: esquema PostgreSQL y migrador,
colector, orquestador, publicación de candidatos, lectura desde ChartBay, y la interfaz de revisión con su cola
(pasos 1, 2, 4 y 5); el parser y la validación (paso 3) los entregó Codex y están integrados. Sigue en diseño el agente.

Complementa a `docs/base-datos.md`, que describe el piloto local y lista como
pendientes PostgreSQL, la recolección programada, el historial de revisiones y la
aprobación humana. Este documento define cómo se resuelven, empezando por el IPC.

## Objetivo

Que la base de ChartBay se actualice sola desde las fuentes oficiales y que un
agente detecte y proponga correcciones, sin que ningún cambio llegue a los datos
publicados sin aprobación humana.

## Principios

- El agente propone; no escribe en los datos publicados.
- El archivo descargado nunca se edita. Toda corrección es un registro aparte con
  su evidencia.
- Los faltantes siguen siendo faltantes, nunca ceros. El agente tampoco inventa
  ni rellena valores.
- Si el formato de la fuente cambia, el colector falla y avisa. No adivina.
- La automatización se gana con datos: una categoría de cambio pasa a automática
  solo después de que se aprobó sin modificaciones varias veces.

## Tres capas de datos

1. Crudo: lo que bajó el colector, con hash, URL y fecha. Inmutable.
2. Candidato: observaciones nuevas más las propuestas del agente. No se publica.
3. Publicado: lo que lee ChartBay. Solo se alimenta de candidatos aprobados.

## Flujo del IPC

```
Disparador -> Colector -> Crudo -> Parser -> Validación -> Candidato -> Revisión -> Publicado -> API
 (cron)      (XLS INDEC)  (hash)   (obs.)    (reglas)                    (humana)   (release_id)
                 |                     |           |
                 v                     v           v
              Alerta               Alerta       Agente -> Propuestas -> Revisión
           (si falla)           (si falla)   (hallazgos)
```

1. Disparador. Cron diario dentro de la ventana de publicación del mes. Se
   detiene cuando aparece el dato nuevo. Fuera de la ventana no hace nada.
2. Colector. El archivo nacional cambia de nombre cada mes (`sh_ipc_08_26.xls`,
   con el mes y el año de publicación), así que prueba el mes en curso y los dos
   anteriores, del más nuevo al más viejo, y se queda con el primero que sea de
   verdad un `.xls`. El de aperturas tiene
   nombre fijo (`sh_ipc_aperturas.xls`): se vuelve a bajar y se compara el hash.
   Si el archivo del mes todavía no existe, no es un error; un error de red sí
   lo es, y no cae al mes anterior (ocultaría una publicación nueva).
3. Crudo. Se guarda tal cual. Si el hash es igual al de la descarga anterior, la
   corrida termina sin generar candidato.
4. Parser. Pasa las hojas a observaciones por serie y mes. Determinístico.
5. Validación. Reglas fijas, sin LLM (abajo).
6. Candidato. Se crea siempre, tenga o no hallazgos.
7. Agente. Solo recibe los hallazgos que las reglas no resuelven.
8. Revisión humana. Ve el diff y las propuestas, y aprueba o rechaza.
9. Publicado. Al aprobar se genera un `release_id` nuevo, con el formato del que
   ya existe (`ipc-piloto-fe3e20e47271`). `GET /api/base-datos/catalogo` lee de
   ahí y el frontend no cambia.

## Decisiones del orquestador

El pipeline (`servicio_datos/pipeline.py`) une colecta, parseo, validación y candidato.

- Archivos nuevos con exactamente los datos ya publicados no son una novedad: la
  corrida cierra `sin_cambios` y no crea candidato.
- El candidato guarda la serie completa y no solo la diferencia: es el contenido
  propuesto para el release. Lo que cambia respecto de lo publicado va en el
  resumen de la corrida (períodos nuevos, cambiados y faltantes).
- Un candidato nuevo descarta al que seguía abierto (`decidido_por = 'sistema'`) y
  lo deja anotado en el resumen: no se publica una versión vieja sobre datos más
  nuevos.
- Los hallazgos que ya pasaron por una publicación no vuelven a la cola. Con los
  umbrales actuales el IPC tiene 12 alertas de salto mensual históricas, todas reales
  (diciembre de 2023 y enero de 2024); se revisan una vez y no reaparecen cada mes.
- Un hallazgo sobre una serie que la base no conoce se guarda sin serie, con el
  identificador en el texto.
- Todo el armado del candidato es una transacción: si algo falla no queda nada a
  medias, y la corrida se cierra `fallida`. Un archivo que el parser rechaza también
  es `fallida`, no un error del programa.

Pendiente: un aviso si pasa la ventana del mes sin datos nuevos. El pipeline solo
mira lo que llega; que no llegue nada es trabajo del cron o del servicio de alertas.

## Decisiones de la publicación

`servicio_datos/publicacion.py` convierte un candidato abierto en el release vigente.

- Todo hallazgo del candidato tiene que estar aceptado por una persona, y no puede haber
  ninguno rechazado ni propuestas del agente sin decidir. Si no, no se publica y el mensaje
  dice cuántos faltan. La revisión queda en `revision_hallazgo`, con quién y por qué.
- Una revisión se cambia con otra: vale la última y el historial queda. Rechazar exige un
  motivo. No se puede revisar un hallazgo de un candidato que ya no está abierto.
- El release es una foto completa: lo vigente después de publicar es exactamente el
  candidato. Los períodos con otro valor se cierran y se abren de nuevo, los que el
  candidato ya no trae se cierran, y los que no cambian no se tocan. Por eso "los datos tal
  como estaban en el release N" es una consulta exacta.
- El contenido tiene un hash (SHA-256 de serie, período y valor, normalizando el valor) que
  se guarda en el release y se puede recalcular desde lo vigente.
- `release_id` es `ipc-AAAA-MM-DD-<10 del hash>`; si el mismo contenido se publica dos veces
  el mismo día (un cambio y su vuelta atrás) se distingue con un número al final. Los
  números de release (`numero`) pueden tener huecos tras una publicación que falló: es
  normal en una secuencia y no afecta a las consultas.
- Todo es una transacción y una publicación por fuente a la vez.
- Descartar un candidato lo cierra entero, con quién y por qué, y no toca lo publicado. Un
  candidato reemplazado por uno más nuevo deja su motivo también.

## Lectura desde ChartBay

La web lee dos vistas del servicio y no sus tablas: `publicado_release` (el release vigente de
cada fuente, con su procedencia) y `publicado_observaciones`. Se conecta con un rol de solo
lectura que ve únicamente esas vistas, y las lee en una sola transacción para no mezclar dos
releases. `GET /api/base-datos/catalogo` mantiene su forma; solo agrega `origen`.

- La procedencia se congela en el release al publicar, no se reconstruye después.
- El catálogo de 100 entradas sigue saliendo del JSON, porque en la base solo están las siete
  series del IPC. Lo publicado pisa los datos y la procedencia de esas siete.
- Sin URL, sin nada publicado, o con la base caída, la web sirve el archivo. Un fallo no la
  frena: el resultado se guarda unos segundos y el log dice solo el tipo de error.

## Reglas de validación del IPC

- Estructura: hoja y fila de encabezado esperadas; nacional más 6 regiones
  presentes. Si no, falla y alerta.
- Fechas de encabezado: Excel convierte encabezados de mes en fechas con un día
  cualquiera. El piloto ya tuvo el caso (`2026-03-26` interpretado como
  `2026-03`). La regla normaliza al primer día del mes y lo anota; cualquier otro
  patrón es un hallazgo.
- Continuidad: sin meses faltantes ni duplicados.
- Historia intacta: los meses ya publicados no deberían cambiar. El IPC en
  general no se revisa, así que un cambio en el pasado es la señal más fuerte de
  falla o de cambio de base.
- Rango: valores positivos y variación mensual bajo un umbral. Un salto grande no
  es un error por sí mismo: es un hallazgo.
- Cruce: el nacional debe quedar entre el mínimo y el máximo de las regiones. Es
  una prueba débil (no se usan ponderadores) pero detecta desfases evidentes.
- Cobertura: las series deberían terminar en el mismo mes. Ver "Observaciones del
  piloto".
- Frescura: si el calendario dice que el mes ya debería estar publicado y no está,
  alerta.

## Qué hace el agente

Casos: un encabezado o una fecha que las reglas no saben interpretar; un salto
atípico (error de carga, cambio de base o dato real); un desfase de cobertura.

Para cada uno busca evidencia (archivo anterior, nota metodológica), la cita y
devuelve una propuesta con nivel de confianza. Si no puede citar evidencia, la
propuesta sale como "requiere revisión humana".

Permisos: lectura sobre crudo y candidato; una sola escritura, crear una
propuesta. No toca el candidato ni lo publicado.

## Aprobación por niveles

- Humana, siempre al comienzo: cualquier cambio de valor numérico, de base o de
  cobertura.
- Elegible para automática, cuando el usuario lo habilite por categoría: cambios
  mecánicos que no tocan valores (normalización de encabezados, tipos,
  duplicados exactos).

## Esquema de datos (PostgreSQL)

- `fuente`: id (`INDEC_IPC`), nombre, URL base, calendario de publicación.
- `descarga`: fuente, URL, SHA-256, bytes, fecha, ruta del crudo, estado (nueva,
  idéntica, fallida).
- `serie`: id (`ipc_ng_nacional`, etc.), territorio, base, unidad, frecuencia,
  hoja y fila de origen. Equivale al catálogo actual.
- `observacion`: serie, período, valor, `release_desde` y `release_hasta` (nulo
  si está vigente). Nunca se pisa un valor: se cierra la fila vieja y se abre una
  nueva. La vigencia se mide en releases y no en fechas, así que "los datos tal
  como estaban en el release N" es una consulta exacta.
- `corrida`: estado, resumen y las descargas que trajo (tabla puente
  `corrida_descarga`; el IPC trae dos archivos por corrida). Una corrida
  `en_curso` que supera el vencimiento se da por abandonada.
- `hallazgo`: corrida, serie, período, regla, severidad, detalle.
- `revision_hallazgo`: hallazgo, decisión (aceptado o rechazado), revisor, comentario y
  fecha. Es lo que permite publicar; se detalla en "Decisiones de la publicación".
- `propuesta`: hallazgo, tipo, valor actual, valor propuesto, evidencia,
  confianza, estado (pendiente, aprobada, rechazada), revisor, comentario.
- `release`: `release_id`, corrida, quién aprobó, fecha, hash del contenido. Hace
  reproducible la ficha de procedencia.

## Interfaz de revisión

Una pantalla por candidato.

- Encabezado: fuente, archivo, hash. Tres números: meses nuevos, valores del
  pasado cambiados (si no es cero, se destaca) y hallazgos resueltos.
- Lista de hallazgos con severidad y estado (pendiente, aprobado, rechazado).
- Detalle del hallazgo elegido: antes y después (gráfico o tabla), evidencia,
  propuesta del agente con su confianza.
- Acciones: aprobar propuesta; rechazar (el comentario es obligatorio y vuelve al
  agente como contexto); pedir otra propuesta.
- Publicar: con hallazgos pendientes no publica y dice cuántos faltan. Con
  rechazos sin resolver, el candidato vuelve al agente. Publicar crea un release
  nuevo y deja el anterior disponible. "Rechazar candidato" lo descarta entero y
  no toca lo publicado.
- Los cambios mecánicos se marcan aparte como elegibles para aprobación
  automática; esa automatización la habilita el usuario, no se activa sola.

## Lo que se construyó de la interfaz

Está en `servicio_datos/revision/` y sigue el diseño de abajo, con tres diferencias que salieron de usarla
con datos reales:

- Los hallazgos van agrupados por regla, con una acción para aceptar de una vez los pendientes de un grupo
  o todos: los 19 hallazgos del primer candidato real eran 7 casi iguales por serie.
- Cada hallazgo trae el gráfico de su serie, con el período marcado y lo vigente en punteado.
- Es una app aparte de la web pública, con login (usuario y contraseña, el usuario queda como revisor), token
  en cada formulario, límite de intentos y cabeceras estrictas, porque es lo único que escribe. Funciona sin
  JavaScript.

## Cola de candidatos

- Muestra candidatos pendientes, corridas fallidas e historial. Las fallidas
  viven en la misma lista: una corrida que falla en silencio deja el dato viejo.
- Pestaña por defecto: "Requieren atención" (pendientes y fallidas).
- Las corridas sin cambios no generan filas. Se resumen en la tarjeta "Última
  corrida".
- Tarjetas de resumen: esperan revisión, corridas fallidas, release vigente,
  última corrida.
- Una acción por fila según su estado: abrir revisión, ver el error, ver el
  detalle. Reintentar una corrida fallida es manual.
- Sin pendientes, el estado vacío dice "Todo al día".
- Orden: fallidas primero; después pendientes, de la más antigua a la más nueva.
- Ruta aparte de `/base-de-datos`, que sigue siendo de lectura para el usuario
  final.

## Observaciones del piloto

Verificadas contra el servidor de INDEC el 2026-10-06:

- El desfase de cobertura no era un error de lectura. `sh_ipc_MM_AA.xls` lleva el
  mes de publicación, no el del dato: `08_26` salió el 13/08 y llega hasta julio;
  `09_26` salió el 10/09 y llega hasta agosto. La primera versión del piloto mezcló
  el nacional de `08_26` con las aperturas vigentes (hasta agosto), y su nacional
  quedó un mes atrás. Se corrigió el 2026-10-06 regenerándolo con `09_26` (819
  observaciones; las 116 anteriores del nacional no cambiaron). La regla de
  cobertura existe para detectar esto antes de que llegue a la base.
- `published_at` sale del encabezado `Last-Modified` del servidor, que viene en
  los archivos reales. El colector lo guarda en `descarga.publicada_en`.
- INDEC no responde 404 a un archivo inexistente: contesta 200 con una página
  HTML (`sh_ipc_10_26.xls`). El colector decide por el contenido (firma de
  archivo `.xls` y tamaño mínimo), nunca por el código de estado.

## Decisiones abiertas

- Umbral de variación mensual que dispara al agente; conviene fijarlo mirando la
  serie histórica.
- Qué pasa tras rechazar un candidato: queda bloqueado hasta la próxima descarga
  o el agente reintenta con el comentario.
- Quién revisa. Si es una sola persona, la cola es simple; si son varias, hay que
  agregar permisos y registrar el revisor en `release`.
- Avisos: por mail o Slack cuando entra una fila en "Requieren atención" y cuando
  pasa la ventana del mes sin candidato.
- Dónde vive el servicio. Recomendación: servicio de datos propio, en el repo
  separado de la base, con su API; ChartBay solo la consume.
- Presupuesto del agente: corre solo sobre hallazgos ya filtrados, no sobre toda
  la serie en cada corrida.

## Orden de construcción

1. PostgreSQL con crudo inmutable y observaciones versionadas.
2. Colector del IPC con idempotencia por hash y alertas de falla.
3. Parser y validación determinística, con las reglas de arriba.
4. Candidato y release, y que `GET /api/base-datos/catalogo` lea de ahí.
5. Interfaz de revisión y cola, aún sin agente (los hallazgos se resuelven a mano).
6. Agente, con propuestas y evidencia.
7. Aprobación automática por categoría, cuando haya historial que la justifique.
8. Más fuentes y ampliación provincial.

El agente va después de tener crudo, historial y revisión: sin eso no se puede
auditar ni deshacer lo que haga.
