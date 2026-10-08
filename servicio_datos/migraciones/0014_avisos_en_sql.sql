-- Los avisos como funciones de la base (plan: docs/base-datos-supabase.md, paso 5).
--
-- Detectar es mirar el estado de la base y anotar en la bandeja de salida (`aviso`, migración 0005) lo que falte, con una
-- clave única: se puede correr cuantas veces se quiera. Entregar queda afuera (Slack no se llama desde la base): quien entrega
-- toma los pendientes, los manda y anota cómo le fue. `avisos.py` y la Edge Function `avisar` usan estas mismas funciones.
--
-- Tomar un aviso lo reserva unos minutos (`tomado_hasta`): dos entregas a la vez no mandan dos veces lo mismo, y si quien lo
-- tomó se cae, al vencer la reserva lo toma otro. Reemplaza al candado de sesión de Python, que el pooler de Supabase en modo
-- transacción no respeta (cada consulta puede ir por otra conexión).

ALTER TABLE aviso ADD COLUMN tomado_hasta timestamptz;

-- Textos -----------------------------------------------------------------------------------------

CREATE FUNCTION mes_nombre(p_mes integer) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT (ARRAY['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre',
                'diciembre'])[p_mes]
$$;

-- Como `_fecha` de Python: "6 de octubre, 12:00", en la hora de Argentina.
CREATE FUNCTION fecha_es(t timestamptz) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT extract(day FROM l)::int || ' de ' || mes_nombre(extract(month FROM l)::int) || ', ' || to_char(l, 'HH24:MI')
  FROM (SELECT t AT TIME ZONE 'America/Argentina/Buenos_Aires' AS l) x
$$;

-- "agosto 2026"
CREATE FUNCTION mes_es(p_periodo date) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT mes_nombre(extract(month FROM p_periodo)::int) || ' ' || extract(year FROM p_periodo)::int $$;

-- Un texto ajeno (el error de una descarga) en una línea y con tope: los espacios y saltos seguidos quedan en uno.
CREATE FUNCTION una_linea(p_texto text, p_tope integer) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT left(btrim(regexp_replace(coalesce(nullif(p_texto, ''), 'Sin detalle'), '\s+', ' ', 'g')), p_tope)
$$;

-- Cálculos ---------------------------------------------------------------------------------------

-- El primer mes que ya debería haber llegado: el anterior pasado el día límite, el de dos meses antes si no (como la regla
-- de frescura de la validación).
CREATE FUNCTION periodo_esperado(p_hoy date, p_dia_limite integer) RETURNS date
LANGUAGE sql IMMUTABLE AS $$
  SELECT (date_trunc('month', p_hoy) - make_interval(months => CASE WHEN extract(day FROM p_hoy) > p_dia_limite THEN 1 ELSE 2 END))::date
$$;

-- El período más nuevo que se conoce de la fuente: lo publicado o lo de un candidato abierto.
CREATE FUNCTION ultimo_periodo(p_fuente text) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT max(p) FROM (
    SELECT o.periodo AS p FROM observacion_vigente o JOIN serie s ON s.id = o.serie_id WHERE s.fuente_id = p_fuente
    UNION ALL
    SELECT oc.periodo FROM observacion_candidata oc JOIN candidato c ON c.id = oc.candidato_id JOIN corrida co ON co.id = c.corrida_id
    WHERE co.fuente_id = p_fuente AND c.estado = 'abierto') t
$$;

-- El hito de recordatorio de un candidato con esa edad: el primero a los `p_primero` días y después uno por semana (7, 14,
-- 21...). Si el sistema estuvo apagado cuenta solo el más alto alcanzado: no se manda de golpe lo acumulado.
CREATE FUNCTION hito_de_recordatorio(p_edad_dias integer, p_primero integer) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_primero <= 0 OR p_edad_dias < p_primero THEN NULL
              WHEN p_edad_dias < 7 THEN p_primero
              ELSE greatest(p_primero, 7 * (p_edad_dias / 7)) END
$$;

-- Días enteros entre dos momentos, como `timedelta.days` de Python (redondea para abajo).
CREATE FUNCTION dias_entre(p_desde timestamptz, p_hasta timestamptz) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT floor(extract(epoch FROM p_hasta - p_desde) / 86400)::integer $$;

