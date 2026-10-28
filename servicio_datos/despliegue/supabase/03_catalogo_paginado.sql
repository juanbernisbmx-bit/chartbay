-- Extensión idempotente del contrato público. Solo releases aprobados y fuentes
-- con licencia/atribución. El catálogo no transporta observaciones.
BEGIN;

CREATE OR REPLACE FUNCTION economia.ficha_serie_publicada(p_id text, p_valores boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = economia, pg_temp AS $$
  SELECT jsonb_build_object(
    'id',s.id,'name',s.nombre,'topic',coalesce(s.tema,''),'level',coalesce(s.nivel,''),
    'territory',coalesce(s.territorio,''),'classification',coalesce(s.clasificacion,''),
    'frequency',s.frecuencia,'unit',coalesce(s.unidad,''),'basis',coalesce(s.base,''),
    'source_id',f.id,'source',f.nombre,'source_url',coalesce(f.url_base,''),
    'release_id',r.release_id,'pending','','available',true,'status','Publicado',
    'start',o.inicio,'end',o.fin,'count',o.cantidad,
    'original',(SELECT jsonb_build_object('url',a->>'url','sha256',a->>'sha256',
          'retrieved_at',a->>'retrieved_at','published_at',a->>'published_at')
      FROM jsonb_array_elements(coalesce(r.procedencia->'archivos','[]'::jsonb)) a
      WHERE coalesce(a->>'clave',a->>'file')=r.procedencia->'series'->s.id->>'archivo' LIMIT 1),
    'sheet',r.procedencia->'series'->s.id->>'hoja',
    'source_row',r.procedencia->'series'->s.id->'fila_origen',
    'normalization_notes',coalesce(r.procedencia->'series'->s.id->'notas','[]'::jsonb),
    'license',f.licencia,'license_url',f.licencia_url,'attribution',f.atribucion,
    'observations',CASE WHEN p_valores THEN coalesce((
       SELECT jsonb_agg(jsonb_build_object('date',v.periodo,'value',v.valor) ORDER BY v.periodo)
       FROM publicado_observaciones v WHERE v.serie_id=s.id),'[]'::jsonb) ELSE '[]'::jsonb END)
  FROM serie s JOIN fuente f ON f.id=s.fuente_id JOIN publicado_release r ON r.fuente_id=f.id
  CROSS JOIN LATERAL (SELECT min(v.periodo) inicio,max(v.periodo) fin,count(*) cantidad
    FROM publicado_observaciones v WHERE v.serie_id=s.id) o
  WHERE s.id=p_id AND o.cantidad>0 AND nullif(btrim(f.licencia),'') IS NOT NULL
    AND nullif(btrim(f.atribucion),'') IS NOT NULL AND s.frecuencia='Mensual'
$$;
REVOKE ALL ON FUNCTION economia.ficha_serie_publicada(text,boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.buscar_series_economicas(
  p_texto text DEFAULT '',p_tema text DEFAULT '',p_cobertura text DEFAULT '',p_pagina integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = economia, pg_temp AS $$
DECLARE respuesta jsonb;
BEGIN
  IF p_pagina IS NULL OR p_pagina<1 OR p_pagina>100000 OR length(coalesce(p_texto,''))>200
     OR length(coalesce(p_tema,''))>100 OR length(coalesce(p_cobertura,''))>100 THEN
    RAISE EXCEPTION 'Filtros o página inválidos' USING ERRCODE='22023';
  END IF;
  WITH disponibles AS MATERIALIZED (
    SELECT s.id,s.nombre,s.tema,s.nivel,s.territorio,f.nombre AS fuente
    FROM serie s JOIN fuente f ON f.id=s.fuente_id JOIN publicado_release r ON r.fuente_id=f.id
    WHERE nullif(btrim(f.licencia),'') IS NOT NULL AND nullif(btrim(f.atribucion),'') IS NOT NULL
      AND s.frecuencia='Mensual' AND EXISTS (SELECT 1 FROM publicado_observaciones o WHERE o.serie_id=s.id)
  ), filtradas AS MATERIALIZED (
    SELECT * FROM disponibles WHERE (coalesce(p_texto,'')='' OR
      position(lower(p_texto) IN lower(concat_ws(' ',nombre,territorio,fuente,id)))>0)
      AND (coalesce(p_tema,'')='' OR tema=p_tema) AND (coalesce(p_cobertura,'')='' OR nivel=p_cobertura)
  ), pagina AS (
    SELECT id,nombre FROM filtradas ORDER BY nombre,id LIMIT 50 OFFSET (p_pagina-1)*50
  )
  SELECT jsonb_build_object('schema_version',1,'source','supabase','paginated',true,
    'release_id','Publicaciones vigentes','page',p_pagina,'page_size',50,
    'total',(SELECT count(*) FROM filtradas),'catalog_total',(SELECT count(*) FROM disponibles),
    'topics',coalesce((SELECT jsonb_agg(t ORDER BY t) FROM (SELECT DISTINCT tema t FROM disponibles WHERE tema IS NOT NULL) a),'[]'::jsonb),
    'levels',coalesce((SELECT jsonb_agg(t ORDER BY t) FROM (SELECT DISTINCT nivel t FROM disponibles WHERE nivel IS NOT NULL) a),'[]'::jsonb),
    'series',coalesce((SELECT jsonb_agg(ficha_serie_publicada(id,false) ORDER BY nombre,id) FROM pagina),'[]'::jsonb)) INTO respuesta;
  RETURN respuesta;
END $$;

CREATE OR REPLACE FUNCTION public.serie_economica_publicada(p_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = economia, pg_temp AS $$
BEGIN
  IF p_id IS NULL OR p_id !~ '^[a-z0-9_]{1,100}$' THEN
    RAISE EXCEPTION 'Identificador inválido' USING ERRCODE='22023';
  END IF;
  RETURN ficha_serie_publicada(p_id,true);
END $$;

REVOKE ALL ON FUNCTION public.buscar_series_economicas(text,text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.serie_economica_publicada(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.buscar_series_economicas(text,text,text,integer) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.serie_economica_publicada(text) TO anon,authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
