# Base de datos: todo dentro de Supabase (plan)

Estado: plan aprobado; pasos 0 a 3 y 5 a 7 hechos (2026-10-07). Falta el 4 (Codex).

**En producción** (Codex, 2026-10-08, proyecto `oqbqdngieifjlgbppvey`): migraciones 0011 a 0014, el rol `servicio_datos`, la colecta
(`colectar-ipc`, con cron a las 9:30 y 17:30) y `avisar` (desplegada, todavía sin canal ni cron). La primera colecta dejó el candidato 1
(819 observaciones, 19 hallazgos). Faltan desplegar: el analista (0015, espera la clave de la API y la autorización de Juani), el
respaldo (0016, espera las claves S3 y el rol), la copia pública (0017, espera la licencia y que los flujos lleguen a `main`) y la
página de revisión de ChartBay con su usuario de Auth.

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
| Respaldo | `pg_dump` y copia del crudo a otro disco | **Un flujo de GitHub Actions** que baja el bucket, vuelca la base, ensaya la restauración y guarda un artefacto | `respaldo.py` entero: volcado, verificación, ensayo |
| Monitor externo | latido cada 10 minutos | Cada función programada le late a Healthchecks al terminar: si pg_cron o una función dejan de andar, avisa él | `monitor.Monitor` como modelo |

### La revisión dentro de ChartBay, sin darle credenciales a ChartBay

El servidor de ChartBay sigue sin claves de la base. El navegador del revisor inicia sesión con Supabase Auth y llama a
funciones de un esquema `revision` expuesto, que solo tiene funciones `SECURITY DEFINER`: cada una comprueba que quien llama
esté en una lista de revisores y recién ahí revisa o publica. Las tablas siguen en `economia`, que no se expone (como pidió
Codex). Es un cambio respecto de hoy: ChartBay pasa a tener una página con login.

### Respaldo: exportar desde afuera

Juani eligió la opción 2 (2026-10-07): un GitHub Action exporta la base y el bucket del crudo cada tanto (hecho: ver "El respaldo"
abajo). Las tres que había:

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
2. **Validación y carga del candidato como funciones SQL.** **Hecho**: ver "La carga del candidato" abajo.
3. **Edge Function `colectar-ipc`**, el bucket del crudo y pg_cron. **Hecho** (el código, con el rol de mínimo privilegio y
   el `search_path` fijo que pidió Codex): ver "La colecta" abajo.
4. **La página de revisión en ChartBay.**
5. **Avisos.** **Hecho** (el código): ver "Los avisos" abajo.
6. **El analista con la API.** **Hecho** (el código): ver "El analista" abajo.
7. **El respaldo.** **Hecho** (el código): ver "El respaldo" abajo.

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

## La carga del candidato (paso 2)

Quien haga la colecta (la Edge Function del paso 3) baja los archivos, los lee y llama a `cargar_candidato(corrida, hoy, carga)`
con una corrida en curso. Desde ahí todo pasa en la base, en una transacción: compara con lo vigente, valida, descarta el candidato
abierto, crea el nuevo con sus observaciones y sus hallazgos (salvo los que ya pasaron por una publicación) y cierra la corrida
como `con_candidato` o `sin_cambios`. Devuelve `{estado, corrida, candidato_id, hallazgos, hallazgos_ya_revisados,
reemplaza_candidatos, periodos_nuevos, periodos_cambiados, periodos_faltantes}`.

```json
{"series": [{"serie_id": "ipc_ng_nacional", "archivo": "nacional", "hoja": "Índices IPC Cobertura Nacional", "fila_origen": 10,
             "observaciones": [["2016-12-01", "100.0"], ["2017-01-01", "101.5859"]], "notas": []}],
 "definiciones": {"ipc_ng_nacional": {"nombre": "IPC nivel general - Argentina", "tema": "Precios", "...": "..."}},
 "descargados": ["nacional", "aperturas"]}
```

Los valores van como texto, para no perder decimales. Una carga que no tiene esa forma (valores que no son números, fechas que no
son `AAAA-MM-DD`, series o períodos repetidos, una serie sin definición) falla con `carga_invalida` y no deja nada: quien llama
cierra la corrida como fallida.

