# Servicio de datos

Base PostgreSQL de ChartBay para la actualización automática con revisión. El
diseño completo está en `docs/base-datos-actualizacion.md`; este directorio
implementa el primer paso de su orden de construcción: crudo inmutable y
observaciones versionadas.

Es independiente de `web/`: no importa nada de la app y sus dependencias no van
en el `requirements.txt` de la raíz (la web no usa base de datos y corre en el
plan gratuito de Render). La idea es que pueda separarse a su propio servicio sin
cambios.

## Qué hay

- `migraciones/0001_esquema_inicial.sql`: tablas, restricciones y triggers.
- `migrar.py`: aplica las migraciones numeradas, cada una en su transacción, con
  checksum. Una migración ya aplicada no se edita: se agrega una nueva.
- `tests/test_esquema.py`: pruebas de que la base misma sostiene las reglas.
- `colector.py`, `colectar.py`, `cliente_http.py`, `crudo.py`, `repositorio.py`: el
  colector del IPC. Baja los archivos de INDEC, los guarda sin modificar (nombre
  = hash del contenido) y registra qué vio en cada corrida. No interpreta los
  datos: eso es del parser.
- `pipeline.py`, `ejecutar.py`: el orquestador. Corre colecta, parseo, validación y
  deja un candidato abierto, o cierra la corrida como `sin_cambios` o `fallida`.
  Recibe el parser y la validación por parámetro.
- `avisos.py`, `canales.py`, `avisar.py`: los avisos por Slack o correo. Ver "Avisos".
- `respaldo.py`, `respaldar.py`: el respaldo diario de la base y del crudo. Ver "Respaldos".
- `monitor.py`, `latido.py`: el latido hacia un monitor externo. Ver "El latido".
- `tarea.py` y `despliegue/`: cómo se instala todo en el equipo Ubuntu: el lanzador de las tareas de cron y los archivos de
  cron, systemd, HTTPS (Caddy), secretos y registros. La guía es `docs/despliegue-servicio-datos.md`.
- `agente/`: el analista de hallazgos, con un modelo de lenguaje local. Ver "El analista".
- `revision/`: la interfaz web de revisión (cola de candidatos y pantalla de revisión). Es una app
  Flask aparte de la web pública de ChartBay, con login. Ver "Interfaz de revisión".
- `../supabase/functions/`: las Edge Functions (la colecta del IPC, `colectar-ipc`). Se prueban desde
  `tests/test_funciones_supabase.py` (necesita Deno). Ver `docs/base-datos-supabase.md`.
- `carga.py`: la validación del IPC y la carga del candidato, que están en la base (migración 0011), desde Python.
- `api_revision.py`: el esquema `revision` que ve la página de revisión de ChartBay, con sesión de Supabase Auth. Ver
  `docs/base-datos-supabase.md`.
- `publicacion.py`, `publicar.py`: la revisión y la publicación de un candidato (la lógica está en funciones de la base,
  migración 0010; este módulo las llama). Publicar es
  la única forma de que un dato llegue a lo vigente, y exige que cada hallazgo esté aceptado.
  `publicar.py` es el comando para revisar desde la terminal hasta que exista la interfaz.
- `ipc/fuente.py`, `ipc/modelos.py`: qué archivos trae el IPC, cómo se describen
  sus series y los tipos que pasan entre colector, parser y validación.
- `COORDINACION.md`: reparto del trabajo entre Claude y Codex y contrato.

## Avisos

Un sistema que se supone silencioso no puede callar cuando algo pasa. Avisa por Slack, por correo o por
los dos de cinco cosas, y de cada una una sola vez:

- **Un candidato para revisar.** Con los números que importan (períodos nuevos, datos ya publicados que
  cambian) y el enlace a la pantalla de revisión; lleva `[Atención]` si cambia algo ya publicado o tiene un
  hallazgo de severidad alta.
- **Que ese candidato sigue abierto**, días después: recordatorios a los 3 días, a los 7, a los 14 y desde ahí
  uno por semana, cada hito una sola vez. Dicen en qué punto está (cuántos hallazgos faltan, si está listo para
  publicar o si tiene rechazados y hay que descartarlo) y, desde los 14 días, llevan `[Atención]`. Si el sistema
  estuvo apagado manda solo el hito más alto, no los atrasados de golpe. Se detienen cuando el candidato se publica,
  se descarta o lo reemplaza uno más nuevo.
