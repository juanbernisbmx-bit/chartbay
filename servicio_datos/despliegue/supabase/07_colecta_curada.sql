-- Recolección y publicación automática limitada al catálogo curado autorizado.
BEGIN;
CREATE OR REPLACE FUNCTION servicio_series.tomar_curado() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=economia,pg_temp AS $$
DECLARE salida jsonb;
BEGIN
 IF pg_database_size(current_database())>=350000000 OR
   (SELECT coalesce(sum((metadata->>'size')::bigint),0) FROM storage.objects)>=750000000 THEN
  RETURN jsonb_build_object('bloqueada','presupuesto','trabajos','[]'::jsonb);
 END IF;
 IF NOT (SELECT activo FROM catalogo_curado_config WHERE id) THEN RETURN jsonb_build_object('trabajos','[]'::jsonb); END IF;
 WITH pendiente AS(
  SELECT q.serie_id FROM consulta_serie_api q JOIN catalogo_curado c ON c.serie_id=q.serie_id
   WHERE q.activa AND c.incluida AND q.proxima<=now() AND (q.reservada_hasta IS NULL OR q.reservada_hasta<now())
   ORDER BY q.proxima,q.serie_id FOR UPDATE OF q SKIP LOCKED LIMIT 1
 ), reserva AS(
  UPDATE consulta_serie_api q SET token=gen_random_uuid(),reservada_hasta=now()+interval '8 minutes',ultimo_intento=now()
   FROM pendiente p WHERE q.serie_id=p.serie_id RETURNING q.*
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',q.serie_id,'upstream_id',q.upstream_id,'token',q.token,
  'kind',c.tipo,'column',c.columna,'url',c.url_datos,'frequency',c.frecuencia,'unit',c.unidad,
  'name',c.nombre_verificado,'start',c.desde,'license',f.licencia)),'[]'::jsonb) INTO salida
  FROM reserva q JOIN catalogo_curado c ON c.serie_id=q.serie_id JOIN serie s ON s.id=q.serie_id JOIN fuente f ON f.id=s.fuente_id;
 RETURN jsonb_build_object('trabajos',salida);
END $$;

