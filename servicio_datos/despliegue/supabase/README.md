# Conectar la lectura pública de Supabase con ChartBay

Estos archivos resuelven el paso de SQL del proyecto existente de ChartBay.
Se ejecutan en **Supabase → proyecto `oqbqdngieifjlgbppvey` → SQL Editor**, con el
rol `postgres`. No contienen claves ni requieren pegarlas en el editor.

1. Abrir `01_instalar_lectura_publica.sql`, copiar **todo** y ejecutar con **Run**.
2. Ejecutar `02_comprobar_lectura_publica.sql` para comprobar los permisos y la
   respuesta con el rol público `anon`.

El instalador contiene la migración `0017_exportacion.sql` y
`servicio_datos/api_publica.sql`. Aplica 0017 solo si falta y guarda exactamente
el checksum del archivo original en `economia.schema_migrations`. Si ya está
registrada con el mismo checksum, la conserva; si el checksum difiere, se detiene.
Instala o actualiza la función pública y solicita recargar la caché de PostgREST.
Todo se confirma en una transacción después de comprobar que `anon` puede leer.

Requiere el esquema económico existente, sus vistas de lectura y el procedimiento
de la migración 0013. No necesita las migraciones 0015 y 0016: sus funciones del
analista y de avisos no intervienen en esta lectura. Pueden aplicarse después con
el migrador habitual, que reconocerá 0017 como ya instalada.

## Resultado esperado

`anon_puede_leer` y `authenticated_puede_leer` deben ser `true`. La respuesta de
`catalogo_publico` debe tener `schema_version: 1` y la lista `sources`.

`sources: []` significa que la función funciona, pero aún no hay un release
elegible. Una fuente necesita un release aprobado, licencia y atribución para
aparecer. El segundo script muestra esos tres requisitos. No completa licencias,
no publica candidatos ni programa ejecuciones del agente.

Si aparece un error de precondiciones o de checksum, conservar el mensaje y
revisar el esquema existente; no borrar tablas ni el historial de migraciones.

## Lo que sigue fuera de SQL

Estos scripts instalan la lectura en Supabase. También falta desplegar el lector
de ChartBay y activar `CHARTBAY_DATABASE_MODE=published` cuando exista un release
elegible y su copia de respaldo. No importan la base masiva SQLite a Supabase.

Referencia: [caché de esquema de PostgREST](https://docs.postgrest.org/en/stable/references/schema_cache.html).

## Validación local

`python -m unittest servicio_datos.tests.test_instalacion_lectura_publica -v`
crea su propio PostgreSQL temporal mediante `initdb`, `pg_ctl` y `psql`, sin
conectarse a Supabase. Comprueba actualización desde 0014, repetición sin cambios,
lectura pública restringida a lo publicado, aplicación posterior de 0015/0016,
rechazo de checksums distintos y reversión completa ante un fallo de instalación.