-- Una corrida fallida sigue sin resolver mientras no haya terminado bien una posterior de la misma fuente.
CREATE FUNCTION falla_sin_resolver(p_corrida bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM corrida c JOIN corrida c2 ON c2.fuente_id = c.fuente_id AND c2.id > c.id
                     WHERE c.id = p_corrida AND c2.estado IN ('sin_cambios', 'con_candidato'))
$$;

CREATE FUNCTION anotar_aviso(p_clave text, p_tipo text, p_fuente text, p_referencia text, p_asunto text, p_cuerpo text, p_ruta text)
RETURNS integer
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO aviso (clave, tipo, fuente_id, referencia, asunto, cuerpo, ruta)
  VALUES (p_clave, p_tipo, p_fuente, p_referencia, p_asunto, p_cuerpo, p_ruta) ON CONFLICT (clave) DO NOTHING;
  RETURN CASE WHEN FOUND THEN 1 ELSE 0 END;
END $$;

-- Detectar ---------------------------------------------------------------------------------------

-- Anota los avisos que falten y devuelve cuántos son nuevos. Lo que se avisa, en este orden:
-- - `candidato_nuevo`: hay un candidato esperando revisión.
-- - `candidato_pendiente`: sigue abierto días después (ver `hito_de_recordatorio`); `p_recordatorio_dias` = 0 los apaga.
-- - `corrida_fallida`: una corrida falló y nadie la resolvió. Una vez por racha, no por cada corrida que siga fallando.
-- - `sin_datos`: pasó la ventana del mes y no llegó el dato (ni lo publicado ni un candidato abierto lo cubren).
-- - `colector_inactivo`: no hay corridas hace dos días. Sin esto, un cron muerto lo silenciaría todo.
-- - `respaldo_fallido` (una vez por racha) y `respaldo_atrasado` (dos días sin uno bueno), después del primer respaldo.
CREATE FUNCTION detectar_avisos(p_hoy date, p_ahora timestamptz DEFAULT now(), p_dia_limite integer DEFAULT 25,
                                p_recordatorio_dias integer DEFAULT 3) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  c record;
  v_creados integer := 0;
  v_nuevos integer;
  v_cambian integer;
  v_faltan integer;
  v_ya_revisados integer;
  v_edad integer;
  v_hito integer;
  v_situacion text;
  v_esperado date := periodo_esperado(p_hoy, p_dia_limite);
  v_ultimo date;
  v_ultimo_respaldo record;
  v_bueno record;
  v_primera bigint;
  v_desde timestamptz;
