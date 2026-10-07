-- La validación del IPC y la carga del candidato pasan a ser funciones de la base (plan: docs/base-datos-supabase.md, paso 2).
--
-- Lo que corra la colecta (hoy Python; en Supabase, una Edge Function) baja los archivos, los lee y llama a
-- `cargar_candidato` con lo que leyó. Desde ahí todo pasa en la base y en una sola transacción: comparar con lo vigente,
-- validar, descartar el candidato abierto, crear el nuevo y cerrar la corrida.
--
-- La carga es un JSON:
--   {"series": [{"serie_id", "archivo", "hoja", "fila_origen", "observaciones": [["2016-12-01", "100.0"], ...], "notas": [...]}],
--    "definiciones": {"<serie_id>": {"nombre", "tema", "nivel", "territorio", "clasificacion", "frecuencia", "unidad", "base"}},
--    "descargados": ["nacional", "aperturas"]}
-- Los valores van como texto para no perder decimales. `descargados` son las claves de los archivos bajados en esta
-- corrida (la regla de frescura solo mira las series que salen de ellos).
--
-- `validar_ipc` replica, regla por regla y con los mismos textos, `ipc/validacion.py`; las pruebas comparan las dos.

CREATE FUNCTION meses(p_fecha date) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT extract(year FROM p_fecha)::integer * 12 + extract(month FROM p_fecha)::integer - 1 $$;

CREATE FUNCTION finito(p_valor numeric) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT p_valor IS NOT NULL AND p_valor NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) $$;

-- Redondeo al par en los empates (25,125 → 25,12), como el formato de Python: los textos de los hallazgos son idénticos.
CREATE FUNCTION redondeo_par(x numeric, d integer) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT round(CASE WHEN abs(x * f - trunc(x * f)) = 0.5
                    THEN (trunc(x * f) + CASE WHEN mod(trunc(x * f), 2) = 0 THEN 0 ELSE sign(x) END) / f
                    ELSE round(x, d) END, d)
  FROM (SELECT power(10::numeric, d) AS f) k
$$;