CREATE OR REPLACE FUNCTION servicio_series.cargar_curado(p_id text,p_token uuid,p_puntos jsonb,p_archivo jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=economia,pg_temp AS $$
DECLARE cfg catalogo_curado%ROWTYPE; fid text; co bigint; ca bigint; previo bigint;
 huella text; existente text; detalle jsonb; publicada record; hoy date:=(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
BEGIN
 PERFORM 1 FROM consulta_serie_api WHERE serie_id=p_id AND token=p_token AND reservada_hasta>now() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Reserva inexistente o vencida'; END IF;
 SELECT * INTO cfg FROM catalogo_curado WHERE serie_id=p_id AND incluida;
 IF NOT FOUND THEN RAISE EXCEPTION 'Serie fuera de selección'; END IF;
 SELECT s.fuente_id INTO fid FROM serie s JOIN fuente f ON f.id=s.fuente_id
  WHERE s.id=p_id AND s.frecuencia=cfg.frecuencia AND s.unidad=cfg.unidad
    AND nullif(btrim(f.licencia),'') IS NOT NULL AND nullif(btrim(f.atribucion),'') IS NOT NULL;
 IF fid IS NULL OR (SELECT count(*) FROM serie WHERE fuente_id=fid)<>1 THEN RAISE EXCEPTION 'Definición de fuente incompatible'; END IF;
 IF pg_database_size(current_database())>=350000000 THEN RAISE EXCEPTION 'Presupuesto de base'; END IF;
 IF jsonb_typeof(p_puntos) IS DISTINCT FROM 'array' OR jsonb_array_length(p_puntos) NOT BETWEEN 1 AND 12000 THEN RAISE EXCEPTION 'Lista inválida'; END IF;
 IF p_archivo->>'upstream_id' IS DISTINCT FROM cfg.upstream_id OR p_archivo->>'url' IS DISTINCT FROM cfg.url_datos
   OR coalesce(p_archivo->>'sha256','') !~ '^[a-f0-9]{64}$' OR (p_archivo->>'bytes')::integer NOT BETWEEN 1 AND 16000000
   OR p_archivo->>'ruta' NOT IN ('curado/'||(p_archivo->>'sha256')||'.json','curado/'||(p_archivo->>'sha256')||'.zip') THEN RAISE EXCEPTION 'Procedencia incompatible'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_puntos) p WHERE jsonb_typeof(p) IS DISTINCT FROM 'array' OR jsonb_array_length(p)<>2
    OR coalesce(p->>0,'') !~ '^\d{4}-\d{2}-\d{2}$' OR coalesce(p->>1,'') !~ '^-?\d+(\.\d+)?([eE][+-]?\d+)?$'
    OR NOT finito((p->>1)::numeric) OR (p->>0)::date>hoy
    OR (cfg.frecuencia='Mensual' AND extract(day FROM (p->>0)::date)<>1)
    OR (cfg.frecuencia='Anual' AND to_char((p->>0)::date,'MM-DD')<>'01-01'))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_puntos) p GROUP BY (p->>0)::date HAVING count(*)>1) THEN RAISE EXCEPTION 'Períodos o cifras incompatibles'; END IF;
 SELECT encode(sha256(convert_to(string_agg(p_id||'|'||(p->>0)||'|'||trim_scale((p->>1)::numeric)::text,E'\n'
  ORDER BY p_id||'|'||(p->>0)||'|'||trim_scale((p->>1)::numeric)::text COLLATE "C"),'UTF8')),'hex') INTO huella FROM jsonb_array_elements(p_puntos) p;
 SELECT hash_contenido INTO existente FROM publicado_release WHERE fuente_id=fid;
 IF huella=existente THEN RETURN jsonb_build_object('estado','sin_cambios'); END IF;
 -- No cerrar observaciones históricas por una respuesta acortada o parcial.
 IF EXISTS(SELECT 1 FROM publicado_observaciones o WHERE o.serie_id=p_id AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(p_puntos) p WHERE (p->>0)::date=o.periodo)) THEN
   RAISE EXCEPTION 'La captura omite períodos publicados; se conserva el release anterior';
 END IF;
 co:=abrir_corrida(fid,600);
 IF co IS NULL THEN RAISE EXCEPTION 'Otra corrida en curso'; END IF;
 PERFORM registrar_descarga(co,cfg.url_datos,'nueva',p_archivo->>'sha256',(p_archivo->>'bytes')::bigint,p_archivo->>'ruta');
 UPDATE candidato SET estado='descartado',decidido_en=now(),decidido_por='catalogo_curado',motivo='Sustituido por captura oficial íntegra; historial conservado'
  WHERE estado='abierto' AND corrida_id IN (SELECT id FROM corrida WHERE fuente_id=fid);
 INSERT INTO candidato(corrida_id) VALUES(co) RETURNING id INTO ca;
 INSERT INTO observacion_candidata(candidato_id,serie_id,periodo,valor)
  SELECT ca,p_id,(p->>0)::date,(p->>1)::numeric FROM jsonb_array_elements(p_puntos) p;
 detalle:=jsonb_build_object('archivos',jsonb_build_array(jsonb_build_object('clave','curado','url',cfg.url_datos,
  'sha256',p_archivo->>'sha256','ruta',p_archivo->>'ruta','retrieved_at',iso_utc(now()))),
  'detalle_series',jsonb_build_object(p_id,jsonb_build_object('archivo','curado','notas',jsonb_build_array('Fuente oficial; frecuencia y unidad verificadas; valores originales sin agregación.'))));
 INSERT INTO hallazgo(corrida_id,serie_id,regla,severidad,detalle) VALUES(co,p_id,'revision_catalogo_curado','alta','Controles de identidad, unidad, fechas, integridad y licencia superados. Publicación automática autorizada por el usuario.');
 UPDATE corrida SET estado='con_candidato',terminada_en=now(),resumen=detalle||jsonb_build_object('candidato_id',ca,'series',1,'observaciones',jsonb_array_length(p_puntos)) WHERE id=co;
 PERFORM aceptar_pendientes(ca,'sistema:catalogo_curado','Captura oficial íntegra; autorización del usuario del 28/10/2026.','revision_catalogo_curado');
 SELECT * INTO publicada FROM publicar_candidato(ca,'sistema:catalogo_curado','curado',hoy);
 IF pg_database_size(current_database())>=350000000 THEN RAISE EXCEPTION 'El lote excede el presupuesto'; END IF;
 RETURN jsonb_build_object('estado','publicado','release_id',publicada.release_id,'candidato_id',ca);
END $$;
REVOKE ALL ON FUNCTION servicio_series.tomar_curado() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION servicio_series.cargar_curado(text,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION servicio_series.tomar_curado(),servicio_series.cargar_curado(text,uuid,jsonb,jsonb) TO servicio_datos;
COMMIT;
