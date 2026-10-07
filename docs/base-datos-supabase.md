# Base de datos: todo dentro de Supabase (plan)

Estado: plan aprobado; pasos 0 y 1 hechos (2026-10-07).

## La decisión

Juani decidió el 2026-10-07, a partir de la nota de Codex en `servicio_datos/NOTAS_CODEX.md`:

- **No hay servidor Ubuntu por ahora.** Lo que iba a correr en ese equipo (colecta, avisos, respaldo, latido, revisión) pasa a
  **Supabase**: Edge Functions programadas con pg_cron.
- **El analista usa una API externa** (un modelo en la nube con clave) en vez de un modelo local.
- **La revisión humana se hace dentro de ChartBay**, con login.

Lo que no cambia: el dato pasa por candidato, hallazgos, revisión humana y release; el analista solo propone; lo publicado
es de solo agregar. `docs/despliegue-servicio-datos.md` queda como referencia para cuando haya equipo.

## Límites de Supabase que mandan

Verificados en su documentación el 2026-10-07:

- **Edge Functions:** 256 MB de memoria, 150 s de duración en el plan gratuito y **2 s de CPU por pedido** (la espera de red no
  cuenta). Leer dos `.xls` de INDEC y validar 819 valores tiene que entrar en esos 2 s, o partirse en pasos. **Hay que medirlo
  con los archivos reales antes de elegir.**
- **Programación:** pg_cron dispara las funciones por HTTP con pg_net, con los secretos en Vault. Se recomienda no más de 8
  trabajos a la vez y menos de 10 minutos cada uno. Que esté disponible en el plan gratuito no lo dice la página: confirmarlo en
  el panel (Database → Extensions).
- **Respaldos:** el plan gratuito no tiene copias automáticas (la documentación recomienda exportar con `supabase db dump`). Pro
  guarda 7 días de copias diarias. **Ningún plan incluye los archivos de Storage en sus copias**: el crudo, si va a Storage,
  necesita su propio respaldo.