La validación es `validar_ipc`, que replica regla por regla y con los mismos textos `ipc/validacion.py` (incluido el redondeo al
par de la variación). Las pruebas lo comparan con Python en escenarios armados, con los `.xls` reales y con 150 variaciones al azar,
y comparan `cargar_candidato` con el orquestador de Python de punta a punta con los archivos reales: mismas observaciones, mismos
hallazgos en el mismo orden y el mismo resumen. Mientras exista el Python, una regla nueva va en los dos lados.

## La colecta (paso 3)

`supabase/functions/colectar-ipc` es la Edge Function. Hace lo que la base no puede: bajar los archivos de INDEC (del nombre más
nuevo al más viejo, rechazando la página HTML que INDEC devuelve por un archivo que no existe y sin caer al mes anterior ante un
error de red), guardar cada original en el bucket privado `economia-crudos` con el hash como nombre (`ab/ab12…ef.xls`; la URL,
el hash, el tamaño y el `Last-Modified` quedan en `descarga`), leer los `.xls` con SheetJS y llamar a `cargar_candidato`. El ciclo
de la corrida (abrirla de forma exclusiva, saber si un archivo ya se conocía, registrar descargas y cerrarla) son funciones de la
base (migración 0012), las mismas que usa ahora el colector de Python. Si algo falla, la corrida queda cerrada como fallida, nunca
a medias. Al terminar, le late al monitor externo si `DATOS_MONITOR_COLECTA_URL` está puesto.

Lo que comparte con las funciones que vengan está en `supabase/functions/_compartido/`: la fuente, el lector, la carga, el
cliente HTTP (solo `www.indec.gob.ar`, reintentos, tope de 40 MB, redirecciones solo al mismo host), la base (postgres.js con
conexión directa: `economia` sigue sin exponerse), Storage, Slack, el latido y la autorización.

### Con qué permisos entran a la base las Edge Functions

Con un rol propio, `servicio_datos`, que no ve ninguna tabla: solo puede ejecutar las funciones del esquema `servicio`
(`api_servicio.py`), que envuelven las del servicio. Para la colecta: abrir, anotar y cerrar corridas (sin candidato:
`sin_cambios` o `fallida`), registrar descargas y dejar un candidato con `cargar_candidato`. Para los avisos: detectarlos, tomar los
pendientes y anotar cómo fue cada entrega. No puede leer lo publicado, revisar, publicar ni usar la API de la revisión. Si su
contraseña se filtrara, lo peor que se puede hacer es dejar un candidato falso (que igual pasa por la revisión de una persona) o
callar un aviso. Las funciones son `SECURITY DEFINER` con `search_path` fijo, como las de `revision`; el esquema `servicio` **no** se
expone en la API de Supabase.

Es un solo rol para todas las Edge Functions porque sus secretos son de todo el proyecto: cada función ve los de las otras, así que
un rol por función no aislaría nada y sumaría contraseñas. Por lo mismo comparten la clave con la que las llama pg_cron
(`DATOS_CLAVE_CRON`). Para Storage, la colecta usa la clave de servidor que Supabase le pone (`SUPABASE_SERVICE_ROLE_KEY`, o una
`sb_secret_…` en `DATOS_CLAVE_SERVIDOR` si el proyecto apagó la vieja), nunca la publicable.

### El search_path de las funciones (migración 0013)

Todas las funciones del servicio tienen ahora el `search_path` fijo (`economia, pg_temp`): lo marcaba el Security Advisor
("Function Search Path Mutable"). Sin eso, una función busca lo que nombra sin esquema en el search_path de quien la llama. Una
prueba lo muestra: con un esquema adelante que tiene una `falla` que no frena nada, `publicar_candidato` sin el search_path fijo
publica un candidato con hallazgos pendientes; con él, no. Las migraciones que agreguen funciones terminan con
`CALL fijar_search_path();` y otra prueba revisa que no quede ninguna sin fijar. Cuesta unos milisegundos por carga.

### Para ponerla en marcha (Codex, en el proyecto)

Sirve también para los avisos (paso 5) y el analista (paso 6), que usan el mismo rol, la misma clave y el mismo archivo de secretos.

1. Aplicar las migraciones 0011 a 0015, en orden y con `search_path` en `economia`, como las anteriores.
2. Correr en el SQL Editor lo que imprime `python -m servicio_datos.api_servicio`: crea el rol `servicio_datos` sin poder iniciar
   sesión, el esquema `servicio`, sus funciones y los permisos (revoca todo a `anon`, `authenticated` y `service_role`). Se puede
   volver a correr.