BEGIN
  FOR c IN
    SELECT ca.id, ca.creado_en, co.fuente_id, f.nombre, co.resumen, count(h.id) AS hallazgos, count(h.id) FILTER (WHERE h.severidad = 'alta') AS altas
    FROM candidato ca JOIN corrida co ON co.id = ca.corrida_id JOIN fuente f ON f.id = co.fuente_id
    LEFT JOIN hallazgo h ON h.corrida_id = ca.corrida_id
    WHERE ca.estado = 'abierto' AND NOT EXISTS (SELECT 1 FROM aviso a WHERE a.clave = 'candidato_nuevo:' || ca.id)
    GROUP BY ca.id, co.id, f.id ORDER BY ca.id
  LOOP
    v_nuevos := coalesce((c.resumen ->> 'periodos_nuevos')::integer, 0);
    v_cambian := coalesce((c.resumen ->> 'periodos_cambiados')::integer, 0);
    v_faltan := coalesce((c.resumen ->> 'periodos_faltantes')::integer, 0);
    v_ya_revisados := coalesce((c.resumen ->> 'hallazgos_ya_revisados')::integer, 0);
    v_creados := v_creados + anotar_aviso(
      'candidato_nuevo:' || c.id, 'candidato_nuevo', c.fuente_id, c.id::text,
      CASE WHEN v_cambian > 0 OR v_faltan > 0 OR c.altas > 0 THEN '[Atención] ' ELSE '' END
        || format('Candidato %s para revisar (%s)', c.id, c.fuente_id),
      format('Candidato %s de %s (%s), creado el %s.', c.id, c.nombre, c.fuente_id, fecha_es(c.creado_en)) || E'\n'
        || format('Respecto de lo publicado: %s, %s, %s.', plural(v_nuevos, 'período nuevo', 'períodos nuevos'),
                  plural(v_cambian, 'dato ya publicado que cambia', 'datos ya publicados que cambian'), plural(v_faltan, 'que falta', 'que faltan'))
        || E'\n' || CASE WHEN c.hallazgos > 0
                         THEN 'Hallazgos para revisar: ' || c.hallazgos || CASE WHEN c.altas > 0 THEN format(' (%s de severidad alta)', c.altas) ELSE '' END || '.'
                         ELSE 'No tiene hallazgos.' END
        || CASE WHEN v_ya_revisados <> 0
                THEN E'\n' || format('Otros %s ya se revisaron en una publicación anterior y no se repiten.', v_ya_revisados) ELSE '' END,
      '/candidatos/' || c.id);
  END LOOP;

  IF p_recordatorio_dias > 0 THEN
    FOR c IN
      SELECT ca.id, ca.creado_en, co.fuente_id, f.nombre, count(h.id) AS hallazgos,
             count(*) FILTER (WHERE u.decision = 'rechazado') AS rechazados, count(h.id) FILTER (WHERE u.decision IS NULL) AS pendientes
      FROM candidato ca JOIN corrida co ON co.id = ca.corrida_id JOIN fuente f ON f.id = co.fuente_id
      LEFT JOIN hallazgo h ON h.corrida_id = ca.corrida_id
      LEFT JOIN LATERAL (SELECT r.decision FROM revision_hallazgo r WHERE r.hallazgo_id = h.id ORDER BY r.id DESC LIMIT 1) u ON true
      WHERE ca.estado = 'abierto' GROUP BY ca.id, co.id, f.id ORDER BY ca.id
    LOOP
      v_edad := dias_entre(c.creado_en, p_ahora);
      v_hito := hito_de_recordatorio(v_edad, p_recordatorio_dias);
      CONTINUE WHEN v_hito IS NULL;
      v_situacion := CASE
        WHEN c.rechazados > 0 THEN 'Tiene ' || plural(c.rechazados, 'hallazgo rechazado', 'hallazgos rechazados')
                                   || ': con rechazos no se puede publicar, hay que descartarlo y esperar el próximo.'
        WHEN c.pendientes > 0 THEN format('Faltan resolver %s de %s hallazgos.', c.pendientes, c.hallazgos)
        WHEN c.hallazgos > 0 THEN 'Todos los hallazgos están resueltos: está listo para publicar.'
        ELSE 'No tiene hallazgos: está listo para publicar.' END;
      v_creados := v_creados + anotar_aviso(
        format('candidato_pendiente:%s:%s', c.id, v_hito), 'candidato_pendiente', c.fuente_id, c.id::text,
        format('%s Candidato %s lleva %s días sin cerrarse (%s)', CASE WHEN v_edad >= 14 THEN '[Atención]' ELSE '[Recordatorio]' END,
               c.id, v_edad, c.fuente_id),
        format('El candidato %s de %s se creó el %s y sigue abierto, hace %s días.', c.id, c.nombre, fecha_es(c.creado_en), v_edad)
          || E'\n' || v_situacion || E'\nMientras tanto ChartBay sigue mostrando la versión anterior.',
        '/candidatos/' || c.id);
    END LOOP;
  END IF;

  -- Una vez por racha: la corrida fallida más vieja sin resolver de cada fuente.
  FOR c IN
    SELECT DISTINCT ON (co.fuente_id) co.id, co.fuente_id, f.nombre, co.iniciada_en, co.error
    FROM corrida co JOIN fuente f ON f.id = co.fuente_id
    WHERE co.estado = 'fallida' AND falla_sin_resolver(co.id) ORDER BY co.fuente_id, co.id
  LOOP
    v_creados := v_creados + anotar_aviso(
      'corrida_fallida:' || c.id, 'corrida_fallida', c.fuente_id, c.id::text,
      format('[Atención] Falló la corrida %s (%s)', c.id, c.fuente_id),
      format('La corrida %s de %s falló el %s:', c.id, c.nombre, fecha_es(c.iniciada_en)) || E'\n' || una_linea(c.error, 300)
        || E'\nMientras no termine bien una corrida posterior, no se vuelve a avisar de esta falla. Reintentar es manual.',
      '/corridas/' || c.id);
  END LOOP;

  FOR c IN SELECT f.id, f.nombre FROM fuente f WHERE EXISTS (SELECT 1 FROM corrida co WHERE co.fuente_id = f.id) ORDER BY f.id LOOP
    v_ultimo := ultimo_periodo(c.id);
    CONTINUE WHEN v_ultimo IS NULL OR v_ultimo >= v_esperado;  -- sin datos todavía, nada se atrasó
    v_creados := v_creados + anotar_aviso(
      format('sin_datos:%s:%s', c.id, to_char(v_esperado, 'YYYY-MM')), 'sin_datos', c.id, to_char(v_esperado, 'YYYY-MM'),
      format('[Atención] No llegaron los datos de %s (%s)', mes_es(v_esperado), c.id),
      format('Al %s de %s lo más nuevo que hay de %s es %s, y ya se esperaba al menos %s ', extract(day FROM p_hoy)::int,
             mes_nombre(extract(month FROM p_hoy)::int), c.nombre, mes_es(v_ultimo), mes_es(v_esperado))
        || E'(ni lo publicado ni ningún candidato abierto lo cubren).\nRevisá si la fuente publicó y si el colector está corriendo.',
      '/');
  END LOOP;

  FOR c IN
    SELECT DISTINCT ON (co.fuente_id) co.id, co.fuente_id, f.nombre, co.iniciada_en
    FROM corrida co JOIN fuente f ON f.id = co.fuente_id ORDER BY co.fuente_id, co.id DESC
  LOOP
    v_edad := dias_entre(c.iniciada_en, p_ahora);
    CONTINUE WHEN v_edad < 2;  -- la colecta corre por lo menos una vez por día
    v_creados := v_creados + anotar_aviso(
      format('colector_inactivo:%s:%s', c.fuente_id, c.id), 'colector_inactivo', c.fuente_id, c.id::text,
      format('[Atención] El colector de %s no corre desde hace %s días', c.fuente_id, v_edad),
      format('La última corrida de %s fue la %s, el %s (hace %s días).', c.nombre, c.id, fecha_es(c.iniciada_en), v_edad)
        || E'\n¿Está funcionando el cron que la dispara?',
      '/');
  END LOOP;

  SELECT r.id, r.ok, r.iniciado_en, r.error INTO v_ultimo_respaldo FROM respaldo r ORDER BY r.id DESC LIMIT 1;
  IF FOUND THEN  -- sin ningún respaldo, todavía no se configuró: no hay nada que extrañar
    SELECT r.id, r.iniciado_en INTO v_bueno FROM respaldo r WHERE r.ok ORDER BY r.id DESC LIMIT 1;
    IF NOT v_ultimo_respaldo.ok THEN
      -- Una vez por racha: la primera falla después del último respaldo bueno.
      SELECT min(r.id) INTO v_primera FROM respaldo r WHERE r.id > coalesce(v_bueno.id, 0);
      v_creados := v_creados + anotar_aviso(
        'respaldo_fallido:' || v_primera, 'respaldo_fallido', NULL, v_primera::text, '[Atención] Falló el respaldo de la base o del crudo',
        format('El respaldo del %s falló:', fecha_es(v_ultimo_respaldo.iniciado_en)) || E'\n' || una_linea(v_ultimo_respaldo.error, 400)
          || E'\nMientras no salga bien uno posterior, no se vuelve a avisar de esta falla. El detalle: python -m servicio_datos.respaldar estado',
        NULL);
    END IF;
    v_desde := coalesce(v_bueno.iniciado_en, (SELECT min(r.iniciado_en) FROM respaldo r));
    v_edad := dias_entre(v_desde, p_ahora);
    IF v_edad >= 2 THEN  -- el respaldo corre una vez por día
      v_creados := v_creados + anotar_aviso(
        'respaldo_atrasado:' || coalesce(v_bueno.id, 0), 'respaldo_atrasado', NULL, coalesce(v_bueno.id, 0)::text,
        format('[Atención] No hay un respaldo bueno hace %s días', v_edad),
        'Los respaldos de la base y del crudo corren una vez por día y '
          || CASE WHEN v_bueno.id IS NOT NULL THEN 'el último bueno es del ' || fecha_es(v_desde) ELSE 'nunca salió bien uno' END
          || E'.\n¿Está corriendo el cron? ¿Está montado el disco de destino? El detalle: python -m servicio_datos.respaldar estado',
        NULL);
    END IF;
  END IF;
  RETURN v_creados;
