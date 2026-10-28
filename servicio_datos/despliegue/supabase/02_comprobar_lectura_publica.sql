-- Ejecutar despues de 01_instalar_lectura_publica.sql.
-- Solo consulta configuracion y datos ya publicados.
SELECT version, nombre, checksum
FROM economia.schema_migrations
WHERE version IN ('0013', '0014', '0017')
ORDER BY version;

SELECT
  to_regprocedure('public.catalogo_economico_publicado()') AS funcion,
  has_function_privilege('anon', 'public.catalogo_economico_publicado()', 'EXECUTE') AS anon_puede_leer,
  has_function_privilege('authenticated', 'public.catalogo_economico_publicado()', 'EXECUTE') AS authenticated_puede_leer;

-- Esta llamada debe funcionar como visitante, no solo como administrador.
BEGIN;
SET LOCAL ROLE anon;
SELECT public.catalogo_economico_publicado() AS catalogo_publico;
ROLLBACK;

-- Explica por que una fuente puede no aparecer: requiere release, licencia y atribucion.
SELECT f.id, f.nombre, r.release_id,
       nullif(btrim(f.licencia), '') IS NOT NULL AS tiene_licencia,
       nullif(btrim(f.atribucion), '') IS NOT NULL AS tiene_atribucion
FROM economia.fuente f
LEFT JOIN economia.publicado_release r ON r.fuente_id = f.id
ORDER BY f.id;