3. Darle al rol una contraseña al azar que no quede en ningún lado: desde `psql` con la conexión de administrador,
   `ALTER ROLE servicio_datos LOGIN;` y después `\password servicio_datos` (la pide dos veces y solo manda el hash). No en el SQL
   Editor, que guarda las consultas.
4. Cargar los secretos desde un archivo, no en la línea de comandos (queda en el historial). El archivo, con permisos 600, que se
   borra al terminar:

   ```
   DATOS_CLAVE_CRON=<una clave larga al azar>
   DATOS_DATABASE_URL=postgresql://servicio_datos.<ref del proyecto>:<contraseña>@<host del pooler>:6543/postgres
   DATOS_AVISOS_SLACK_URL=<el webhook de Slack>
   DATOS_REVISION_URL=https://<chartbay>/base-de-datos/revision
   DATOS_MONITOR_COLECTA_URL=<opcional: un latido de Healthchecks para la colecta>
   DATOS_MONITOR_AVISAR_URL=<opcional: otro, para los avisos>
   ANTHROPIC_API_KEY=<la clave de la API de Claude, para el analista>
   DATOS_ANALISTA_MODELO=<opcional: el modelo; por defecto claude-opus-5-5>
   DATOS_MONITOR_ANALIZAR_URL=<opcional: otro latido, para el analista>
   ```

   ```bash
   supabase secrets set --env-file datos.env
   ```

5. Desplegarlas: `supabase functions deploy colectar-ipc --no-verify-jwt`, y lo mismo con `avisar` y `analizar`. Las protege
   `DATOS_CLAVE_CRON`, no la clave pública de Supabase (que tiene cualquiera). Si se arma `supabase/config.toml`: `verify_jwt = false`
   en `[functions.colectar-ipc]`, `[functions.avisar]` y `[functions.analizar]`.
