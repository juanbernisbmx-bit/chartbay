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
- `revision/`: la interfaz web de revisión (cola de candidatos y pantalla de revisión). Es una app
  Flask aparte de la web pública de ChartBay, con login. Ver "Interfaz de revisión".
- `publicacion.py`, `publicar.py`: la revisión y la publicación de un candidato. Publicar es
  la única forma de que un dato llegue a lo vigente, y exige que cada hallazgo esté aceptado.
  `publicar.py` es el comando para revisar desde la terminal hasta que exista la interfaz.
- `ipc/fuente.py`, `ipc/modelos.py`: qué archivos trae el IPC, cómo se describen
  sus series y los tipos que pasan entre colector, parser y validación.
- `COORDINACION.md`: reparto del trabajo entre Claude y Codex y contrato.

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

# En producción, con un servidor de verdad y siempre detrás de HTTPS (Basic manda la clave en cada pedido):
gunicorn "servicio_datos.revision.__main__:app_desde_entorno()" --bind 0.0.0.0:$PORT
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
- **Sin agente todavía:** las propuestas del agente se muestran si existen y frenan la publicación, pero no hay
  botones para decidirlas porque el agente no está conectado.

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
- Decidir las propuestas del agente desde la interfaz (el agente no está conectado).
- Un aviso (mail o Slack) cuando entra algo a la cola o pasa la ventana del mes sin datos.
- Una ventana de ejecución: el colector corre una vez cuando lo llaman; el cron
  que lo dispara dentro de la ventana de publicación del mes no existe todavía.
- Los tests no corren en CI todavía: faltaría un servicio PostgreSQL en el
  workflow.
