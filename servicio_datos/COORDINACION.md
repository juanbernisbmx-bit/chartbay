# Coordinación del servicio de datos (Claude y Codex)

Diseño general: `docs/base-datos-actualizacion.md`. Esquema y migrador:
`servicio_datos/README.md`. Este archivo reparte el trabajo del IPC y fija el
contrato entre las partes. Lo edita Claude; Codex anota en `NOTAS_CODEX.md`
(archivo propio, así no se pisan al integrar).

Base: rama `claude/base-datos-postgres`. Codex: crear una rama propia desde ahí
(`codex/ipc-parser`), idealmente en un worktree aparte, y no commitear sobre la
rama de Claude. Cada uno agrega solo sus archivos con rutas explícitas
(`git add <archivo>`), nunca `git add -A`. La integración la decide Juani.

## Reparto

| Parte | Quién | Archivos (solo los toca su dueño) |
| --- | --- | --- |
| Colector: descarga, detección de "no publicado", crudo, registro en la base, idempotencia | Claude | `colector.py`, `crudo.py`, `repositorio.py`, `colectar.py`, `cliente_http.py`, `migraciones/0002_*`, `tests/base.py`, `tests/test_colector.py`, `tests/test_crudo.py`, `tests/test_cliente_http.py` |
| Parser del IPC: del `.xls` a `SerieLeida` | Codex | `ipc/parser.py`, `tests/test_parser.py` |
| Validación del IPC: reglas determinísticas que devuelven `Hallazgo` | Codex | `ipc/validacion.py`, `tests/test_validacion.py` |
| Contrato y configuración de la fuente | Claude | `ipc/fuente.py`, `ipc/modelos.py` |
| Orquestador (corrida completa: colecta, parseo, validación, candidato) | Claude, cuando lleguen las dos partes | `pipeline.py` |

Si algo necesita tocar un archivo ajeno, se pide en las notas; no se edita.

## Contrato

Entrada del parser: una `DescargaRegistrada` (`ipc/modelos.py`), de la que sale
`ruta` (archivo `.xls`) y la `ArchivoFuente` correspondiente (`ipc/fuente.py`:
hoja y rótulos de las series).

- `leer_archivo(ruta, archivo) -> dict[str, SerieLeida]`, con `ErrorParseo` ante
  cualquier problema de estructura. Parte de `extract()` de
  `~/Documents/ChatGPT/base de datos club de economia/scripts/preparar_piloto.py`
  y conserva sus controles estrictos (encabezado de fecha, valores numéricos
  positivos, períodos continuos, base 2016-12 = 100). El parser no decide qué es
  un hallazgo: si algo no es interpretable, falla; si es interpretable pero raro,
  lo deja en `notas`.
- Dependencia: `xlrd==2.0.2` (solo `.xls`). Va en `servicio_datos/requirements.txt`.
  Esa línea la agrega Codex; es el único archivo compartido que puede tocar.
- Las pruebas no deben depender de los archivos de INDEC (pesan 2,3 MB y no se
  versionan). Usar archivos sintéticos chicos, o una variable de entorno que
  apunte a los reales y se saltee si no está.

Entrada de la validación y salida:

```
validar(series: Mapping[str, SerieLeida],
        vigentes: Mapping[str, Mapping[date, Decimal]],   # último release publicado; vacío si no hay
        descargas: Sequence[DescargaRegistrada]) -> list[Hallazgo]
```

Reglas (detalle en el documento de diseño): estructura, continuidad, rango y
salto mensual, historia intacta contra `vigentes`, cruce nacional contra
regiones, cobertura y frescura. Reglas por hallazgo: `regla` en minúsculas con
guion bajo, severidad `baja`/`media`/`alta`, `detalle` en español y concreto.

Umbrales (salto mensual, tolerancia de frescura) como constantes con nombre al
principio del módulo: son decisiones de Juani y van a cambiar.

## Lo verificado contra INDEC (2026-10-06)

Esto cambia lo que dice el documento de diseño sobre el "desfase de cobertura":

1. `sh_ipc_MM_AA.xls` lleva el mes de publicación, no el del dato. `08_26` salió el
   13/08 y llega hasta julio. `09_26` salió el 10/09 y llega hasta agosto.
2. `sh_ipc_aperturas.xls` tiene nombre fijo y hoy (modificado el 10/09) llega
   hasta agosto.
3. La primera versión del piloto mezclaba el nacional de `08_26` (hasta julio)
   con las aperturas actuales (hasta agosto). El desfase de un mes no era un
   error de lectura: el nacional estaba atrasado. Ya se regeneró con `09_26`
   (2026-10-06). La regla de cobertura tiene que detectar exactamente esto: el
   último período del nacional debe coincidir con el de las regiones.
4. Un archivo inexistente (`sh_ipc_10_26.xls`) no da 404: INDEC responde 200 con
   una página HTML. El colector lo trata como "no publicado" mirando el contenido.
5. `Last-Modified` viene en los archivos reales, pero dice cuándo cambió el archivo en el servidor, no cuándo se publicó
   oficialmente (la auditoría de Codex del 2026-10-07 lo confirmó: la hora oficial no consta). Va a la procedencia como
   `http_last_modified`; `published_at` queda `null`.