-- Que la carga tenga la forma esperada antes de mirarla: una lista de series con id, observaciones [fecha, valor-como-texto]
-- y notas, sin series ni períodos repetidos. Si no, falla con `carga_invalida`.
CREATE FUNCTION revisar_carga(p_series jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_mal text;
BEGIN
  IF jsonb_typeof(p_series) IS DISTINCT FROM 'array' THEN
    PERFORM falla('carga_invalida', 'La carga no trae una lista de series');
  END IF;
  SELECT coalesce(x->>'serie_id', '(sin id)') INTO v_mal FROM jsonb_array_elements(p_series) x
  WHERE jsonb_typeof(x) <> 'object' OR coalesce(x->>'serie_id', '') !~ '^[a-z0-9_]+$'
     OR jsonb_typeof(coalesce(x->'observaciones', '[]'::jsonb)) <> 'array' OR jsonb_typeof(coalesce(x->'notas', '[]'::jsonb)) <> 'array'
  LIMIT 1;
  IF FOUND THEN
    PERFORM falla('carga_invalida', format('La serie %s no tiene la forma esperada', v_mal));
  END IF;
  SELECT x->>'serie_id' INTO v_mal FROM jsonb_array_elements(p_series) x, jsonb_array_elements(coalesce(x->'observaciones', '[]'::jsonb)) y
  WHERE CASE WHEN jsonb_typeof(y) = 'array' AND jsonb_array_length(y) = 2
             THEN coalesce(y->>0, '') !~ '^\d{4}-\d{2}-\d{2}$' OR coalesce(y->>1, '') !~ '^(-?\d+(\.\d+)?|NaN|-?Infinity)$'
             ELSE true END
  LIMIT 1;
  IF FOUND THEN
    PERFORM falla('carga_invalida', format('Una observación de %s no tiene la forma ["AAAA-MM-DD", "valor"]', v_mal));
  END IF;
  IF (SELECT count(*) <> count(DISTINCT x->>'serie_id') FROM jsonb_array_elements(p_series) x) THEN
    PERFORM falla('carga_invalida', 'Una serie aparece más de una vez en la carga');
  END IF;
END $$;

-- Controles determinísticos del IPC: solo emiten hallazgos, nunca corrigen un dato.
CREATE FUNCTION validar_ipc(p_series jsonb, p_hoy date, p_descargados text[] DEFAULT '{}')
RETURNS TABLE (orden integer, regla text, severidad text, serie_id text, periodo date, detalle text)
LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
DECLARE
  c_nacional constant text := 'ipc_ng_nacional';
  c_regiones constant text[] := ARRAY['ipc_ng_gba', 'ipc_ng_pampeana', 'ipc_ng_noa', 'ipc_ng_nea', 'ipc_ng_cuyo', 'ipc_ng_patagonia'];
  c_umbral constant numeric := 20;  -- % de variación mensual que se marca para revisar
  c_dia_limite constant integer := 25;
  v_esperadas text[] := ARRAY['ipc_ng_nacional'] || c_regiones;
  v_n integer := 0;
  v_serie jsonb;
  v_obs jsonb;
  v_id text;
  v_periodo date;
  v_valor numeric;
  v_ant_periodo date;
  v_ant_valor numeric;
  v_variacion numeric;
  v_texto text;
  v_vigente record;
  v_actual numeric;
  v_maximo date;
  v_esperado date;
  v_fila record;
BEGIN
  PERFORM revisar_carga(p_series);

  -- Estructura: las series esperadas que faltan y las que sobran, en orden alfabético.
  FOR v_id IN SELECT e FROM unnest(v_esperadas) e
              WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_series) x WHERE x->>'serie_id' = e) ORDER BY e COLLATE "C" LOOP
    v_n := v_n + 1;
    RETURN QUERY SELECT v_n, 'estructura', 'alta', v_id, NULL::date, format('Falta la serie esperada %s.', v_id);
  END LOOP;
  FOR v_id IN SELECT x->>'serie_id' FROM jsonb_array_elements(p_series) x
              WHERE NOT (x->>'serie_id' = ANY (v_esperadas)) ORDER BY x->>'serie_id' COLLATE "C" LOOP
    v_n := v_n + 1;
    RETURN QUERY SELECT v_n, 'estructura', 'alta', v_id, NULL::date, format('La serie %s no pertenece al IPC configurado.', v_id);
  END LOOP;

  -- Serie por serie, en el orden de la carga.
  FOR v_serie IN SELECT x FROM jsonb_array_elements(p_series) WITH ORDINALITY t(x, i) ORDER BY i LOOP
    v_id := v_serie->>'serie_id';
    IF jsonb_array_length(coalesce(v_serie->'observaciones', '[]'::jsonb)) = 0 THEN
      v_n := v_n + 1;
      RETURN QUERY SELECT v_n, 'estructura', 'alta', v_id, NULL::date, format('La serie %s está vacía.', v_id);
      CONTINUE;
    END IF;
    v_periodo := (v_serie->'observaciones'->0->>0)::date;
    v_valor := (v_serie->'observaciones'->0->>1)::numeric;
    IF NOT (v_periodo = date '2016-12-01' AND finito(v_valor) AND v_valor = 100) THEN
      v_n := v_n + 1;
      RETURN QUERY SELECT v_n, 'base_referencia', 'alta', v_id, v_periodo, format('%s ya no inicia en diciembre de 2016 con índice 100.', v_id);
    END IF;

    v_ant_periodo := NULL;
    v_ant_valor := NULL;
    FOR v_obs IN SELECT y FROM jsonb_array_elements(v_serie->'observaciones') WITH ORDINALITY u(y, j) ORDER BY j LOOP
      v_periodo := (v_obs->>0)::date;
      v_valor := (v_obs->>1)::numeric;
      IF extract(day FROM v_periodo) <> 1 OR (v_ant_periodo IS NOT NULL AND meses(v_periodo) - meses(v_ant_periodo) <> 1) THEN
        v_n := v_n + 1;
        RETURN QUERY SELECT v_n, 'continuidad', 'alta', v_id, v_periodo,
          format('%s tiene un mes ausente, repetido, desordenado o con día distinto del primero: %s.', v_id, to_char(v_periodo, 'YYYY-MM-DD'));
      END IF;
      IF NOT finito(v_valor) OR v_valor <= 0 THEN
        v_n := v_n + 1;
        RETURN QUERY SELECT v_n, 'rango', 'alta', v_id, v_periodo,
          format('%s tiene un índice no positivo o no finito en %s.', v_id, to_char(v_periodo, 'YYYY-MM-DD'));
      ELSIF v_ant_periodo IS NOT NULL AND finito(v_ant_valor) AND v_ant_valor > 0 AND meses(v_periodo) - meses(v_ant_periodo) = 1 THEN
        v_variacion := (v_valor / v_ant_valor - 1) * 100;
        IF abs(v_variacion) > c_umbral THEN
          v_n := v_n + 1;
          RETURN QUERY SELECT v_n, 'salto_mensual', 'media', v_id, v_periodo,
            format('%s varió %s%% en %s; supera el umbral de %s%%.', v_id, redondeo_par(v_variacion, 2), to_char(v_periodo, 'YYYY-MM-DD'), c_umbral);
        END IF;
      END IF;
      v_ant_periodo := v_periodo;
      v_ant_valor := v_valor;
    END LOOP;

    FOR v_texto IN SELECT n FROM jsonb_array_elements_text(coalesce(v_serie->'notas', '[]'::jsonb)) WITH ORDINALITY u(n, j) ORDER BY j LOOP
      v_n := v_n + 1;
      RETURN QUERY SELECT v_n, 'fecha_normalizada', 'baja', v_id, NULL::date, format('%s: %s.', v_id, v_texto);
    END LOOP;

    -- Lo publicado de esta serie tiene que seguir igual en el archivo nuevo.
    FOR v_vigente IN SELECT ov.periodo AS p, ov.valor AS v FROM observacion_vigente ov WHERE ov.serie_id = v_id ORDER BY ov.periodo LOOP
      SELECT (y->>1)::numeric INTO v_actual FROM jsonb_array_elements(v_serie->'observaciones') WITH ORDINALITY u(y, j)
      WHERE (y->>0)::date = v_vigente.p ORDER BY j DESC LIMIT 1;
      IF NOT FOUND THEN
        v_n := v_n + 1;
        RETURN QUERY SELECT v_n, 'historia_intacta', 'alta', v_id, v_vigente.p,
          format('%s: el período %s publicado antes falta en el archivo nuevo.', v_id, to_char(v_vigente.p, 'YYYY-MM-DD'));
      ELSIF v_actual IS DISTINCT FROM v_vigente.v THEN
        v_n := v_n + 1;
        RETURN QUERY SELECT v_n, 'historia_intacta', 'alta', v_id, v_vigente.p,
          format('%s: %s pasó de %s a %s.', v_id, to_char(v_vigente.p, 'YYYY-MM-DD'), v_vigente.v, v_actual);
      END IF;
    END LOOP;
  END LOOP;

  -- Cobertura: todas las series tienen que terminar el mismo mes (el último dato de cada una, como viene en la carga).
  SELECT max((x->'observaciones'->-1->>0)::date) INTO v_maximo FROM jsonb_array_elements(p_series) x
  WHERE jsonb_array_length(coalesce(x->'observaciones', '[]'::jsonb)) > 0;
  FOR v_fila IN SELECT x->>'serie_id' AS id, (x->'observaciones'->-1->>0)::date AS ultimo
                FROM jsonb_array_elements(p_series) WITH ORDINALITY t(x, i)
                WHERE jsonb_array_length(coalesce(x->'observaciones', '[]'::jsonb)) > 0 ORDER BY i LOOP
    IF v_fila.ultimo <> v_maximo THEN
      v_n := v_n + 1;
      RETURN QUERY SELECT v_n, 'cobertura', 'alta', v_fila.id, v_fila.ultimo,
        format('%s termina en %s; otras series llegan a %s.', v_fila.id, to_char(v_fila.ultimo, 'YYYY-MM'), to_char(v_maximo, 'YYYY-MM'));
    END IF;
  END LOOP;

  -- El nacional tiene que quedar dentro del rango de las seis regiones, en cada mes que tienen todas.
  FOR v_fila IN
    WITH valores AS (  -- el último valor de cada serie y mes, como un diccionario
      SELECT DISTINCT ON (x->>'serie_id', (y->>0)::date) x->>'serie_id' AS id, (y->>0)::date AS p, (y->>1)::numeric AS v, i, j
      FROM jsonb_array_elements(p_series) WITH ORDINALITY t(x, i), jsonb_array_elements(coalesce(x->'observaciones', '[]'::jsonb)) WITH ORDINALITY u(y, j)
      ORDER BY x->>'serie_id', (y->>0)::date, j DESC),
    orden AS (
      SELECT (y->>0)::date AS p, min(j) AS primero
      FROM jsonb_array_elements(p_series) x, jsonb_array_elements(coalesce(x->'observaciones', '[]'::jsonb)) WITH ORDINALITY u(y, j)
      WHERE x->>'serie_id' = c_nacional GROUP BY 1)
    SELECT n.p, n.v, min(r.v) AS minimo, max(r.v) AS maximo, bool_and(finito(r.v)) AS finitos, count(r.id) AS regiones
    FROM valores n JOIN orden o ON o.p = n.p JOIN valores r ON r.p = n.p AND r.id = ANY (c_regiones)
    WHERE n.id = c_nacional GROUP BY n.p, n.v, o.primero ORDER BY o.primero
  LOOP
    IF v_fila.regiones = cardinality(c_regiones) AND finito(v_fila.v) AND v_fila.finitos AND (v_fila.v < v_fila.minimo OR v_fila.v > v_fila.maximo) THEN
      v_n := v_n + 1;
      RETURN QUERY SELECT v_n, 'cruce_regional', 'media', c_nacional, v_fila.p,
        format('IPC nacional %s fuera del rango regional [%s, %s] en %s.', v_fila.v, v_fila.minimo, v_fila.maximo, to_char(v_fila.p, 'YYYY-MM-DD'));
    END IF;
  END LOOP;

  -- Frescura: antes del día límite se espera como mínimo el mes antepasado; después, el anterior. Solo para lo bajado ahora.
  v_esperado := make_date((meses(p_hoy) - CASE WHEN extract(day FROM p_hoy) > c_dia_limite THEN 1 ELSE 2 END) / 12,
                          (meses(p_hoy) - CASE WHEN extract(day FROM p_hoy) > c_dia_limite THEN 1 ELSE 2 END) % 12 + 1, 1);
  FOR v_fila IN SELECT x->>'serie_id' AS id, (x->'observaciones'->-1->>0)::date AS ultimo
                FROM jsonb_array_elements(p_series) WITH ORDINALITY t(x, i)
                WHERE jsonb_array_length(coalesce(x->'observaciones', '[]'::jsonb)) > 0 AND x->>'archivo' = ANY (p_descargados) ORDER BY i LOOP
    IF v_fila.ultimo < v_esperado THEN
      v_n := v_n + 1;
      RETURN QUERY SELECT v_n, 'frescura', 'media', v_fila.id, v_fila.ultimo,
        format('%s llega a %s; al %s se esperaba al menos %s.', v_fila.id, to_char(v_fila.ultimo, 'YYYY-MM'), to_char(p_hoy, 'YYYY-MM-DD'), to_char(v_esperado, 'YYYY-MM'));
    END IF;
  END LOOP;
