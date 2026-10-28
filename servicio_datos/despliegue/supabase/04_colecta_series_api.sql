-- Recolección de las series seleccionadas. Ninguna función aprueba/publica datos.
BEGIN;
CREATE TABLE IF NOT EXISTS economia.consulta_serie_api (
  serie_id text PRIMARY KEY REFERENCES economia.serie(id),
  upstream_id text NOT NULL UNIQUE CHECK(upstream_id ~ '^[A-Za-z0-9_.-]+$'),
  activa boolean NOT NULL DEFAULT true,
  cada_horas integer NOT NULL DEFAULT 24 CHECK(cada_horas BETWEEN 6 AND 720),
  proxima timestamptz NOT NULL DEFAULT now(),
  token uuid, reservada_hasta timestamptz,
  ultimo_intento timestamptz, ultimo_exito timestamptz,
  fallos integer NOT NULL DEFAULT 0, ultimo_error text
);
ALTER TABLE economia.consulta_serie_api ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON economia.consulta_serie_api FROM PUBLIC,anon,authenticated;
CREATE SCHEMA IF NOT EXISTS servicio_series;

CREATE OR REPLACE FUNCTION servicio_series.tomar(p_limite integer DEFAULT 8) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = economia, pg_temp AS $$
DECLARE salida jsonb;
BEGIN
  IF pg_database_size(current_database())>=350000000 THEN
    RETURN jsonb_build_object('bloqueada','presupuesto_base','trabajos','[]'::jsonb);
  END IF;
  IF to_regclass('storage.objects') IS NOT NULL THEN
    IF (SELECT coalesce(sum((metadata->>'size')::bigint),0) FROM storage.objects)>=750000000 THEN
      RETURN jsonb_build_object('bloqueada','presupuesto_storage','trabajos','[]'::jsonb);
    END IF;
  END IF;
  WITH pendientes AS (
    SELECT serie_id FROM consulta_serie_api WHERE activa AND proxima<=now()
      AND (reservada_hasta IS NULL OR reservada_hasta<now())
    ORDER BY proxima,serie_id FOR UPDATE SKIP LOCKED LIMIT greatest(1,least(coalesce(p_limite,8),8))
  ), reservadas AS (
    UPDATE consulta_serie_api c SET token=gen_random_uuid(),reservada_hasta=now()+interval '8 minutes',ultimo_intento=now()
    FROM pendientes p WHERE c.serie_id=p.serie_id RETURNING c.*
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',serie_id,'upstream_id',upstream_id,'token',token,
       'unit',(SELECT unidad FROM serie WHERE id=reservadas.serie_id))),'[]'::jsonb)
    INTO salida FROM reservadas;
  RETURN jsonb_build_object('trabajos',salida);
END $$;