END $$;

-- Entregar ---------------------------------------------------------------------------------------

-- Antes de entregar: un candidato ya resuelto o un dato que ya llegó no merecen un aviso tardío.
CREATE FUNCTION aviso_vigente(p_aviso bigint, p_hoy date, p_dia_limite integer DEFAULT 25) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  a record;
  v_ultimo date;
BEGIN
  SELECT * INTO a FROM aviso WHERE id = p_aviso;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  CASE a.tipo
    WHEN 'candidato_nuevo', 'candidato_pendiente' THEN
      RETURN coalesce((SELECT estado = 'abierto' FROM candidato WHERE id = a.referencia::bigint), false);
    WHEN 'corrida_fallida' THEN
      RETURN falla_sin_resolver(a.referencia::bigint);
    WHEN 'sin_datos' THEN
      v_ultimo := ultimo_periodo(a.fuente_id);
      RETURN v_ultimo IS NOT NULL AND v_ultimo < periodo_esperado(p_hoy, p_dia_limite);
    WHEN 'colector_inactivo' THEN
      RETURN coalesce((SELECT max(id) = a.referencia::bigint FROM corrida WHERE fuente_id = a.fuente_id), false);
    WHEN 'respaldo_fallido' THEN
      RETURN coalesce((SELECT NOT ok FROM respaldo ORDER BY id DESC LIMIT 1), false);
    WHEN 'respaldo_atrasado' THEN  -- mientras no haya uno bueno más nuevo que el que se nombró
      RETURN (SELECT coalesce(max(id), 0) = a.referencia::bigint FROM respaldo WHERE ok);
    ELSE
      RETURN true;
  END CASE;
