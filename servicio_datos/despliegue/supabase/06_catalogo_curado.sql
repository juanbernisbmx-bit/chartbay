-- Catálogo editorial reversible. No borra releases ni observaciones históricas.
BEGIN;
CREATE TABLE IF NOT EXISTS economia.catalogo_curado_config(id boolean PRIMARY KEY DEFAULT true CHECK(id),activo boolean NOT NULL DEFAULT false);
INSERT INTO economia.catalogo_curado_config VALUES(true,false) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS economia.catalogo_curado(
 serie_id text PRIMARY KEY REFERENCES economia.serie(id),incluida boolean NOT NULL DEFAULT true,
 tipo text NOT NULL CHECK(tipo IN ('datos_csv','bcra_v4')),upstream_id text NOT NULL UNIQUE,
 columna text NOT NULL,url_datos text NOT NULL,frecuencia text NOT NULL CHECK(frecuencia IN ('Diaria','Mensual','Anual')),
 unidad text NOT NULL,nombre_verificado text NOT NULL,desde date NOT NULL,
 verificada_en date NOT NULL,criterio text NOT NULL
);
-- Consultar vigencia/cobertura sin recorrer versiones históricas cerradas.
CREATE INDEX IF NOT EXISTS observacion_vigente_catalogo ON economia.observacion(serie_id,periodo) WHERE release_hasta IS NULL;
ALTER TABLE economia.catalogo_curado ENABLE ROW LEVEL SECURITY;
ALTER TABLE economia.catalogo_curado_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON economia.catalogo_curado,economia.catalogo_curado_config FROM PUBLIC,anon,authenticated,servicio_datos;
CREATE OR REPLACE FUNCTION economia.serie_en_catalogo(p_id text,p_fin date) RETURNS boolean
LANGUAGE sql STABLE SET search_path=economia,pg_temp AS $$
 SELECT CASE WHEN NOT (SELECT activo FROM catalogo_curado_config WHERE id) THEN
   (SELECT frecuencia='Mensual' FROM serie WHERE id=p_id)
 ELSE EXISTS(SELECT 1 FROM catalogo_curado c WHERE c.serie_id=p_id AND c.incluida
  AND p_fin>=CASE c.frecuencia
   WHEN 'Diaria' THEN (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date-14
   WHEN 'Mensual' THEN (date_trunc('month',now() AT TIME ZONE 'America/Argentina/Buenos_Aires')-interval '3 months')::date
   ELSE (date_trunc('year',now() AT TIME ZONE 'America/Argentina/Buenos_Aires')-interval '2 years')::date END) END
$$;
REVOKE ALL ON FUNCTION economia.serie_en_catalogo(text,date) FROM PUBLIC;
DROP FUNCTION IF EXISTS public.buscar_series_economicas(text,text,text,integer);
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
    AND nullif(btrim(f.atribucion),'') IS NOT NULL AND serie_en_catalogo(s.id,o.fin)
$$;
REVOKE ALL ON FUNCTION economia.ficha_serie_publicada(text,boolean) FROM PUBLIC;

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

CREATE OR REPLACE FUNCTION public.serie_economica_publicada(p_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = economia, pg_temp AS $$
BEGIN
  IF p_id IS NULL OR p_id !~ '^[a-z0-9_]{1,100}$' THEN
    RAISE EXCEPTION 'Identificador inválido' USING ERRCODE='22023';
  END IF;
  RETURN ficha_serie_publicada(p_id,true);
END $$;

REVOKE ALL ON FUNCTION public.buscar_series_economicas(text,text,text,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.serie_economica_publicada(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.buscar_series_economicas(text,text,text,integer,text) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.serie_economica_publicada(text) TO anon,authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