6. **La prueba a mano**, antes de programarla. El endpoint es `POST https://<ref>.supabase.co/functions/v1/colectar-ipc` y la
   autenticación es el encabezado `x-chartbay-clave` con la `DATOS_CLAVE_CRON`. Con la clave en un archivo de encabezados, para que
   no aparezca en la línea de comandos (`x-chartbay-clave: <clave>`, permisos 600):

   ```bash
   curl -sS -X POST -H @encabezado-cron.txt https://<ref>.supabase.co/functions/v1/colectar-ipc
   ```

   Sale bien si: sin el encabezado contesta 401; la primera llamada contesta `{"estado":"con_candidato", ...}` con un
   `candidato_id` (en una base sin publicaciones); la segunda, `{"estado":"sin_cambios"}`; en `economia.corrida` quedan las dos
   corridas con esos estados; en `economia.descarga`, dos `nueva` y dos `identica`; y en el bucket `economia-crudos`, dos archivos.
   El candidato aparece en la cola de la página de revisión. Después, lo mismo con `analizar` y `avisar` (ver "El analista" y "Los
   avisos").
7. Recién entonces, programarlas con pg_cron (las horas van en UTC: 12:30 y 20:30 son las 9:30 y 17:30 de Argentina):

```sql
SELECT vault.create_secret('https://<proyecto>.supabase.co', 'project_url');
SELECT vault.create_secret('<la misma DATOS_CLAVE_CRON>', 'clave_cron');
SELECT cron.schedule('colectar-ipc', '30 12,20 * * *', $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/colectar-ipc',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-chartbay-clave', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'clave_cron')),
    body := '{}'::jsonb, timeout_milliseconds := 150000)
$$);
```

### Qué se verificó

Con Deno 2.9 en esta computadora: las pruebas de la función (cliente HTTP contra un servidor local, lector con libros armados y con
los archivos reales, y cada final posible de la colecta); que el lector de TypeScript arma **exactamente** la misma carga que el de
Python con los `.xls` reales; y la colecta de punta a punta contra Postgres **entrando como el rol de la colecta** (primera corrida:
candidato de 819 observaciones; segunda: sin cambios). Las corre `servicio_datos/tests/test_funciones_supabase.py`. Los permisos del
rol se prueban en `test_api_servicio.py`, incluso con los roles de la API de Supabase y permisos por defecto que les darían las
funciones nuevas; el search_path, en `test_search_path.py`.

**En Supabase** (Codex, 2026-10-08): sin la clave contesta 401; la primera llamada dejó `con_candidato` (corrida 1, candidato 1,
19 hallazgos, 819 observaciones) y la segunda `sin_cambios`; los dos originales quedaron en `economia-crudos`; y la misma llamada que
hace el cron (Vault → pg_net → la función → la base) contestó 200. Con eso quedaron comprobados el runtime de Edge Functions, Storage,
la conexión por el pooler de transacciones con el rol `servicio_datos` y pg_cron. Una cosa que apareció recién ahí: el empaquetador
de Supabase no baja código de una URL, así que SheetJS está copiado tal cual en `supabase/functions/_vendor/xlsx-0.20.3/` (con su
licencia Apache-2.0; una prueba comprueba que sea la copia oficial y que ninguna función importe de una URL). **Sigue sin probarse**:
una clave `sb_secret_…` con supabase-js (el proyecto usa la `SUPABASE_SERVICE_ROLE_KEY`).

## El analista (paso 6)

Para cada hallazgo sin decidir de un candidato abierto, el analista deja una propuesta: qué es, qué haría, con qué hechos y con qué
confianza. **Solo propone**: no decide hallazgos, no toca el candidato y no publica; la decisión de la persona resuelve la propuesta
y deja medido cuánto acertó.

La base hace todo lo que importa (migración 0015): elige los hallazgos pendientes, propone sin modelo lo que tiene un precedente (una
persona ya decidió sobre uno idéntico), reúne los hechos (`hechos_de`: el mismo trabajo que hacía `agente/evidencia.py`, con los
mismos textos) y, al guardar, valida lo que dijo el modelo (`validar_dictamen`, el mismo validador de `agente/dictamen.py`) contra los
hechos que vuelve a reunir ella. Quien llama al modelo solo le entrega a `proponer` lo que contestó: no puede inventar hechos ni
guardar una propuesta que no pasó por el validador. El analista de Python con modelo local usa estas mismas funciones.

`supabase/functions/analizar` es la Edge Function: llama a Claude con el SDK oficial (`@anthropic-ai/sdk` 0.128.0), con
*structured outputs* (`output_config.format`) para que la respuesta tenga siempre las claves y los valores permitidos, y el prompt en
caché. Lo que se le manda es el hallazgo y los hechos, todos datos públicos de INDEC; el prompt le dice que lo que viene en el pedido
son datos y no instrucciones, y aunque lo ignorara, el validador no deja pasar nada que los hechos no sostengan. Hace hasta tres
consultas a la vez, deja de empezar hallazgos a los 90 segundos (la función tiene 150) y lo que no llegó queda para la hora siguiente;
si la API falla tres veces seguidas, corta. Sin `ANTHROPIC_API_KEY` solo propone por precedente.

**Modelo y costo.** Por defecto `claude-opus-5-5` (USD 4 por millón de tokens de entrada y 20 de salida; el prompt en caché sale
mucho menos). Cada hallazgo son unos pocos miles de tokens, así que un candidato como el de septiembre (19 hallazgos) debería costar
del orden de un dólar, y con uno o dos candidatos por mes, poco más. Con `DATOS_ANALISTA_MODELO=claude-sonnet-5-5` cuesta la mitad.
Son estimaciones: el costo real se ve en la consola de Anthropic después de la primera corrida.

Para ponerla en marcha, además de lo de la colecta (mismo rol, misma clave, mismo archivo de secretos con `ANTHROPIC_API_KEY`): la
prueba a mano es `curl -sS -X POST -H @encabezado-cron.txt https://<ref>.supabase.co/functions/v1/analizar` con un candidato abierto.
Tiene que contestar cuántas propuestas dejó (`por_modelo`, `sin_respaldo`, `por_precedente`) sin `fallidos`, y en la página de
revisión cada hallazgo tiene que aparecer con su propuesta. La segunda vez no deja nada nuevo. Después, el cron (cada hora a los 35
minutos: cinco después de la colecta y antes del aviso de los 45; si no hay nada pendiente no consulta a la API):

```sql
SELECT cron.schedule('analizar', '35 * * * *', $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/analizar',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-chartbay-clave', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'clave_cron')),
    body := '{}'::jsonb, timeout_milliseconds := 150000)
$$);
```

Qué se verificó: que los hechos, el validador y el guardado en la base dan lo mismo que el analista de Python (sus ~80 pruebas, ahora
contra la base, más una comparación del validador con el de Python en 1.500 respuestas al azar); las pruebas de la función (orden,
concurrencia, límite de tiempo, fallos de la API) y del cliente de Claude con el SDK de verdad contra un servidor local que imita la
API (qué pide, structured outputs, caché, respuestas rechazadas o cortadas, errores sin la clave); y el analista de punta a punta
contra Postgres entrando con el rol de las Edge Functions, con un modelo falso. **No se probó**: la API real de Claude (no hay clave en
las pruebas), y por lo tanto cuánto acierta Claude con estos hallazgos, cuánto tarda y cuánto cuesta de verdad; tampoco el runtime de
Supabase ni pg_cron.

## Los avisos (paso 5)

Detectar es de la base (migración 0014): `detectar_avisos(hoy, ahora, dia_limite, recordatorio_dias)` mira el estado y anota en la
bandeja `aviso` lo que falte, con una clave única, así que se puede correr cuantas veces se quiera. Avisa, con los mismos textos que
antes: un candidato para revisar; recordatorios si sigue abierto (a los 3 días, a los 7, a los 14 y uno por semana); una corrida
fallida (una vez por racha); un dato que no llegó pasada la ventana del mes; la colecta parada hace dos días; y un respaldo fallido
o atrasado. Antes de entregar, `tomar_avisos` descarta lo que dejó de ser cierto (un candidato ya resuelto) y reserva el resto cinco
minutos, para que dos entregas a la vez no manden lo mismo dos veces y, si una se cae, otra lo retome; `registrar_entrega` anota
cómo le fue a cada canal y, después de cinco intentos, da el aviso por perdido. `avisos.py` usa estas mismas funciones, así que las
~60 pruebas de los avisos las cubren.

`supabase/functions/avisar` es la Edge Function: detecta, toma, manda por Slack y anota. Sin un canal configurado no hace nada (ni
siquiera detecta: si no, al configurar uno llegaría de golpe todo lo acumulado) y se lo dice al monitor. Lo que viene de la base
se escapa para que no pueda armar enlaces ni menciones (`<!channel>`), y ningún error repite el webhook. El enlace de cada aviso va
a la página de revisión de ChartBay con un ancla: `#candidato=<id>` o `#corrida=<id>` (la página puede usarla para abrir ese
candidato; si no la usa, abre la cola).

**Solo Slack.** El correo por SMTP no sale desde Supabase: las Edge Functions no pueden conectarse a los puertos 25 ni 587
([límites](https://supabase.com/docs/guides/functions/limits)). Si hace falta correo, va por la API HTTP de un proveedor.

Para ponerla en marcha, además de lo de la colecta (mismo rol, misma clave y mismo archivo de secretos, con `DATOS_AVISOS_SLACK_URL`
y `DATOS_REVISION_URL`): la prueba a mano es `curl -sS -X POST -H @encabezado-cron.txt https://<ref>.supabase.co/functions/v1/avisar`
después de la colecta de prueba. Tiene que contestar `"creados":1,"enviados":1` y llegar el aviso del candidato a Slack. La segunda
vez, `"creados":0,"enviados":0`. Después, el cron (cada hora a los 45 minutos, así un candidato nuevo avisa un cuarto de hora
después de la colecta):

```sql
SELECT cron.schedule('avisar', '45 * * * *', $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/avisar',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-chartbay-clave', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'clave_cron')),
    body := '{}'::jsonb, timeout_milliseconds := 60000)
$$);
```

Qué se verificó: que la detección en la base da lo mismo que daba Python (las pruebas de siempre, ahora contra la base); las
pruebas de la función (entrega por cada canal, reintentos, un canal que se rompe sin frenar al resto ni filtrar su error, el
enlace, la configuración) y del canal de Slack contra un servidor local (escape, corte, errores sin la URL, sin seguir
redirecciones); y los avisos de punta a punta contra Postgres entrando con el rol de las Edge Functions y un Slack local. En Supabase
(Codex, 2026-10-08) está desplegada y contesta `sin_canales: true`: falta el webhook de Slack, y el cron espera ese webhook y la
dirección pública de la página de revisión. **No se probó** el Slack de verdad. Los textos de los avisos del respaldo ya hablan del
flujo de GitHub (migración 0016).

## El respaldo (paso 7)

`.github/workflows/respaldo-datos.yml` corre todos los días a las 4:15 de Argentina (y a mano, desde Actions). Usa el mismo
`servicio_datos/respaldo.py` que se había hecho para el equipo Ubuntu:

1. Baja el bucket `economia-crudos` con la API S3 de Supabase Storage.
2. Vuelca el esquema `economia` con `pg_dump` 17 y un rol que solo puede leer y anotar sus corridas (`datos_respaldo`), sobre la misma
   foto de la base en la que cuenta las filas de cada tabla.
3. Verifica el crudo: cada archivo contra su hash, y que esté todo lo que nombra la base.
4. **Ensaya la restauración** en un PostgreSQL 17 descartable dentro de la misma corrida y compara tabla por tabla con lo volcado.
5. Empaqueta el volcado, su manifiesto y el crudo en un `.tar.gz` con un índice (`respaldo.json`), cifrado con age si hay clave pública,
   y lo guarda como artefacto de la corrida durante 7 días.
6. Anota la corrida en `economia.respaldo`: si falla, o si pasan dos días sin uno bueno (el flujo dejó de correr, se vencieron sus
   claves), `avisar` lo dice por Slack (migración 0016: los textos ahora hablan del flujo, no del equipo Ubuntu). GitHub además le
   avisa por correo de las corridas fallidas a quien cambió por última vez el horario del flujo.

**Tamaño y conservación.** El crudo comprimido son unos 0,9 MB por cada par de archivos nuevos de INDEC, así que cada paquete crece
unos 20 MB por año. Con 7 días de conservación, el total entra por varios años en los 500 MB de almacenamiento de Actions de un repo
privado gratuito. La historia de las decisiones está adentro de la base (lo publicado y las revisiones son de solo agregar), así que no
hace falta guardar volcados viejos: hace falta uno reciente que se pueda restaurar, y eso es lo que se ensaya cada día. Si algún día
no alcanza, se cambia `retention-days` o se separa el crudo.

**Quién ve el respaldo.** El repo es privado: los artefactos los ve solo quien tiene acceso. Adentro hay lo que no es público (candidatos,
hallazgos, decisiones, los correos de los revisores), por eso conviene cifrarlo: con `DATOS_RESPALDO_AGE_DESTINATARIO` puesto, el
paquete sale cifrado para esa clave pública y solo lo abre quien tenga la privada, aunque el repo se haga público o alguien entre a la
cuenta. La clave privada no la tiene GitHub: si se pierde, los paquetes cifrados no se pueden abrir.

### Para ponerlo en marcha (Codex o Juani)

1. **El rol**: correr en `psql` lo que imprime `python -m servicio_datos.respaldar sql-del-rol` (con la conexión de administrador, el
   mismo usuario que aplica las migraciones) y después `\password datos_respaldo`. Puede leer todo `economia` (también lo que creen
   las migraciones siguientes) y escribir solo en `respaldo`.
2. **Las claves S3 del bucket**: en la configuración de Storage del proyecto, la sección de conexión S3: activarla y crear un par de
   claves de acceso. Sirven solo para Storage, no para la base. Ahí mismo figuran el endpoint y la región.
3. **Los secretos y variables del repo**, sin que pasen por la línea de comandos (`gh secret set` pide el valor):

   ```bash
   gh secret set DATOS_RESPALDO_DATABASE_URL
   ```

   El valor es `postgresql://datos_respaldo.<ref>:<contraseña>@<host del pooler>:5432/postgres?sslmode=require`: el pooler en
   **modo sesión** (puerto 5432; `pg_dump` no anda en modo transacción) y no la conexión directa (en el plan gratuito es solo IPv6, y las
   máquinas de GitHub no tienen IPv6). Lo mismo con `SUPABASE_S3_ACCESS_KEY_ID` y `SUPABASE_S3_SECRET_ACCESS_KEY`. Las variables no
   son secretas: `gh variable set SUPABASE_S3_ENDPOINT --body https://<ref>.supabase.co/storage/v1/s3` y `gh variable set
   SUPABASE_S3_REGION --body <región>`.
4. **Recomendado, el cifrado**: `age-keygen -o chartbay-respaldo.key` en una computadora propia (con `brew install age`). Guardar ese
   archivo en un lugar seguro y fuera del repo, por ejemplo un gestor de contraseñas. La clave pública que imprime (`age1...`) va en
   `gh variable set DATOS_RESPALDO_AGE_DESTINATARIO --body age1...`.
5. **Arranca cuando el flujo llegue a `main`**: GitHub solo programa los flujos de la rama principal. La primera vez conviene correrlo a
   mano (Actions → "Respaldo de datos" → Run workflow). Sale bien si la corrida termina en verde con un artefacto
   `respaldo-datos-<número>`, y si en `economia.respaldo` hay una fila con `ok = true` y el ensayo en su `detalle`.

### Para restaurar

```bash
gh run download <número de corrida> -n respaldo-datos-<número de corrida>
age -d -i chartbay-respaldo.key -o respaldo.tar.gz respaldo-datos-*.tar.gz.age   # si va cifrado
tar -xzf respaldo.tar.gz
```

Quedan `respaldo.json` (qué hay y sus hashes), `base/economia-<fecha>.dump` con su manifiesto y `crudo/`. La base vuelve con `pg_restore
--no-owner --no-acl` en el proyecto nuevo, después de `CREATE EXTENSION IF NOT EXISTS btree_gist` (es lo que hace el ensayo de cada
día); después se reinstalan `api_revision`, `api_servicio` y los roles, que no van en el volcado del esquema. El crudo vuelve al bucket
con `aws s3 sync crudo/ s3://economia-crudos --endpoint-url <endpoint>`.

Qué se verificó: el respaldo, el ensayo, el empaquetado y que lo empaquetado se restaura, contra PostgreSQL 17 con `pg_dump` y
`pg_restore` 17 reales; una corrida armada igual que la del flujo (el crudo como descarga del bucket y el rol de la guía volcando y
anotando, sin ningún otro permiso); el cifrado con un age falso que comprueba cómo se lo llama; y que el flujo use lo que el código
espera (`test_respaldo.py`, `FlujoDeGitHubTests`). **No se probó**: el flujo en GitHub Actions, la API S3 de Supabase, `pg_dump` por el
pooler de Supabase, el age de verdad ni una restauración en un proyecto de Supabase.

## La copia pública de lo aprobado

Juani decidió que GitHub tenga una copia versionada de las series **aprobadas**, para consultarlas y descargarlas. Supabase sigue
siendo la fuente de verdad. `python -m servicio_datos.exportar --destino <carpeta>` (`exportacion.py`, migración 0017) arma esa copia:

```
catalogo.json                         los releases exportados y el vigente de cada fuente
releases/<release_id>/manifiesto.json la fuente, la licencia, de qué archivos salió y el SHA-256 de cada CSV
releases/<release_id>/<serie_id>.csv  fecha,valor (una fila por mes, la fecha como AAAA-MM-01)
```

Las claves de los manifiestos son las del catálogo del piloto que ya lee ChartBay (`id`, `name`, `unit`, `frequency`, `start`, `end`,
`count`, `sheet`, `source_row`, `normalization_notes`, y en `inputs`, `retrieved_at`, `http_last_modified` y `published_at`), así que
la página puede pasar a leer la copia publicada sin traducir nada. Para cada fuente, `catalogo.json` dice cuál es el release
vigente (`current`); ese release tiene su manifiesto, y el manifiesto, los CSV con su hash.

Lo que garantiza:

- **Solo sale lo publicado.** Nada de candidatos, hallazgos, decisiones, corridas ni crudo, y tampoco quién aprobó.
- **Exactamente lo que se aprobó.** Cada release se reconstruye tal cual quedó al publicarse (también los viejos), y antes de
  escribirlo se comprueba que dé el mismo hash de contenido que se aprobó. `python -m servicio_datos.exportar comprobar --destino
  <carpeta>` lo vuelve a verificar desde los CSV, sin la base: cualquiera puede comprobar que la copia es lo aprobado.
- **Nada a medias.** Un release se escribe en una carpeta temporal que recién al final toma su nombre, y el catálogo se arma al final
  con los releases completos y verificados. Si el último no pudo salir, el catálogo sigue anunciando el anterior.
- **Los releases no cambian.** Uno ya exportado no se reescribe: si no coincide con su manifiesto (alguien lo tocó), queda pendiente
  para que lo mire una persona.
- **Sin licencia revisada, no se redistribuye.** La fuente tiene que tener `licencia` y `atribucion` (columnas nuevas de `fuente`).
  Las completa una persona después de revisar los términos, por ejemplo:

  ```sql
  UPDATE economia.fuente SET licencia = '<licencia>', licencia_url = '<enlace a su texto>', atribucion = '<cómo citarla>'
  WHERE id = 'INDEC_IPC';
  ```

  Según la auditoría de Codex, el sitio de INDEC declara CC BY-SA 4.0. Si es así, la copia tiene que mantener esa licencia y citar
  la fuente, y para eso el manifiesto las lleva. Confirmarlo es parte de la revisión pendiente.
- **Seguro de repetir.** Lo que ya está no se toca; lo que no salió queda pendiente con su motivo y se reintenta en la corrida
  siguiente. Sale con código 1 si algo quedó pendiente.

Para leer la base sirve el rol de los respaldos (`datos_respaldo`), en `DATOS_EXPORTACION_DATABASE_URL`.

### Dónde se publica

Juani eligió su repositorio (2026-10-08): la copia vive en el de ChartBay, en `datasets/economia/publicado/`, al lado del catálogo del
piloto (`datasets/economia/catalogo.json`, que no se toca). Así ChartBay la sirve con cada deploy, sin claves ni pedidos a GitHub.

`.github/workflows/exportar-datos.yml` corre todos los días a las 5:00 de Argentina, después del respaldo, y a mano desde Actions.
Exporta lo que falte, comprueba la copia y hace commit en `main` **solo de esa carpeta y solo si cambió algo**
(`python -m servicio_datos.exportar subir`). No sube nada si hay otros cambios en el árbol o si la copia no pasa la comprobación, y si
`main` avanzó mientras tanto, rebasea y vuelve a subir. El mensaje del commit nombra los releases nuevos. Si un release queda
pendiente, lo que sí salió se sube igual y la corrida falla diciendo por qué. Usa el mismo secreto que el respaldo
(`DATOS_RESPALDO_DATABASE_URL`) y el permiso de escribir en el repo solo lo tiene ese trabajo.

Tres cosas a tener en cuenta:

- **El repo es privado**: la copia la ven ChartBay (y quien la use) y quien tenga acceso al repo, pero no cualquiera en GitHub. Si
  algún día se quiere pública en GitHub, se hace público el repo o se suma otro destino.
- **Cada commit de datos redespliega ChartBay en Render** (el push a `main` dispara el deploy). Pasa solo cuando hay un release
  nuevo, en la práctica una vez por mes.
- **Primero la licencia**: hasta que `fuente.licencia` y `fuente.atribucion` estén completas, el flujo falla todos los días diciendo
  que la fuente no tiene licencia revisada. Conviene completarlas antes de que el flujo llegue a `main`. Si es CC BY-SA, la página
  que muestre los datos tiene que citar la fuente y la licencia, que vienen en el manifiesto.

Qué se verificó: con releases publicados de verdad (pipeline, revisión y publicación) contra PostgreSQL, que sale cada release con sus
CSV y su manifiesto y que da el hash aprobado; la subida contra repositorios de git de verdad (un remoto y su clon: solo la carpeta,
nada sin novedades, no mezcla otros cambios, no sube una copia alterada, rebasea si `main` avanzó); que no sale nada sin publicar ni quién aprobó; que repetirlo no cambia ningún archivo;
que un release nuevo se suma sin tocar el anterior y que la historia completa sale aunque se exporte tarde; que el vigente es el
último publicado y no el que ordena primero o último por nombre; y lo que no debe pasar (sin licencia, un hash que no coincide, una
corrida cortada sin poder limpiar, una copia alterada, un manifiesto que apunta fuera de su carpeta). También que alcanza con el rol
de los respaldos. **No se probó**: el flujo en GitHub Actions (llega a correr cuando esté en `main`) ni contra la base de Supabase.

## Reparto con Codex (aprobado por Juani)

- **Claude**: las funciones SQL (pasos 1, 2 y la detección de avisos) con pruebas contra Postgres, y las Edge Functions (3, 5 y 6)
  con pruebas de su lógica.
- **Codex**: el proyecto de Supabase (extensiones, bucket, Vault, pg_cron, roles y exponer el esquema `revision`), Supabase Auth y
  la página de revisión en ChartBay (paso 4), que es la parte de `quantbay/src/database` y `web/` en la que ya trabaja.