Fuentes: [límites de Edge Functions](https://supabase.com/docs/guides/functions/limits),
[programar funciones](https://supabase.com/docs/guides/functions/schedule-functions), [Cron](https://supabase.com/docs/guides/cron),
[respaldos](https://supabase.com/docs/guides/platform/backups).

## Cada pieza, de dónde a dónde

| Pieza | Hoy (Python, pensado para Ubuntu) | En Supabase | Qué se reusa |
| --- | --- | --- | --- |
| Esquema, migraciones y reglas de la base | SQL | Igual, en el esquema privado `economia` | Todo |
| Validación (las 10 reglas) | `ipc/validacion.py` | **Función SQL** sobre el candidato y lo vigente | La lógica, traducida; las pruebas de Python contra Postgres siguen sirviendo |
| Candidato, diferencias y publicación | `pipeline.py`, `publicacion.py` | **Funciones SQL**: cargar corrida, revisar, aceptar pendientes, publicar, descartar | Casi todo ya es SQL dentro de Python |
| Colecta y lectura de los `.xls` | `colector.py`, `ipc/parser.py` | **Edge Function `colectar-ipc`** (TypeScript): baja, detecta la página HTML en vez del archivo, guarda el crudo en un bucket privado (nombre = hash, como hoy), lee con SheetJS y llama a la función SQL que carga la corrida | Las reglas de nombres de archivo y lo aprendido de INDEC |
| Programación | cron en Ubuntu | pg_cron + pg_net, secretos en Vault | Los horarios |
| Avisos | `avisos.py`, `avisar.py` | **Función SQL** que detecta (las consultas de hoy) + **Edge Function `avisar`** que entrega por Slack | La detección y la bandeja de salida (`aviso`) |
| Analista | `agente/`, modelo local | **Edge Function `analizar`** con la API de Claude (SDK oficial), cuando aparece un candidato | El diseño: hechos que reúne el código, validador que decide, solo escribe `propuesta`. Se traduce a TypeScript |
| Revisión | app Flask aparte, login Basic | **Página dentro de ChartBay**, login con Supabase Auth en el navegador | La pantalla y sus textos |
| Respaldo | `pg_dump` y copia del crudo a otro disco | **A decidir** (ver abajo) | La idea del ensayo de restauración |
| Monitor externo | latido cada 10 minutos | Cada función programada le late a Healthchecks al terminar: si pg_cron o una función dejan de andar, avisa él | `monitor.Monitor` como modelo |

### La revisión dentro de ChartBay, sin darle credenciales a ChartBay

El servidor de ChartBay sigue sin claves de la base. El navegador del revisor inicia sesión con Supabase Auth y llama a
funciones de un esquema `revision` expuesto, que solo tiene funciones `SECURITY DEFINER`: cada una comprueba que quien llama
esté en una lista de revisores y recién ahí revisa o publica. Las tablas siguen en `economia`, que no se expone (como pidió
Codex). Es un cambio respecto de hoy: ChartBay pasa a tener una página con login.

### Respaldo: exportar desde afuera

Juani eligió la opción 2 (2026-10-07): un GitHub Action exporta la base y el bucket del crudo cada tanto. Las tres que había:

1. **Plan Pro**: 7 días de copias de la base. El crudo de Storage sigue sin copia.
2. **Exportar desde afuera** cada tanto (`supabase db dump` y el bucket) desde una computadora o un GitHub Action. Es lo único que
   sobrevive a perder el proyecto, pero corre fuera de Supabase.
3. **Una función semanal que exporte las tablas a otro bucket**: protege de un borrado o un error, no de perder el proyecto.

## Qué pasa con el Python

Sigue en el repositorio y con sus pruebas hasta que cada paso lo reemplace; después se borra lo que ya no se use (colector,
pipeline, revisión Flask, despliegue en Ubuntu, modelo local, respaldo a disco y latido por cron).

## Orden propuesto

0. **Medir** la lectura de los `.xls` reales con SheetJS en Deno. **Hecho**: con SheetJS 0.20.3 en Deno 2.9.7, leer el nacional
   (2,4 MB) y las aperturas (1,2 MB) cuesta ~0,5 s de CPU en frío y ~0,3 s en caliente en esta Mac, contra 2 s de límite; cargar
   SheetJS, unos milisegundos. Las 819 observaciones coinciden una por una con las del parser de Python (solo cambia escribir `100`
   en vez de `100.0`, que la base trata igual). Leer solo la hoja necesaria no ahorra: el `.xls` se recorre entero. Si el servidor de
   Supabase resultara bastante más lento, cada archivo puede ir en su propio pedido.
1. **Revisión y publicación como funciones SQL**, con el esquema `revision` y la lista de revisores. **Hecho**: ver "La API de
   revisión" abajo.
2. **Validación y carga del candidato como funciones SQL.**
3. **Edge Function `colectar-ipc`**, el bucket del crudo y pg_cron.
4. **La página de revisión en ChartBay.**
5. **Avisos.**
6. **El analista con la API.**
7. **El respaldo**, según lo que se decida.

## La API de revisión (paso 1)

La lógica de revisar y publicar está en funciones del esquema del servicio (migración 0010): `revisar_hallazgo`,
`aceptar_pendientes`, `estado_revision`, `publicar_candidato`, `descartar_candidato`, `procedencia_de` y `hash_candidato` (el mismo
hash que Python). `publicacion.py` las llama, así que las ~230 pruebas de siempre las cubren. Un error de negocio sale con
SQLSTATE `CB001`, el mensaje para la persona y un código en DETAIL (`no_existe`, `no_abierto`, `hallazgos_pendientes`,
`hallazgos_rechazados`, `propuestas_pendientes`, `candidato_vacio`, `revision_invalida`, `candidato_cerrado`, `descarte_incompleto`,
`aprobador_vacio`).

La página de ChartBay no ve esas tablas ni esas funciones: ve el esquema `revision` (`api_revision.py`), que se instala aparte y
se expone en Supabase. Todas sus funciones exigen que el correo de la sesión de Supabase Auth esté activo en la tabla `revisor`
(si no: SQLSTATE `42501`, DETAIL `no_autorizado`) y revisan o publican con el nombre de esa tabla:

| Función (`supabase.schema('revision').rpc(...)`) | Parámetros | Devuelve |
| --- | --- | --- |
| `cola` | — | `{revisor, abiertos[], fallidas[], historial[], release}` |
| `candidato` | `candidato_id` | `{candidato, estado, archivos[], hallazgos[] (con su decisión y sus propuestas), diferencias}` |
| `series` | `candidato_id`, `serie_ids[]` | `{serie_id: {candidato: [[periodo, valor]...], vigente: [...]}}` |
| `revisar` | `hallazgo_id`, `decision` (`aceptado`/`rechazado`), `comentario` | nada |
| `aceptar_pendientes` | `candidato_id`, `regla` (opcional), `comentario` (opcional) | cuántos aceptó |
| `publicar` | `candidato_id` | `{release_numero, release_id, hash_contenido, observaciones_abiertas, ...}` |
| `descartar` | `candidato_id`, `motivo` | nada |
| `revisor_actual` | — | el nombre del revisor, o `null` |

Para instalarla: aplicar las migraciones, correr el SQL de `python -m servicio_datos.api_revision` (o `api_revision.instalar` desde
`preparar_supabase`), agregar `revision` a *Exposed schemas* y cargar los revisores (`INSERT INTO economia.revisor (email, nombre)`).
Supabase Auth tiene que exigir confirmar el correo: la lista confía en que el correo de la sesión es de quien la inició. Las pruebas
imitan una sesión con el rol `authenticated` y el correo en `request.jwt.claims`, que es lo que hace Supabase; no se probó contra
Supabase de verdad.

## Reparto con Codex (aprobado por Juani)

- **Claude**: las funciones SQL (pasos 1, 2 y la detección de avisos) con pruebas contra Postgres, y las Edge Functions (3, 5 y 6)
  con pruebas de su lógica.
- **Codex**: el proyecto de Supabase (extensiones, bucket, Vault, pg_cron, roles y exponer el esquema `revision`), Supabase Auth y
  la página de revisión en ChartBay (paso 4), que es la parte de `quantbay/src/database` y `web/` en la que ya trabaja.