- **Una corrida fallida sin resolver**, con su error. Una vez por racha: si el cron sigue fallando no
  repite, y vuelve a avisar recién después de que una corrida termine bien.
- **Que pasó la ventana del mes sin el dato** (el mismo día límite que la regla de frescura de la
  validación). No avisa si lo publicado, o un candidato abierto, ya lo cubre.
- **Que el colector no corre hace días.** Sin esto, un cron muerto lo silenciaría todo.

```bash
# Canales (los que falten, no se usan; sin ninguno no hace nada ni acumula avisos)
export DATOS_AVISOS_SLACK_URL='https://hooks.slack.com/services/...'   # es una credencial
export DATOS_AVISOS_SMTP_HOST=smtp.example.com DATOS_AVISOS_SMTP_PUERTO=587
export DATOS_AVISOS_SMTP_USUARIO=... DATOS_AVISOS_SMTP_CLAVE=...
export DATOS_AVISOS_DE=datos@example.com DATOS_AVISOS_PARA='juani@example.com,ana@example.com'
export DATOS_REVISION_URL=https://revision.example.com                  # para los enlaces
export DATOS_AVISOS_RECORDATORIO_DIAS=3                                 # primer recordatorio; 0 los apaga (por defecto 3)

./.venv/bin/python -m servicio_datos.migrar          # crea la tabla de avisos y el tipo de recordatorio (0005 y 0006)
./.venv/bin/python -m servicio_datos.avisar probar   # un mensaje de prueba por cada canal
./.venv/bin/python -m servicio_datos.avisar          # detecta y entrega
./.venv/bin/python -m servicio_datos.avisar estado   # los últimos avisos y cómo les fue
```

`ejecutar` ya procesa los avisos al terminar cada corrida si hay canales configurados, y un fallo de
los avisos nunca cambia el resultado de la corrida. **Pero `avisar` también tiene que correr desde otro
lado**, con su propio cron (cada pocas horas): los avisos de "no llegó el dato" y "el colector no corre"
los detecta quien mira desde afuera, y si el único que mira es el mismo cron que murió, no avisa nadie.

- **Se registran antes de entregarse** (bandeja de salida): un Slack caído no pierde nada, se reintenta en la
  corrida siguiente (hasta 5 veces; `avisar estado` muestra los que se rindieron) y nunca se repite. Con dos
  canales, uno roto no hace que el otro repita. Antes de entregar se vuelve a comprobar que siga siendo cierto:
  un candidato que ya se resolvió, o un dato que ya llegó, descartan el aviso en vez de molestar tarde.
- **Los secretos no salen nunca.** Una falla de entrega se describe con su tipo y su código; la URL de Slack y la
  clave del correo no aparecen en errores, registros ni mensajes. Slack solo acepta `https://hooks.slack.com` y no
  sigue redirecciones; el correo sin cifrado solo se admite contra un servidor local.
- **Lo que viene de la base no es de confianza.** En Slack se escapa para que un error no pueda armar enlaces ni
  `@channel`; en el correo se limpia el asunto para que no pueda inyectar cabeceras.

## Interfaz de revisión

La cola de candidatos y la pantalla para revisarlos y publicarlos (`revision/`). Es una app aparte de
la web pública de ChartBay porque **escribe** (acepta, rechaza, publica, descarta): la web no tiene
login y se conecta con un rol de solo lectura. Necesita una URL de PostgreSQL con permiso de escritura
sobre el servicio (la misma de `DATOS_DATABASE_URL`).

```bash
# 1. Una línea de usuario=hash por cada revisor (pide la contraseña, mínimo 12 caracteres)
./.venv/bin/python -m servicio_datos.revision clave juani

# 2. Probarla en este equipo (solo escucha en 127.0.0.1)
export DATOS_DATABASE_URL=postgresql://...
export DATOS_REVISORES='juani=scrypt:...'     # varios, separados por ;
./.venv/bin/python -m servicio_datos.revision servir

# En producción: gunicorn escuchando SOLO en 127.0.0.1, detrás de un proxy con HTTPS (Basic manda la clave en cada
# pedido) y con DATOS_REVISION_PROXY=1. Ver docs/despliegue-servicio-datos.md.
gunicorn "servicio_datos.revision.__main__:app_desde_entorno()" --bind 127.0.0.1:8000 --workers 1 --threads 4
```

- **Quién es el revisor:** el usuario con el que se inició sesión. Queda registrado en cada decisión y en el
  release; el formulario no puede poner otro nombre.