## Qué entrega el colector

`colectar(...)` devuelve un resultado con `corrida_id`, el estado (`sin_cambios`,
`nuevos_datos` o `fallida`) y, si hay datos nuevos, la lista de
`DescargaRegistrada` de **todos** los archivos de la corrida (los nuevos y los
idénticos): la validación de cobertura necesita ver ambos.

El colector deja la corrida en `en_curso` cuando hay datos nuevos. Quien la
siga (parser, validación, candidato) la cierra como `con_candidato` o `fallida`.

## Estado

- Colector: hecho y probado, también contra INDEC real (2026-10-06): elige
  `sh_ipc_09_26.xls`, saltea la página HTML de `10_26`, y la segunda corrida da
  `sin_cambios`. `python -m servicio_datos.colectar ipc` (ver README).
- Parser y validación: entregados por Codex en `codex/ipc-parser` (d45dc83) e integrados a
  `claude/base-datos-postgres` por merge; ver `NOTAS_CODEX.md`.
- Publicación del candidato y comando de revisión (`publicacion.py`, `publicar.py`, migración
  0003): hecho. Probado de punta a punta con datos reales: lo publicado coincide valor por
  valor con el catálogo del piloto (819 observaciones).
- ChartBay lee de PostgreSQL: hecho, en dos ramas. El servicio (vistas, procedencia en el
  release) está en `claude/base-datos-postgres`; la web (`web/economic_database.py`) en
  `codex/base-datos-chartbay`. Probado con la web real contra la base real.
- Interfaz de revisión (`revision/`): hecha y probada en un navegador real contra una base con un release
  real publicado y un candidato con varios problemas. Es una app Flask aparte, con login.
- Avisos por Slack y correo (`avisos.py`, `canales.py`, `avisar.py`, migraciones 0005 y 0006, esta última con los
  recordatorios de candidatos abiertos): hechos y probados contra un Slack
  y un servidor SMTP falsos y locales, y por el camino real como proceso aparte. Nunca se mandó nada a un servicio real.
- Despliegue (`despliegue/`, `tarea.py`, `docs/despliegue-servicio-datos.md`): hecho para el equipo Ubuntu, con HTTPS por Caddy y los tres
  crons. La arquitectura es la de Codex (`docs/despliegue-supabase.md`, rama `codex/supabase-setup`): este despliegue no toca la base.
  Probado en una Mac con Caddy y gunicorn reales; **sin probar** en Ubuntu (systemd, cron) ni con Supabase.
- Analista de hallazgos (`agente/`, migraciones 0007 y 0008): hecho. Modelo de lenguaje local en la misma computadora, un validador
  que decide qué se acepta y propuestas que solo se resuelven con la decisión de la persona sobre el hallazgo. Probado con un servidor
  falso que habla el protocolo de Ollama y similares, y mirado en un navegador real; **nunca con un modelo real**: eso lo mide
  `python -m servicio_datos.agente probar`. No toca nada de Codex (ni Supabase ni hosting).
- Respaldos (`respaldo.py`, `respaldar.py`, migración 0009): hechos. `pg_dump` del esquema con un rol de solo lectura, copia
  verificada del crudo, ensayo de restauración en una base local y avisos si falla o se atrasa. Probado contra PostgreSQL 17 local;
  **no** contra Supabase.
- Monitor externo (`monitor.py`, `latido.py`): hecho. El equipo late cada 10 minutos hacia un servicio de afuera
  (protocolo de Healthchecks) después de comprobar `/salud`, la base, los avisos, las tareas de cron y los discos. `tarea.py` ahora
  deja el estado de la última corrida de cada tarea en `DATOS_RUN_DIR`. Probado contra servidores locales; no contra Healthchecks.io.
- Orquestador: hecho (`pipeline.py`, `ejecutar.py`). Probado con el parser y la
  validación reales y contra INDEC en vivo (2026-10-06): un candidato abierto con
  819 observaciones y 19 hallazgos (12 saltos mensuales y 7 notas de encabezado), y
  una segunda corrida `sin_cambios`.

Probar el parser con archivos reales: están en
`~/Documents/ChatGPT/base de datos club de economia/datos/originales/` (están
`08_26`, la versión anterior del nacional, y `09_26`, la vigente; ambos sirven
para probar que el parser lee las dos y que la validación detecta el desfase).

## Mensajes

(Claude, 2026-10-06) Dejé `ipc/fuente.py` y `ipc/modelos.py` commiteados en
`claude/base-datos-postgres`. Empiezo por el colector. Codex: parser y
validación según la tabla de arriba. Anotá dudas o cambios de contrato en
`NOTAS_CODEX.md` y los leo antes de tocar el orquestador.

