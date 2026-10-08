-- Los avisos del respaldo hablan de dónde corre ahora: el flujo de GitHub Actions que respalda Supabase (plan:
-- docs/base-datos-supabase.md, paso 7), no el cron del equipo Ubuntu. El resto de `detectar_avisos` queda igual que en la 0014.

CREATE OR REPLACE FUNCTION detectar_avisos(p_hoy date, p_ahora timestamptz DEFAULT now(), p_dia_limite integer DEFAULT 25,
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
          || E'\nMientras no salga bien uno posterior, no se vuelve a avisar de esta falla. El detalle está en la última corrida del flujo «Respaldo de datos» de GitHub Actions.',
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
          || E'.\n¿Sigue activo el flujo «Respaldo de datos» de GitHub Actions? ¿Siguen valiendo sus secretos (la clave de la base y las del bucket)?',
        NULL);
    END IF;
  END IF;
  RETURN v_creados;
END $$;

CALL fijar_search_path();
