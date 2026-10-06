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
5. `Last-Modified` viene en los archivos reales: es la fecha de publicación
   (`published_at`, hoy `null` en el piloto).

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
- Despliegue (`despliegue/`, `tarea.py`, `docs/despliegue-servicio-datos.md`): hecho para el equipo Ubuntu, con HTTPS por Caddy y los dos
  crons. La arquitectura es la de Codex (`docs/despliegue-supabase.md`, rama `codex/supabase-setup`): este despliegue no toca la base.
  Probado en una Mac con Caddy y gunicorn reales; **sin probar** en Ubuntu (systemd, cron) ni con Supabase.
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