- **Protecciones:** todo exige login (salvo `/salud`); cada formulario lleva un token y se rechaza un POST de
  otro origen; los intentos de acceso fallidos se frenan (5 en 5 minutos por usuario y dirección); las
  respuestas no se guardan en caché y llevan una política de contenido que no admite scripts. Funciona sin
  JavaScript. `Referrer-Policy` es `same-origin` a propósito: con `no-referrer` el navegador manda
  `Origin: null` en los formularios propios y el chequeo de origen rechazaría a todos.
- **La cola:** candidatos esperando revisión, corridas fallidas sin resolver (una falla deja de aparecer
  cuando una corrida posterior de la fuente termina bien) e historial. Las corridas sin cambios no generan
  filas. Reintentar una corrida fallida es manual.
- **La revisión:** qué cambia respecto de lo vigente, los archivos de la corrida y los hallazgos agrupados por
  regla, con un gráfico de la serie en cada uno (lo vigente, en punteado, si difiere). Se acepta o rechaza
  uno por uno (rechazar exige un motivo), o se aceptan de una vez los pendientes de un grupo o todos. Publicar
  y descartar están al final; un candidato ya cerrado se ve sin formularios. Si la base no responde, muestra un
  mensaje claro sin datos de la conexión.
- **Las propuestas del analista:** junto a cada hallazgo se ve qué propone (aceptar, rechazar o que lo mires), la
  clasificación y la confianza; al abrirlo, el razonamiento, los hechos en que se apoya y lo que corrigió el validador. No hay
  botones para decidir la propuesta: la persona decide el hallazgo, y esa decisión resuelve la propuesta (ver "El analista").

## El analista

`python -m servicio_datos.agente` (`analizar`, `probar` y `estado`; es una tarea de cron más) deja, junto a cada hallazgo de un
candidato abierto, una `propuesta` con qué es, qué haría, con qué hechos y con qué confianza. **Solo escribe propuestas**: no decide
hallazgos, no toca el candidato y no publica. Diseño y operación: `docs/despliegue-servicio-datos.md` (sección 7).

- **Por qué se puede confiar sin confiar en el modelo.** El modelo no consulta nada: recibe una lista numerada de hechos que
  comprobó el código (`agente/evidencia.py`: comparación con las demás series del mes, con el mes siguiente, con lo ya publicado
  y con las fechas de los archivos) y solo puede citarlos. El validador (`agente/dictamen.py`) descarta citas inexistentes, exige para
  cada clasificación un hecho de la clase que la sostiene (no puede decir "error de carga" si el salto no resultó aislado ni se
  revirtió), pide coherencia entre clasificación y acción, y no deja subir la confianza más de lo que la evidencia permite. Lo que
  corrige queda en `propuesta.notas`.
- **El modelo corre en la misma computadora** (`agente/modelo.py`): Ollama, llama.cpp o cualquier servidor con la API de chat de
  OpenAI. Sin claves, y solo acepta `localhost`: lo analizado no sale del equipo. Sin `DATOS_AGENTE_MODELO` no se usa modelo, y solo se
  repiten decisiones previas de las personas sobre hallazgos idénticos (`origen = 'precedente'`).
- **Seguro de repetir.** Un hallazgo con propuesta no se vuelve a analizar; uno decidido por una persona se saltea (lo exige un trigger);
  un candidato que se cierra mientras el modelo piensa se abandona. Si el servidor del modelo no está, no se escribe nada de ese
  hallazgo, se corta tras tres fallos seguidos y se reintenta en la corrida siguiente.
- **Se mide.** La decisión de la persona sobre el hallazgo resuelve la propuesta (aprobada si coincide con lo que proponía, rechazada
  si decidió distinto); `agente estado` dice cuánto coincidió. `agente probar` pasa cinco casos de respuesta conocida por el mismo
  prompt y validador y dice cuántos clasificó bien: es la forma de elegir un modelo.
- **Lo que no se probó:** nunca corrió con un modelo real. Las pruebas usan un servidor falso con el mismo protocolo; sirven para el
  código, no para saber si un modelo concreto razona bien. Eso lo dice `agente probar`, en el equipo, con el modelo elegido.

## Respaldos

`python -m servicio_datos.respaldar` (cada día a las 3:15; también `estado`, `ensayar`, `restaurar-crudo` y `sql-del-rol`) guarda en
`DATOS_RESPALDO_DIR`, que tiene que estar en otro disco:

- **La base**: `pg_dump` del esquema del servicio con un rol de solo lectura (`datos_escritura` no puede leer `schema_migrations`, a
  propósito). Las filas de cada tabla se cuentan en la misma foto que se vuelca (`pg_export_snapshot`) y van a un manifiesto junto al
  volcado. Comprueba que `pg_dump` sea de la versión del servidor o más nuevo, y que el volcado se pueda leer y traiga cada tabla.
- **El crudo**: copia lo nuevo y, en cada corrida, verifica todo (original y copia) recalculando el hash que es el nombre de cada
  archivo. Repone copias dañadas, avisa originales dañados o que faltan (contra lo que nombra `descarga`) y no borra nunca nada de la
  copia. `restaurar-crudo` devuelve lo perdido.
- **El ensayo**: si hay una base local dedicada (`DATOS_RESPALDO_ENSAYO_URL`), restaura cada volcado y compara tabla por tabla. Se niega
  a usar una base que no sea de este equipo o que sea la del servicio, y solo borra el esquema que creó él mismo.
- **Se vigila desde la base**: cada corrida deja una fila en `respaldo` (migración 0009). `avisar` avisa si una falla o si pasan dos
  días sin un respaldo bueno, aunque el cron ya no corra.
- **No crea la carpeta de destino**: si el disco no está montado, falla y avisa en vez de escribir en el disco del sistema.
- La clave nunca va en la línea de comandos de `pg_dump` (la vería cualquier usuario con `ps`): va por el entorno del proceso.

Instalación y restauración: `docs/despliegue-servicio-datos.md`, sección 8. Probado contra PostgreSQL 17 local con `pg_dump` y
`pg_restore` reales; **no** contra Supabase.

## El latido

Lo que corre en el equipo no puede avisar que el equipo se cayó. `python -m servicio_datos.latido` (cada 10 minutos; también `estado`
y `probar`) le avisa a un servicio de afuera (Healthchecks.io o compatible, en `DATOS_MONITOR_URL`) que el equipo sigue vivo; si los
latidos dejan de llegar, avisa ese servicio. Antes de latir comprueba `/salud` en el equipo y por HTTPS (con el vencimiento del
certificado), la base, que los avisos se estén entregando, que cron haya corrido cada tarea a tiempo (lo lee de los archivos de estado
que deja `tarea.py`, sin depender de la base) y el espacio y el montaje de los discos. Si algo falla, late a `/fail` con el detalle.
Una comprobación que se rompe es una falla más: nunca impide el latido. Guía: `docs/despliegue-servicio-datos.md`, sección 9.
Probado contra servidores locales; **no** contra Healthchecks.io de verdad.

## Cómo lee ChartBay lo publicado

La web (rama `codex/base-datos-chartbay`) no lee las tablas: lee dos vistas, que son el contrato.

- `publicado_release`: el release vigente de cada fuente (`fuente_id`, `numero`, `release_id`,
  `publicado_en`, `hash_contenido`, `procedencia`).
- `publicado_observaciones`: sus datos (`fuente_id`, `serie_id`, `periodo`, `valor`).

`procedencia` queda congelada en el release al publicar: los archivos que lo respaldan (URL,
hash, fecha de captura y de publicación según la fuente) y de dónde salió cada serie (hoja,
fila y notas de normalización). Una prueba fija las columnas de las vistas: si cambian, hay que
cambiar la web.

La web se conecta con un rol que solo ve esas dos vistas. Las vistas corren con los permisos de
su dueño, así que el rol no necesita ni tiene acceso a las tablas:

```sql
CREATE ROLE chartbay_lectura LOGIN PASSWORD '...';
GRANT SELECT ON publicado_release, publicado_observaciones TO chartbay_lectura;
```

Con ese rol se verificó que puede leer las vistas y que leer `release` u `observacion`, o
escribir en cualquier tabla, da "permission denied". La URL va en `CHARTBAY_DATABASE_URL` de la
web; sin ella, o si la base no responde, ChartBay sirve el archivo del piloto.

## Lo que la base garantiza

- `descarga` y `release` son de solo agregar (ni UPDATE, ni DELETE, ni TRUNCATE).
- Una `observacion` solo se puede cerrar fijando `release_hasta`; nunca se corrige
  ni se borra. Una corrección es una versión nueva.
- Dos versiones del mismo dato no pueden estar vigentes en el mismo release.
- Un valor faltante es una fila que no existe, no un NULL ni un cero.
- Una propuesta no se aprueba sin evidencia ni se rechaza sin comentario, y una
  vez decidida no cambia.
