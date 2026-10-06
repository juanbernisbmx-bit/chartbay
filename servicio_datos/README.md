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

## Lo que la base garantiza

- `descarga` y `release` son de solo agregar (ni UPDATE, ni DELETE, ni TRUNCATE).
- Una `observacion` solo se puede cerrar fijando `release_hasta`; nunca se corrige
  ni se borra. Una corrección es una versión nueva.
- Dos versiones del mismo dato no pueden estar vigentes en el mismo release.
- Un valor faltante es una fila que no existe, no un NULL ni un cero.
- Una propuesta no se aprueba sin evidencia ni se rechaza sin comentario, y una
  vez decidida no cambia.
- Una descarga fallida explica el error; una lograda tiene hash, tamaño y ruta.

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

Para migrar una base real:

```bash
DATOS_DATABASE_URL=postgresql://... ./.venv/bin/python -m servicio_datos.migrar
```

## Lo que todavía no hay

- La función que publica un candidato (cierra versiones, abre las nuevas, crea el
  release y marca el candidato). Es el paso 4 del orden de construcción; hoy el
  esquema solo protege las tablas.
- Colector, parser y validación del IPC (pasos 2 y 3).
- Los tests no corren en CI todavía: faltaría un servicio PostgreSQL en el
  workflow.