END $$;

-- Lo que el orquestador hacía después de leer los archivos, en una transacción. La corrida tiene que estar en curso.
-- Devuelve {estado: 'sin_cambios' | 'con_candidato', corrida, candidato_id, hallazgos, ...}. Una carga que no se entiende
-- falla con `carga_invalida` y no deja nada: quien llama cierra la corrida como fallida.
CREATE FUNCTION cargar_candidato(p_corrida bigint, p_hoy date, p_carga jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  v_fuente text;
  v_estado text;
  v_series jsonb := p_carga->'series';
  v_descargados text[];
  v_nuevos integer;
  v_cambiados integer;
  v_faltantes integer;
  v_candidato bigint;
  v_reemplazados jsonb;
  v_desconocida text;
  v_total integer;
  v_guardados integer;
  v_conteo jsonb;
  v_diferencias jsonb;
BEGIN
  SELECT fuente_id, estado INTO v_fuente, v_estado FROM corrida WHERE id = p_corrida FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM falla('no_existe', format('No existe la corrida %s', p_corrida));
  END IF;
  IF v_estado <> 'en_curso' THEN
    PERFORM falla('corrida_cerrada', format('La corrida %s ya terminó (estado: %s)', p_corrida, v_estado));
  END IF;
  PERFORM revisar_carga(v_series);
  IF jsonb_array_length(v_series) = 0 THEN
    PERFORM falla('carga_invalida', 'La carga no trae ninguna serie');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_series) x, jsonb_array_elements(coalesce(x->'observaciones', '[]'::jsonb)) y
             GROUP BY x->>'serie_id', (y->>0)::date HAVING count(*) > 1) THEN
    PERFORM falla('carga_invalida', 'Un período aparece más de una vez en una serie');
  END IF;
  v_descargados := ARRAY(SELECT jsonb_array_elements_text(coalesce(p_carga->'descargados', '[]'::jsonb)));

  -- Las series que faltan se crean con su definición; una ya creada no se toca (sus datos son del catálogo).
  INSERT INTO serie (id, fuente_id, nombre, tema, nivel, territorio, clasificacion, frecuencia, unidad, base, hoja_origen, fila_origen)
  SELECT d.key, v_fuente, d.value->>'nombre', d.value->>'tema', d.value->>'nivel', d.value->>'territorio', d.value->>'clasificacion',
         d.value->>'frecuencia', d.value->>'unidad', d.value->>'base', s->>'hoja', (s->>'fila_origen')::integer
  FROM jsonb_each(coalesce(p_carga->'definiciones', '{}'::jsonb)) d
  LEFT JOIN LATERAL (SELECT x AS s FROM jsonb_array_elements(v_series) x WHERE x->>'serie_id' = d.key) o ON true
  ON CONFLICT (id) DO NOTHING;
  SELECT x->>'serie_id' INTO v_desconocida FROM jsonb_array_elements(v_series) x
  WHERE NOT EXISTS (SELECT 1 FROM serie se WHERE se.id = x->>'serie_id' AND se.fuente_id = v_fuente) LIMIT 1;
  IF FOUND THEN
    PERFORM falla('carga_invalida', format('La serie %s no está definida para %s: falta en las definiciones de la carga', v_desconocida, v_fuente));
  END IF;

  -- Cuánto cambia respecto de lo publicado, en períodos.
  WITH propuestas AS (
    SELECT x->>'serie_id' AS id, (y->>0)::date AS p, (y->>1)::numeric AS v
    FROM jsonb_array_elements(v_series) x, jsonb_array_elements(coalesce(x->'observaciones', '[]'::jsonb)) y),
  vigentes AS (
    SELECT ov.serie_id AS id, ov.periodo AS p, ov.valor AS v FROM observacion_vigente ov JOIN serie se ON se.id = ov.serie_id WHERE se.fuente_id = v_fuente)
  SELECT (SELECT count(*) FROM propuestas pr WHERE NOT EXISTS (SELECT 1 FROM vigentes vi WHERE vi.id = pr.id AND vi.p = pr.p)),
         (SELECT count(*) FROM propuestas pr JOIN vigentes vi ON vi.id = pr.id AND vi.p = pr.p WHERE vi.v IS DISTINCT FROM pr.v),
         (SELECT count(*) FROM vigentes vi WHERE NOT EXISTS (SELECT 1 FROM propuestas pr WHERE pr.id = vi.id AND pr.p = vi.p))
    INTO v_nuevos, v_cambiados, v_faltantes;
  v_diferencias := jsonb_build_object('periodos_nuevos', v_nuevos, 'periodos_cambiados', v_cambiados, 'periodos_faltantes', v_faltantes);

  -- Un archivo nuevo con exactamente los datos ya publicados no es una novedad.
  IF v_nuevos + v_cambiados + v_faltantes = 0
     AND EXISTS (SELECT 1 FROM observacion_vigente ov JOIN serie se ON se.id = ov.serie_id WHERE se.fuente_id = v_fuente) THEN
    UPDATE corrida SET estado = 'sin_cambios', terminada_en = now(),
           resumen = resumen || v_diferencias || jsonb_build_object('motivo', 'Archivos nuevos con los mismos datos que el release vigente')
    WHERE id = p_corrida;
    RETURN jsonb_build_object('estado', 'sin_cambios', 'corrida', p_corrida) || v_diferencias;
  END IF;

  WITH reemplazados AS (
    UPDATE candidato SET estado = 'descartado', decidido_en = now(), decidido_por = 'sistema',
           motivo = format('Reemplazado por el candidato de la corrida %s', p_corrida)
    WHERE estado = 'abierto' AND corrida_id IN (SELECT id FROM corrida WHERE fuente_id = v_fuente)
    RETURNING id)
  SELECT coalesce(jsonb_agg(id ORDER BY id), '[]'::jsonb) INTO v_reemplazados FROM reemplazados;

  INSERT INTO candidato (corrida_id) VALUES (p_corrida) RETURNING id INTO v_candidato;
  INSERT INTO observacion_candidata (candidato_id, serie_id, periodo, valor)
  SELECT v_candidato, x->>'serie_id', (y->>0)::date, (y->>1)::numeric
  FROM jsonb_array_elements(v_series) x, jsonb_array_elements(coalesce(x->'observaciones', '[]'::jsonb)) y;

  -- Lo que ya se revisó al publicar no vuelve a la cola: si no, el mismo aviso histórico reaparecería cada mes.
  SELECT count(*) INTO v_total FROM validar_ipc(v_series, p_hoy, v_descargados);
  INSERT INTO hallazgo (corrida_id, serie_id, periodo, regla, severidad, detalle)
  SELECT p_corrida, CASE WHEN EXISTS (SELECT 1 FROM serie se WHERE se.id = h.serie_id AND se.fuente_id = v_fuente) THEN h.serie_id END,
         h.periodo, h.regla, h.severidad, h.detalle
  FROM validar_ipc(v_series, p_hoy, v_descargados) h
  WHERE NOT EXISTS (
    SELECT 1 FROM hallazgo r JOIN candidato c ON c.corrida_id = r.corrida_id JOIN release rl ON rl.candidato_id = c.id
    JOIN corrida co ON co.id = c.corrida_id
    WHERE co.fuente_id = v_fuente AND r.regla = h.regla AND r.serie_id IS NOT DISTINCT FROM h.serie_id
      AND r.periodo IS NOT DISTINCT FROM h.periodo AND r.detalle IS NOT DISTINCT FROM h.detalle)
  ORDER BY h.orden;
  GET DIAGNOSTICS v_guardados = ROW_COUNT;
  SELECT jsonb_build_object('alta', count(*) FILTER (WHERE severidad = 'alta'), 'media', count(*) FILTER (WHERE severidad = 'media'),
                            'baja', count(*) FILTER (WHERE severidad = 'baja'))
    INTO v_conteo FROM hallazgo WHERE corrida_id = p_corrida;

  UPDATE corrida SET estado = 'con_candidato', terminada_en = now(), resumen = resumen || v_diferencias || jsonb_build_object(
    'candidato_id', v_candidato,
    'series', jsonb_array_length(v_series),
    'observaciones', (SELECT count(*) FROM observacion_candidata WHERE candidato_id = v_candidato),
    'hallazgos', v_conteo,
    'hallazgos_ya_revisados', v_total - v_guardados,
    -- De dónde salió cada serie y qué se normalizó al leerla: viaja con el release.
    'detalle_series', (SELECT coalesce(jsonb_object_agg(x->>'serie_id', jsonb_build_object(
        'archivo', x->>'archivo', 'hoja', x->>'hoja', 'fila_origen', (x->>'fila_origen')::integer, 'notas', coalesce(x->'notas', '[]'::jsonb))), '{}'::jsonb)
      FROM jsonb_array_elements(v_series) x),
    'reemplaza_candidatos', v_reemplazados)
  WHERE id = p_corrida;
  RETURN jsonb_build_object('estado', 'con_candidato', 'corrida', p_corrida, 'candidato_id', v_candidato, 'hallazgos', v_guardados,
                            'hallazgos_ya_revisados', v_total - v_guardados, 'reemplaza_candidatos', v_reemplazados) || v_diferencias;
END $$;
