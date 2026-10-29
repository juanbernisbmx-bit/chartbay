-- Mejora de lectura sobre la instalación existente; conserva datos y permisos.
BEGIN;
CREATE INDEX IF NOT EXISTS observacion_vigente_catalogo ON economia.observacion(serie_id,periodo) WHERE release_hasta IS NULL;
CREATE OR REPLACE FUNCTION public.buscar_series_economicas(
  p_texto text DEFAULT '',p_tema text DEFAULT '',p_cobertura text DEFAULT '',p_pagina integer DEFAULT 1,p_frecuencia text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = economia, pg_temp AS $$
DECLARE respuesta jsonb;
BEGIN
  IF p_pagina IS NULL OR p_pagina<1 OR p_pagina>100000 OR length(coalesce(p_texto,''))>200
     OR length(coalesce(p_tema,''))>100 OR length(coalesce(p_cobertura,''))>100 OR coalesce(p_frecuencia,'') NOT IN ('','Diaria','Mensual','Anual') THEN
    RAISE EXCEPTION 'Filtros o página inválidos' USING ERRCODE='22023';
  END IF;
  WITH elegidas AS MATERIALIZED (
    SELECT s.* FROM serie s WHERE NOT (SELECT activo FROM catalogo_curado_config WHERE id)
      OR EXISTS(SELECT 1 FROM catalogo_curado c WHERE c.serie_id=s.id AND c.incluida)
  ), disponibles AS MATERIALIZED (
    SELECT s.id,s.nombre,s.tema,s.nivel,s.territorio,s.frecuencia,f.nombre AS fuente
    FROM elegidas s JOIN fuente f ON f.id=s.fuente_id JOIN publicado_release r ON r.fuente_id=f.id
    WHERE nullif(btrim(f.licencia),'') IS NOT NULL AND nullif(btrim(f.atribucion),'') IS NOT NULL
      AND serie_en_catalogo(s.id,(SELECT max(periodo) FROM publicado_observaciones o WHERE o.serie_id=s.id))
  ), filtradas AS MATERIALIZED (
    SELECT * FROM disponibles WHERE (coalesce(p_texto,'')='' OR
      position(lower(p_texto) IN lower(concat_ws(' ',nombre,territorio,fuente,id)))>0)
      AND (coalesce(p_frecuencia,'')='' OR frecuencia=p_frecuencia) AND (coalesce(p_tema,'')='' OR tema=p_tema) AND (coalesce(p_cobertura,'')='' OR nivel=p_cobertura)
  ), pagina AS (
    SELECT id,nombre FROM filtradas ORDER BY nombre,id LIMIT 50 OFFSET (p_pagina-1)*50
  )
  SELECT jsonb_build_object('schema_version',1,'source','supabase','paginated',true,
    'release_id','Publicaciones vigentes','page',p_pagina,'page_size',50,
    'total',(SELECT count(*) FROM filtradas),'catalog_total',(SELECT count(*) FROM disponibles),
    'frequencies',coalesce((SELECT jsonb_agg(t ORDER BY t) FROM (SELECT DISTINCT frecuencia t FROM disponibles) a),'[]'::jsonb),
    'topics',coalesce((SELECT jsonb_agg(t ORDER BY t) FROM (SELECT DISTINCT tema t FROM disponibles WHERE tema IS NOT NULL) a),'[]'::jsonb),
    'levels',coalesce((SELECT jsonb_agg(t ORDER BY t) FROM (SELECT DISTINCT nivel t FROM disponibles WHERE nivel IS NOT NULL) a),'[]'::jsonb),
    'series',coalesce((SELECT jsonb_agg(ficha_serie_publicada(id,false) ORDER BY nombre,id) FROM pagina),'[]'::jsonb)) INTO respuesta;
  RETURN respuesta;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
ANALYZE economia.observacion;