END $$;

-- Toma los avisos pendientes para entregarlos: descarta los que dejaron de ser ciertos y reserva el resto por `p_segundos`.
-- Devuelve {descartados, en_curso (los que tiene reservados otra entrega), avisos: [{id, asunto, cuerpo, ruta, entregas,
-- intentos}]}, en orden.
CREATE FUNCTION tomar_avisos(p_hoy date, p_dia_limite integer DEFAULT 25, p_segundos integer DEFAULT 300) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  a record;
  v_descartados integer := 0;
  v_avisos jsonb := '[]'::jsonb;
  v_en_curso integer;
BEGIN
  SELECT count(*) INTO v_en_curso FROM aviso WHERE estado = 'pendiente' AND tomado_hasta > now();
  FOR a IN
    SELECT id, asunto, cuerpo, ruta, entregas, intentos FROM aviso
    WHERE estado = 'pendiente' AND (tomado_hasta IS NULL OR tomado_hasta <= now())
    ORDER BY id FOR UPDATE SKIP LOCKED
  LOOP
    IF NOT aviso_vigente(a.id, p_hoy, p_dia_limite) THEN
      UPDATE aviso SET estado = 'descartado', tomado_hasta = NULL WHERE id = a.id;
      v_descartados := v_descartados + 1;
      CONTINUE;
    END IF;
    UPDATE aviso SET tomado_hasta = now() + make_interval(secs => p_segundos) WHERE id = a.id;
    v_avisos := v_avisos || jsonb_build_object('id', a.id, 'asunto', a.asunto, 'cuerpo', a.cuerpo, 'ruta', a.ruta,
                                               'entregas', a.entregas, 'intentos', a.intentos);
  END LOOP;
  RETURN jsonb_build_object('descartados', v_descartados, 'en_curso', v_en_curso, 'avisos', v_avisos);
END $$;

-- Cómo le fue a una entrega: `p_entregas` es, por canal, {ok, en} o {ok: false, error} (sin secretos); `p_completo`, si llegó
-- por todos. Después de 5 intentos sin completarse, el aviso se da por perdido. Devuelve el estado en que queda.
CREATE FUNCTION registrar_entrega(p_aviso bigint, p_entregas jsonb, p_completo boolean) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_estado text;
BEGIN
  UPDATE aviso SET intentos = intentos + 1, entregas = coalesce(p_entregas, '{}'::jsonb), tomado_hasta = NULL,
         estado = CASE WHEN p_completo THEN 'enviado' WHEN intentos + 1 >= 5 THEN 'fallido' ELSE 'pendiente' END,
         enviado_en = CASE WHEN p_completo THEN now() END
  WHERE id = p_aviso AND estado = 'pendiente'
  RETURNING estado INTO v_estado;
  IF NOT FOUND THEN
    SELECT estado INTO v_estado FROM aviso WHERE id = p_aviso;
    IF NOT FOUND THEN
      PERFORM falla('no_existe', format('No existe el aviso %s', p_aviso));
    END IF;
  END IF;
  RETURN v_estado;
END $$;

CALL fijar_search_path();