- Una descarga fallida explica el error; una lograda tiene hash, tamaño y ruta.
- Las revisiones de hallazgos son un registro de solo agregar: una decisión se cambia
  con otra (vale la última) y solo se revisan hallazgos de un candidato abierto.

Los datos tal como estaban en el release `N`:
`release_desde <= N AND (release_hasta IS NULL OR release_hasta > N)`.

## Probarlo en local

Necesita PostgreSQL 15 o más nuevo con la extensión `btree_gist` (viene en el
paquete estándar).

```bash
python3 -m venv .venv
./.venv/bin/pip install -r servicio_datos/requirements.txt
```

Un clúster descartable, sin instalarlo como servicio (macOS con Homebrew):

```bash
export LC_ALL=en_US.UTF-8
initdb -D /tmp/chartbay-pg -U postgres --auth=trust -E UTF-8
pg_ctl -D /tmp/chartbay-pg -o "-p 54329 -c unix_socket_directories='' -c listen_addresses=127.0.0.1" -l /tmp/chartbay-pg.log -w start
```

Sin `LC_ALL`, Postgres no arranca en macOS ("postmaster became multithreaded").

```bash
DATOS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/postgres \
  ./.venv/bin/python -m unittest servicio_datos.tests.test_esquema
```

Cada test crea su propio schema y lo borra al terminar. Sin la variable, los
tests se saltean.

Las pruebas que corren el parser y la validación sobre los archivos reales de INDEC necesitan
`DATOS_IPC_ORIGINALES_DIR` apuntando a una carpeta con `sh_ipc_08_26.xls`, `sh_ipc_09_26.xls` y
`sh_ipc_aperturas.xls` (pesan 2,3 MB y no se versionan); sin ella se saltean.

Para migrar una base real y correr el colector:

```bash
export DATOS_DATABASE_URL=postgresql://...
export DATOS_CRUDO_DIR=/ruta/al/crudo
./.venv/bin/python -m servicio_datos.migrar
./.venv/bin/python -m servicio_datos.ejecutar ipc   # corrida completa hasta el candidato
./.venv/bin/python -m servicio_datos.colectar ipc   # solo la descarga
```

Después, con el candidato que dejó `ejecutar` (el comando lo imprime):

```bash
./.venv/bin/python -m servicio_datos.publicar estado 1
./.venv/bin/python -m servicio_datos.publicar aceptar 1 --por juani --comentario "Revisado"
./.venv/bin/python -m servicio_datos.publicar publicar 1 --por juani
```

`aceptar` sin `--hallazgo` acepta todos los que faltan; `rechazar` exige el hallazgo y un
motivo; `descartar` rechaza el candidato entero. `publicar` falla, y dice por qué, si falta
resolver algún hallazgo, si hay uno rechazado o si el candidato ya no está abierto.

`ejecutar` usa el parser y la validación del IPC (`ipc/parser.py` y `ipc/validacion.py`, con
`xlrd`). Sale con código 1 si la corrida falló. Sus decisiones están en `docs/base-datos-actualizacion.md`.

`colectar` imprime un resumen en JSON y sale con código 1 si la corrida falló,
para que el cron dispare la alerta. Los estados: `sin_cambios` (todo igual a lo
ya conocido), `nuevos_datos` (la corrida queda `en_curso` esperando al parser) y
`fallida`. Si ya hay una corrida en curso, no abre otra.

La carpeta del crudo es de solo agregar y debe ser persistente: el disco de
Render free se borra en cada deploy, así que en producción hace falta un
disco persistente o almacenamiento de objetos (cambia solo `crudo.py`).

## Lo que todavía no hay

- El catálogo completo en PostgreSQL: hoy solo están las siete series del IPC, así que ChartBay
  sigue tomando del JSON las otras 93 entradas (que no tienen datos).
- Un modelo real probado con el analista: ver "El analista". Y que el analista corrija con una propuesta de valor: hoy
  solo aconseja aceptar, rechazar o mirar; nunca propone un valor distinto.
- Pruebas en el equipo Ubuntu de lo desplegado (systemd, cron, Let's Encrypt, Supabase, el respaldo por el pooler y restaurar en
  Supabase): ver `docs/despliegue-servicio-datos.md`.
- Una copia de los respaldos fuera del equipo (protege del robo o un incendio, no solo de un disco roto).
- Los tests no corren en CI todavía: faltaría un servicio PostgreSQL en el
  workflow.
