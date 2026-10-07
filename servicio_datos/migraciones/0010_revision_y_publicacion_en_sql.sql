-- La revisión y la publicación pasan a ser funciones de la base (plan: docs/base-datos-supabase.md, paso 1).
--
-- Hasta ahora vivían en Python (`publicacion.py`), que solo puede correr donde hay un servidor. Como funciones de la
-- base, las llama cualquiera que pueda hablar con ella: el Python de siempre, una Edge Function o la página de
-- revisión de ChartBay (por el esquema `revision`, ver `api_revision.py`). La lógica es la misma, con los mismos
-- mensajes, y las reglas de siempre siguen sosteniéndolas los triggers.
--
-- Un error de negocio sale con SQLSTATE CB001: el mensaje es para la persona y el DETAIL es un código fijo
-- (`no_existe`, `hallazgos_pendientes`...) para que una interfaz sepa qué pasó sin leer el texto.

-- Quién puede revisar: la página de ChartBay solo deja hacerlo a una cuenta de esta lista.
CREATE TABLE revisor (
  email      text PRIMARY KEY CHECK (email = lower(btrim(email)) AND email ~ '^[^@\s]+@[^@\s]+$'),
  nombre     text NOT NULL CHECK (length(btrim(nombre)) > 0),
  activo     boolean NOT NULL DEFAULT true,
  creado_en  timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION falla(codigo text, mensaje text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'CB001', MESSAGE = mensaje, DETAIL = codigo;
END $$;

CREATE FUNCTION plural(n bigint, uno text, varios text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT n || ' ' || CASE WHEN n = 1 THEN uno ELSE varios END $$;

-- Una fecha como la escribe Python (`isoformat()` en UTC): con microsegundos solo si los tiene.
CREATE FUNCTION iso_utc(t timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t IS NULL THEN NULL
              WHEN date_trunc('second', t) = t THEN to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '+00:00'
              ELSE to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' END
$$;

-- Revisión ----------------------------------------------------------------------------------------

CREATE FUNCTION estado_revision(p_candidato bigint, OUT total bigint, OUT aceptados bigint, OUT rechazados bigint,
                                OUT pendientes bigint, OUT propuestas_pendientes bigint)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_corrida bigint;
BEGIN
  SELECT corrida_id INTO v_corrida FROM candidato WHERE id = p_candidato;
  IF NOT FOUND THEN
    PERFORM falla('no_existe', format('No existe el candidato %s', p_candidato));
  END IF;
  WITH ultima AS (
    SELECT DISTINCT ON (r.hallazgo_id) r.hallazgo_id, r.decision FROM revision_hallazgo r
    JOIN hallazgo h ON h.id = r.hallazgo_id WHERE h.corrida_id = v_corrida ORDER BY r.hallazgo_id, r.id DESC)
  SELECT count(*), count(*) FILTER (WHERE u.decision = 'aceptado'), count(*) FILTER (WHERE u.decision = 'rechazado'),
         count(*) FILTER (WHERE u.decision IS NULL)
    INTO total, aceptados, rechazados, pendientes
  FROM hallazgo h LEFT JOIN ultima u ON u.hallazgo_id = h.id WHERE h.corrida_id = v_corrida;
  SELECT count(*) INTO propuestas_pendientes FROM propuesta p JOIN hallazgo h ON h.id = p.hallazgo_id
  WHERE h.corrida_id = v_corrida AND p.estado = 'pendiente';
END $$;

-- La decisión de la persona sobre el hallazgo resuelve las propuestas del agente que seguían pendientes: aprobada si
-- coincide con lo que sugería, rechazada si decidió distinto. Una que sugería investigar no puede estar en desacuerdo;
-- una sin evidencia no se aprueba nunca. Así queda medido cuánto acierta el agente.
CREATE FUNCTION resolver_propuestas(p_hallazgo bigint, p_decision text, p_revisor text, p_comentario text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  p record;
  v_coincide boolean;
  v_estado text;
  v_nota text;
BEGIN
  FOR p IN SELECT id, accion_sugerida, evidencia FROM propuesta WHERE hallazgo_id = p_hallazgo AND estado = 'pendiente' ORDER BY id LOOP
    v_coincide := p.accion_sugerida IS NULL OR p.accion_sugerida = 'investigar'
                  OR (p.accion_sugerida, p_decision) IN (('aceptar', 'aceptado'), ('rechazar', 'rechazado'));
    IF v_coincide AND length(btrim(coalesce(p.evidencia, ''))) = 0 THEN
      v_estado := 'rechazada';
      v_nota := 'Sin evidencia citada: no se puede aprobar.';
    ELSIF v_coincide THEN
      v_estado := 'aprobada';
      v_nota := p_comentario;
    ELSE
      v_estado := 'rechazada';
      v_nota := coalesce(nullif(btrim(coalesce(p_comentario, '')), ''), 'La persona decidió distinto de lo que proponía el agente.');
    END IF;
    UPDATE propuesta SET estado = v_estado, revisor = btrim(p_revisor), decidida_en = now(), comentario = v_nota WHERE id = p.id;
  END LOOP;
END $$;

-- Una decisión sobre un hallazgo. Una nueva reemplaza a la anterior (el registro es de solo agregar: vale la última).
CREATE FUNCTION revisar_hallazgo(p_hallazgo bigint, p_decision text, p_revisor text, p_comentario text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_estado text;
BEGIN
  SELECT c.estado INTO v_estado FROM hallazgo h LEFT JOIN candidato c ON c.corrida_id = h.corrida_id WHERE h.id = p_hallazgo;
  IF NOT FOUND THEN
    PERFORM falla('revision_invalida', format('Revisión inválida: no existe el hallazgo %s', p_hallazgo));
  END IF;
  IF v_estado IS DISTINCT FROM 'abierto' THEN
    PERFORM falla('candidato_cerrado', 'Ese hallazgo ya no se puede revisar: su candidato no está abierto');
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('aceptado', 'rechazado') THEN
    PERFORM falla('revision_invalida', 'Revisión inválida: la decisión tiene que ser aceptado o rechazado');
  END IF;
  IF length(btrim(coalesce(p_revisor, ''))) = 0 THEN
    PERFORM falla('revision_invalida', 'Revisión inválida: falta quién revisa');
  END IF;
  IF p_decision = 'rechazado' AND length(btrim(coalesce(p_comentario, ''))) = 0 THEN
    PERFORM falla('revision_invalida', 'Revisión inválida: para rechazar hace falta un comentario');
  END IF;
  INSERT INTO revision_hallazgo (hallazgo_id, decision, revisor, comentario) VALUES (p_hallazgo, p_decision, p_revisor, p_comentario);
  PERFORM resolver_propuestas(p_hallazgo, p_decision, p_revisor, p_comentario);
END $$;

-- Acepta de una vez los hallazgos sin decisión del candidato (los de una regla, o todos). Todos o ninguno.
CREATE FUNCTION aceptar_pendientes(p_candidato bigint, p_revisor text, p_comentario text DEFAULT NULL, p_regla text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_hallazgo bigint;
  v_cuantos integer := 0;
BEGIN
  PERFORM estado_revision(p_candidato);  -- falla si no existe
  FOR v_hallazgo IN
    SELECT h.id FROM candidato c JOIN hallazgo h ON h.corrida_id = c.corrida_id
    WHERE c.id = p_candidato AND (p_regla IS NULL OR h.regla = p_regla)
      AND NOT EXISTS (SELECT 1 FROM revision_hallazgo r WHERE r.hallazgo_id = h.id)
    ORDER BY h.id
  LOOP
    PERFORM revisar_hallazgo(v_hallazgo, 'aceptado', p_revisor, coalesce(nullif(btrim(coalesce(p_comentario, '')), ''), 'Revisado'));
    v_cuantos := v_cuantos + 1;
  END LOOP;
  RETURN v_cuantos;
END $$;

-- Publicación --------------------------------------------------------------------------------------

-- SHA-256 del contenido del candidato: serie, período y valor, en orden. El valor sin ceros de más (100, 100.0 y
-- 100.000 dan lo mismo): depende del dato y no de cómo se escribió. Es el mismo que `publicacion.hash_contenido`.
CREATE FUNCTION hash_candidato(p_candidato bigint) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(coalesce(string_agg(linea, E'\n' ORDER BY linea COLLATE "C"), ''), 'UTF8')), 'hex')
  FROM (SELECT serie_id || '|' || to_char(periodo, 'YYYY-MM-DD') || '|' || trim_scale(valor)::text AS linea
        FROM observacion_candidata WHERE candidato_id = p_candidato) l
$$;

-- Qué archivos y qué hoja, fila y notas respaldan a cada serie de una corrida. Tres fechas que no se mezclan:
-- `retrieved_at`, la primera vez que se vio el archivo; `http_last_modified`, lo que declara el servidor (cuándo cambió el
-- archivo ahí, no cuándo se publicó); y `published_at`, vacía porque la fuente no informa la hora oficial.
CREATE FUNCTION procedencia_de(p_corrida bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'archivos', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'clave', a->>'clave', 'file', regexp_replace(a->>'url', '^.*/', ''), 'url', a->>'url', 'sha256', a->>'sha256',
               'retrieved_at', iso_utc(d.captura), 'http_last_modified', iso_utc(d.modificada), 'published_at', NULL) ORDER BY x.orden)
      FROM jsonb_array_elements(co.resumen->'archivos') WITH ORDINALITY AS x(a, orden)
      CROSS JOIN LATERAL (
        SELECT min(descargada_en) AS captura, max(publicada_en) AS modificada FROM descarga
        WHERE url = a->>'url' AND sha256 = a->>'sha256' AND estado IN ('nueva', 'identica')) d), '[]'::jsonb),
    'series', coalesce(co.resumen->'detalle_series', '{}'::jsonb))
  FROM corrida co WHERE co.id = p_corrida
$$;

-- Convierte el candidato en el release vigente. Es la única forma de que un dato llegue a lo publicado, y exige que cada
-- hallazgo esté aceptado. El release es una foto completa de la fuente: lo que cambia se cierra y se abre de nuevo, lo
-- que ya no está se cierra y lo que no cambia no se toca. Todo en la transacción de quien llama.
CREATE FUNCTION publicar_candidato(p_candidato bigint, p_aprobado_por text, p_prefijo text, p_fecha date DEFAULT NULL,
                                   OUT release_numero integer, OUT release_id text, OUT hash_contenido text,
                                   OUT observaciones_abiertas integer, OUT observaciones_cerradas integer, OUT observaciones_sin_cambio integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_fuente text;
  v_corrida bigint;
  v_estado text;
  v_revision record;
  v_filas integer;
  v_fecha date := coalesce(p_fecha, (now() AT TIME ZONE 'UTC')::date);
  v_intento integer := 1;
BEGIN
  IF length(btrim(coalesce(p_aprobado_por, ''))) = 0 THEN
    PERFORM falla('aprobador_vacio', 'Falta quién aprueba la publicación');
  END IF;
  SELECT co.fuente_id, c.corrida_id INTO v_fuente, v_corrida FROM candidato c JOIN corrida co ON co.id = c.corrida_id WHERE c.id = p_candidato;
  IF NOT FOUND THEN
    PERFORM falla('no_existe', format('No existe el candidato %s', p_candidato));
  END IF;
  -- Una publicación por vez por fuente: dos releases a la vez se pisarían las versiones.
  PERFORM pg_advisory_xact_lock(hashtext('publicar:' || v_fuente));
  SELECT estado INTO v_estado FROM candidato WHERE id = p_candidato FOR UPDATE;
  IF v_estado <> 'abierto' THEN
    PERFORM falla('no_abierto', format('El candidato %s no está abierto (estado: %s)', p_candidato, v_estado));
  END IF;

  SELECT * INTO v_revision FROM estado_revision(p_candidato);
  IF v_revision.rechazados > 0 THEN
    PERFORM falla('hallazgos_rechazados', 'Hay ' || plural(v_revision.rechazados, 'hallazgo rechazado', 'hallazgos rechazados')
                  || ': el candidato no se publica, hay que descartarlo o esperar uno nuevo');
  END IF;
  IF v_revision.pendientes > 0 THEN
    PERFORM falla('hallazgos_pendientes', 'Faltan ' || plural(v_revision.pendientes, 'hallazgo', 'hallazgos') || ' por resolver');
  END IF;
  IF v_revision.propuestas_pendientes > 0 THEN
    PERFORM falla('propuestas_pendientes', 'Faltan decidir ' || plural(v_revision.propuestas_pendientes, 'propuesta', 'propuestas') || ' del agente');
  END IF;

  SELECT count(*) INTO v_filas FROM observacion_candidata WHERE candidato_id = p_candidato;
  IF v_filas = 0 THEN
    PERFORM falla('candidato_vacio', format('El candidato %s no tiene observaciones', p_candidato));
  END IF;

  hash_contenido := hash_candidato(p_candidato);
  release_id := p_prefijo || '-' || v_fecha || '-' || left(hash_contenido, 10);
  WHILE EXISTS (SELECT 1 FROM release r WHERE r.release_id = publicar_candidato.release_id) LOOP
    -- El mismo contenido el mismo día (un cambio y su vuelta atrás): se distingue con un número.
    v_intento := v_intento + 1;
    release_id := p_prefijo || '-' || v_fecha || '-' || left(hash_contenido, 10) || '-' || v_intento;
  END LOOP;
  INSERT INTO release (release_id, candidato_id, aprobado_por, hash_contenido, procedencia)
  VALUES (publicar_candidato.release_id, p_candidato, btrim(p_aprobado_por), publicar_candidato.hash_contenido, procedencia_de(v_corrida))
  RETURNING numero INTO release_numero;

  -- Se cierra lo que ya no coincide con el candidato y después se abre lo que no está vigente.
  UPDATE observacion o SET release_hasta = release_numero FROM serie s
  WHERE s.id = o.serie_id AND s.fuente_id = v_fuente AND o.release_hasta IS NULL AND NOT EXISTS (
    SELECT 1 FROM observacion_candidata c WHERE c.candidato_id = p_candidato AND c.serie_id = o.serie_id
      AND c.periodo = o.periodo AND c.valor = o.valor);
  GET DIAGNOSTICS observaciones_cerradas = ROW_COUNT;
  INSERT INTO observacion (serie_id, periodo, valor, release_desde)
  SELECT c.serie_id, c.periodo, c.valor, release_numero FROM observacion_candidata c WHERE c.candidato_id = p_candidato
    AND NOT EXISTS (SELECT 1 FROM observacion o WHERE o.serie_id = c.serie_id AND o.periodo = c.periodo
                    AND o.valor = c.valor AND o.release_hasta IS NULL);
  GET DIAGNOSTICS observaciones_abiertas = ROW_COUNT;
  observaciones_sin_cambio := v_filas - observaciones_abiertas;
  UPDATE candidato SET estado = 'publicado', decidido_en = now(), decidido_por = btrim(p_aprobado_por) WHERE id = p_candidato;
END $$;

-- Rechaza el candidato entero. No toca nada de lo publicado.
CREATE FUNCTION descartar_candidato(p_candidato bigint, p_decidido_por text, p_motivo text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_estado text;
BEGIN
  IF length(btrim(coalesce(p_decidido_por, ''))) = 0 OR length(btrim(coalesce(p_motivo, ''))) = 0 THEN
    PERFORM falla('descarte_incompleto', 'Descartar un candidato exige quién lo descarta y por qué');
  END IF;
  UPDATE candidato SET estado = 'descartado', decidido_en = now(), decidido_por = btrim(p_decidido_por), motivo = btrim(p_motivo)
  WHERE id = p_candidato AND estado = 'abierto';
  IF FOUND THEN
    RETURN;
  END IF;
  SELECT estado INTO v_estado FROM candidato WHERE id = p_candidato;
  IF NOT FOUND THEN
    PERFORM falla('no_existe', format('No existe el candidato %s', p_candidato));
  END IF;
  PERFORM falla('no_abierto', format('El candidato %s no está abierto (estado: %s)', p_candidato, v_estado));
END $$;