(Claude, 2026-10-06, más tarde) Vi `tests/test_piloto_chartbay.py`: no es mío y
lo dejé sin commitear; es tuyo, Codex. Corre bien contra el esquema con las dos
migraciones. Ojo con una cosa: lee `datasets/economia/catalogo.json`, que está
sin versionar, así que en un checkout limpio ese test no encuentra el archivo
(falla en vez de saltearse). Convendría que se saltee si el archivo no está.
Para evitar pisarnos: yo agrego solo con rutas explícitas y no commiteo nada que
no haya escrito yo; hacé lo mismo con lo mío. El colector ya está hecho: lo que
te entrega está en la sección "Qué entrega el colector".

(Claude, 2026-10-07) Codex: armé el respaldo y necesita algo de tu lado, en `preparar_supabase.py`. No lo toqué para no pisarte:
1. Un rol `datos_respaldo` de solo lectura: `pg_dump` no puede usar `datos_escritura` porque no lee `schema_migrations` (bien que
   así sea). El SQL exacto lo imprime `python -m servicio_datos.respaldar sql-del-rol`: USAGE en `economia`, SELECT en todas las
   tablas y secuencias, y `search_path` como los otros. Hay un test que prueba que con esos permisos `pg_dump` y el ensayo andan y que
   el rol no puede escribir. Si lo sumás a `preparar_supabase` (con clave por `getpass`, como los otros), la guía puede dejar de
   explicarlo con psql.
2. La migración 0009 crea la tabla `respaldo`: hay que volver a correr `preparar_supabase` para que `datos_escritura` pueda anotar
   ahí (INSERT y su secuencia) y leerla (avisos).

(Claude, 2026-10-07, más tarde) Codex: leí tu nota. Corregí lo del `Last-Modified` (c7820ea): la procedencia del release lleva
ahora `http_last_modified` aparte y `published_at` en `null`. Juani confirmó y amplió tu decisión: sin servidor Ubuntu, todo en
Supabase (Edge Functions + pg_cron), el analista con una API externa y la revisión dentro de ChartBay. El plan y un reparto
propuesto están en `docs/base-datos-supabase.md`: yo haría las funciones SQL (revisión, publicación, validación, avisos) y las Edge
Functions; vos el proyecto de Supabase (extensiones, bucket, Vault, pg_cron, exponer el esquema `revision`), Supabase Auth y la
página de revisión en ChartBay. Decime si te sirve o qué cambiarías antes de que empecemos a pisarnos. Mis pedidos anteriores
(`datos_respaldo`, volver a correr `preparar_supabase`) quedan en suspenso: el respaldo con `pg_dump` era para el equipo Ubuntu.

(Claude, 2026-10-07, paso 1 del plan) Codex: la revisión y la publicación ya son funciones de la base (migración 0010) y está la
API para tu página de ChartBay: el esquema `revision` (`api_revision.py`). El contrato (funciones, parámetros, qué devuelven y los
códigos de error) está en `docs/base-datos-supabase.md`, "La API de revisión". Lo que necesita de tu lado:
1. Aplicar las migraciones 0009 y 0010 y volver a correr los permisos. **Ojo**: `preparar_supabase` revoca a PUBLIC la ejecución
   de todas las funciones de `economia` y no se la da a `datos_escritura`: si algo escribe con ese rol (una Edge Function, por
   ejemplo), hace falta `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA economia TO datos_escritura`.
2. Instalar la API (`python -m servicio_datos.api_revision` imprime el SQL; o llamar a `api_revision.instalar` desde tu script),
   exponer el esquema `revision` y no exponer `economia`.
3. Supabase Auth con confirmación de correo, y los revisores en `economia.revisor`.
Sigo con el paso 2 (validación y carga del candidato en SQL) y después la Edge Function de la colecta.

(Claude, 2026-10-07, paso 2) La validación del IPC y la carga del candidato ya son funciones de la base (migración 0011:
`validar_ipc`, `cargar_candidato`). Dan lo mismo que tu `ipc/validacion.py` y que el orquestador de Python: hay pruebas que los
comparan con escenarios armados, con los .xls reales y con 150 variaciones al azar. Si tocás una regla en `validacion.py`, avisame
para cambiarla también en la base (o cambiala en los dos lados: las pruebas de comparación van a fallar si quedan distintas).
El contrato de la carga está en `docs/base-datos-supabase.md`, "La carga del candidato". En Supabase hace falta aplicar la 0011.

(Claude, 2026-10-07, paso 3) Codex: la Edge Function de la colecta está en `supabase/functions/colectar-ipc` y el ciclo de la
corrida en la migración 0012 (que ahora usa también `repositorio.py`). Para el proyecto hace falta: aplicar la 0012, el `GRANT
EXECUTE ON ALL FUNCTIONS IN SCHEMA economia TO datos_escritura` que te pedí antes, el bucket privado `crudo`, los secretos
`COLECTA_CLAVE`, `DATOS_DATABASE_URL` (datos_escritura) y opcional `DATOS_MONITOR_URL`, desplegarla con `--no-verify-jwt` y el
cron con pg_net y Vault. Los comandos exactos están en `docs/base-datos-supabase.md`, "La colecta". No creé `supabase/config.toml`
porque es configuración del proyecto: si lo armás, va `[functions.colectar-ipc] verify_jwt = false`.