CREATE OR REPLACE FUNCTION servicio_series.terminar(p_id text,p_token uuid,p_error text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = economia, pg_temp AS $$
BEGIN
  UPDATE consulta_serie_api SET token=NULL,reservada_hasta=NULL,
    ultimo_exito=CASE WHEN p_error IS NULL THEN now() ELSE ultimo_exito END,
    proxima=now()+make_interval(hours=>CASE WHEN p_error IS NULL THEN cada_horas ELSE least(24,power(2,least(fallos,5))::integer) END),
    fallos=CASE WHEN p_error IS NULL THEN 0 ELSE fallos+1 END,
    ultimo_error=left(p_error,500)
    WHERE serie_id=p_id AND token=p_token;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION servicio_series.cargar(p_id text,p_token uuid,p_puntos jsonb,p_archivo jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = economia, pg_temp AS $$
DECLARE cfg consulta_serie_api%ROWTYPE; fid text; co bigint; ca bigint; previo bigint;
  huella text; existente text; detalle jsonb; nuevos integer; cambiados integer; faltantes integer;
BEGIN
  SELECT * INTO cfg FROM consulta_serie_api WHERE serie_id=p_id AND token=p_token AND reservada_hasta>now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reserva inexistente o vencida'; END IF;
  IF pg_database_size(current_database())>=350000000 THEN RAISE EXCEPTION 'Presupuesto de base agotado'; END IF;
  IF jsonb_typeof(p_puntos) IS DISTINCT FROM 'array' OR jsonb_array_length(p_puntos) NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Lista de valores inválida';
  END IF;
  IF p_archivo->>'upstream_id' IS DISTINCT FROM cfg.upstream_id OR p_archivo->>'sha256' !~ '^[a-f0-9]{64}$'
    OR (p_archivo->>'bytes')::integer NOT BETWEEN 1 AND 1048576
    OR p_archivo->>'url' NOT LIKE 'https://apis.datos.gob.ar/series/api/series/?%'
    OR p_archivo->>'ruta' IS DISTINCT FROM 'series-api/'||(p_archivo->>'sha256')||'.json' THEN
    RAISE EXCEPTION 'Procedencia inválida';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_puntos) p WHERE
      jsonb_typeof(p) IS DISTINCT FROM 'array' OR jsonb_array_length(p)<>2
      OR coalesce(p->>0,'') !~ '^\d{4}-(0[1-9]|1[0-2])-01$'
      OR coalesce(p->>1,'') !~ '^-?\d+(\.\d+)?([eE][+-]?\d+)?$'
      OR NOT finito((p->>1)::numeric))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_puntos) p GROUP BY (p->>0)::date HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Períodos o cifras incompatibles';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_puntos) p
    WHERE (p->>0)::date>date_trunc('month',now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) THEN
    RAISE EXCEPTION 'La fuente incluye períodos futuros; requiere revisión antes de actualizar';
  END IF;
  SELECT fuente_id INTO fid FROM serie WHERE id=p_id;
  -- Las fuentes operativas de este catálogo contienen exactamente una serie.
  IF (SELECT count(*) FROM serie WHERE fuente_id=fid)<>1 THEN RAISE EXCEPTION 'Fuente no individual'; END IF;
  co:=abrir_corrida(fid,600);
  IF co IS NULL THEN RAISE EXCEPTION 'Hay otra corrida en curso'; END IF;
  PERFORM registrar_descarga(co,p_archivo->>'url','nueva',p_archivo->>'sha256',(p_archivo->>'bytes')::bigint,p_archivo->>'ruta');
  detalle:=jsonb_build_object('archivos',jsonb_build_array(jsonb_build_object('clave','api','url',p_archivo->>'url','sha256',p_archivo->>'sha256')),
    'detalle_series',jsonb_build_object(p_id,jsonb_build_object('archivo','api','notas',jsonb_build_array('API oficial; valores originales sin transformaciones.'))));
  SELECT encode(sha256(convert_to(string_agg(p_id||'|'||(p->>0)||'|'||trim_scale((p->>1)::numeric)::text,E'\n'
      ORDER BY p_id||'|'||(p->>0)||'|'||trim_scale((p->>1)::numeric)::text COLLATE "C"),'UTF8')),'hex')
    INTO huella FROM jsonb_array_elements(p_puntos) p;
  SELECT c.id,hash_candidato(c.id) INTO previo,existente FROM candidato c JOIN corrida r ON r.id=c.corrida_id
    WHERE r.fuente_id=fid AND c.estado='abierto' ORDER BY c.id DESC LIMIT 1;
  IF existente IS NULL THEN
    SELECT hash_contenido INTO existente FROM publicado_release WHERE fuente_id=fid;
  END IF;
  IF huella=existente THEN
    UPDATE corrida SET estado='sin_cambios',terminada_en=now(),resumen=detalle WHERE id=co;
    RETURN jsonb_build_object('estado','sin_cambios','corrida',co);
  END IF;
  WITH propuestas AS (SELECT (p->>0)::date periodo,(p->>1)::numeric valor FROM jsonb_array_elements(p_puntos) p)
  SELECT (SELECT count(*) FROM propuestas p WHERE NOT EXISTS(SELECT 1 FROM observacion_vigente o WHERE o.serie_id=p_id AND o.periodo=p.periodo)),
    (SELECT count(*) FROM propuestas p JOIN observacion_vigente o ON o.serie_id=p_id AND o.periodo=p.periodo WHERE o.valor<>p.valor),
    (SELECT count(*) FROM observacion_vigente o WHERE o.serie_id=p_id AND NOT EXISTS(SELECT 1 FROM propuestas p WHERE p.periodo=o.periodo))
    INTO nuevos,cambiados,faltantes;
  IF previo IS NOT NULL THEN
    UPDATE candidato SET estado='descartado',decidido_en=now(),decidido_por='sistema',motivo='Reemplazado por una nueva captura de API con cambios; se conserva el candidato anterior.' WHERE id=previo;
  END IF;
  INSERT INTO candidato(corrida_id) VALUES(co) RETURNING id INTO ca;
  INSERT INTO observacion_candidata(candidato_id,serie_id,periodo,valor)
    SELECT ca,p_id,(p->>0)::date,(p->>1)::numeric FROM jsonb_array_elements(p_puntos) p;
  INSERT INTO hallazgo(corrida_id,serie_id,regla,severidad,detalle) VALUES(co,p_id,'revision_serie_api','alta',
    format('Revisar captura de API: %s períodos nuevos, %s revisados y %s ausentes. Verificar definición y licencia antes de publicar.',nuevos,cambiados,faltantes));
  UPDATE corrida SET estado='con_candidato',terminada_en=now(),resumen=detalle||jsonb_build_object(
    'series',1,'observaciones',jsonb_array_length(p_puntos),'candidato_id',ca,
    'periodos_nuevos',nuevos,'periodos_cambiados',cambiados,'periodos_faltantes',faltantes) WHERE id=co;
  RETURN jsonb_build_object('estado','con_candidato','corrida',co,'candidato_id',ca);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA servicio_series FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA servicio_series TO servicio_datos;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA servicio_series TO servicio_datos;
COMMIT;
