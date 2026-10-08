-- El analista como funciones de la base (plan: docs/base-datos-supabase.md, paso 6).
--
-- El modelo de lenguaje no busca nada ni consulta la base: recibe una lista numerada de hechos ya comprobados (`hechos_de`) y
-- solo puede citarlos. Lo que contesta pasa por el validador (`validar_dictamen`), que lo deja pasar solo en la medida en que
-- esos hechos lo sostienen, y recién ahí se guarda como propuesta. Las tres cosas están acá, así que quien llama al modelo (la
-- Edge Function `analizar` o el analista de Python) no puede inventar hechos ni guardar una propuesta que no pasó por el
-- validador: le entrega a `proponer` lo que dijo el modelo y la base hace el resto.
--
-- El analista solo escribe `propuesta`. No toca el candidato, no decide hallazgos y no publica.

-- Formato ---------------------------------------------------------------------------------------

-- Un número como lo escribe una persona en Argentina: 1.234,56 (redondeo al par, como Python).
CREATE FUNCTION num_es(p_valor numeric, p_decimales integer DEFAULT 2) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_valor < 0 THEN '-' ELSE '' END
         || regexp_replace(trunc(r)::text, '(\d)(?=(\d{3})+$)', '\1.', 'g')
         || CASE WHEN p_decimales > 0 THEN ',' || lpad(((r - trunc(r)) * power(10::numeric, p_decimales))::bigint::text, p_decimales, '0') ELSE '' END
  FROM (SELECT redondeo_par(abs(p_valor), p_decimales) AS r) x
$$;

-- Una variación con signo: +25,0% o -3,2%.
CREATE FUNCTION pct_es(p_valor numeric) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p_valor < 0 THEN '-' ELSE '+' END || num_es(abs(p_valor), 1) || '%' $$;

-- "mar 2026"
CREATE FUNCTION mes_corto(p_periodo date) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT (ARRAY['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'])[extract(month FROM p_periodo)::int]
         || ' ' || extract(year FROM p_periodo)::int
$$;

-- "10 de septiembre de 2026"
CREATE FUNCTION fecha_larga(p_fecha date) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT extract(day FROM p_fecha)::int || ' de ' || mes_nombre(extract(month FROM p_fecha)::int) || ' de ' || extract(year FROM p_fecha)::int
$$;

-- Un texto que puede venir del archivo de la fuente o del modelo: sin caracteres de control, en una línea y con tope.
CREATE FUNCTION limpiar_texto(p_texto text, p_tope integer) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(x) <= p_tope THEN x ELSE rtrim(left(x, p_tope - 1)) || '…' END
  FROM (SELECT btrim(regexp_replace(regexp_replace(coalesce(p_texto, ''), '[\x01-\x08\x0b-\x1f\x7f]', '', 'g'), '\s+', ' ', 'g')) AS x) t
$$;

-- Una división con más decimales que los que da Postgres por defecto, para que los cortes (la mitad, un cuarto) den lo mismo
-- que con los decimales de Python.
CREATE FUNCTION dividir(a numeric, b numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$ SELECT (a + 0.0000000000000000000000000000) / b $$;

-- La variación porcentual de un mes respecto del anterior, o NULL si falta alguno.
CREATE FUNCTION variacion(p_actual numeric, p_anterior numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_actual IS NULL OR p_anterior IS NULL OR p_anterior = 0 THEN NULL ELSE (dividir(p_actual, p_anterior) - 1) * 100 END
$$;

-- De qué archivo salió una serie de la corrida (lo anotó la colecta en el resumen): {nombre, publicada_en}. La fecha es el
-- Last-Modified del servidor, tal como quedó escrita (en UTC).
CREATE FUNCTION archivo_de(p_resumen jsonb, p_serie text) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('nombre', regexp_replace(a ->> 'url', '^.*/', ''), 'publicada_en', nullif(a ->> 'publicada_en', ''))
  FROM jsonb_array_elements(coalesce(p_resumen -> 'archivos', '[]'::jsonb)) WITH ORDINALITY x(a, n)
  WHERE p_serie IS NOT NULL AND a ->> 'clave' = p_resumen -> 'detalle_series' -> p_serie ->> 'archivo'
  ORDER BY n DESC LIMIT 1
$$;

-- Los hechos ---------------------------------------------------------------------------------------

-- Lo que trae un candidato y lo que está publicado de una fuente, para comparar.
CREATE FUNCTION obs_candidato(p_candidato bigint) RETURNS TABLE (serie_id text, periodo date, valor numeric)
LANGUAGE sql STABLE AS $$ SELECT o.serie_id, o.periodo, o.valor FROM observacion_candidata o WHERE o.candidato_id = p_candidato $$;

CREATE FUNCTION obs_vigente(p_fuente text) RETURNS TABLE (serie_id text, periodo date, valor numeric)
LANGUAGE sql STABLE AS $$ SELECT o.serie_id, o.periodo, o.valor FROM observacion_vigente o JOIN serie s ON s.id = o.serie_id WHERE s.fuente_id = p_fuente $$;

-- Lo que el código comprueba en los datos sobre un hallazgo, numerado desde 1: [{id, texto, etiquetas}]. Las etiquetas dicen de
-- qué clase es cada hecho, y el validador exige la clase correcta para sostener cada conclusión (por ejemplo, "el archivo está
-- atrasado" solo se puede decir citando un hecho `archivo`). Es determinístico: el mismo hallazgo da siempre los mismos hechos.
CREATE FUNCTION hechos_de(p_hallazgo bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  h record;
  v_hechos jsonb := '[]'::jsonb;
  v_nombre text;
  v_release record;
  v_actual numeric;
  v_anterior numeric;
  v_siguiente numeric;
  v_var numeric;
  v_otras integer;
  v_mismas integer;
  v_mayor numeric;
  v_min_mismas numeric;
  v_max_mismas numeric;
  v_variaciones numeric[];
  v_mismas_lista numeric[];
  v_publicado numeric;
  v_nuevo numeric;
  v_cambian integer;
  v_desde date;
  v_hasta date;
  v_series_vigentes integer;
  v_con_cambios integer;
  v_archivo jsonb;
  v_otro jsonb;
  v_ultimo date;
  v_maximo date;
  v_delante text;
  v_dias integer;
  v_primero date;
  v_texto text;
BEGIN
  SELECT hz.id, hz.regla, hz.serie_id, hz.periodo, hz.detalle, s.nombre AS serie_nombre, c.id AS candidato_id, co.fuente_id, co.resumen
  INTO h FROM hallazgo hz JOIN corrida co ON co.id = hz.corrida_id JOIN candidato c ON c.corrida_id = hz.corrida_id
  LEFT JOIN serie s ON s.id = hz.serie_id WHERE hz.id = p_hallazgo;
  IF NOT FOUND THEN
    PERFORM falla('no_existe', format('No existe el hallazgo %s o no tiene candidato', p_hallazgo));
  END IF;
  v_nombre := coalesce(h.serie_nombre, h.serie_id);
  SELECT r.release_id, r.publicado_en INTO v_release FROM release r JOIN candidato c ON c.id = r.candidato_id
  JOIN corrida co ON co.id = c.corrida_id WHERE co.fuente_id = h.fuente_id ORDER BY r.numero DESC LIMIT 1;
  v_archivo := archivo_de(h.resumen, h.serie_id);

  IF h.regla = 'salto_mensual' THEN
    SELECT valor INTO v_actual FROM obs_candidato(h.candidato_id) WHERE serie_id = h.serie_id AND periodo = h.periodo;
    SELECT valor INTO v_anterior FROM obs_candidato(h.candidato_id) WHERE serie_id = h.serie_id AND periodo = (h.periodo - interval '1 month')::date;
    v_var := variacion(v_actual, v_anterior);
    IF v_var IS NULL THEN
      v_hechos := jsonb_build_array(jsonb_build_object('texto', 'No hay datos suficientes de esa serie para comparar el mes con el anterior.', 'etiquetas', '[]'::jsonb));
    ELSE
      v_hechos := v_hechos || jsonb_build_object('texto', format('%s: el índice pasa de %s a %s en %s (%s).', v_nombre, num_es(v_anterior), num_es(v_actual),
                                                                mes_corto(h.periodo), pct_es(v_var)), 'etiquetas', '["valor"]'::jsonb);
      SELECT coalesce(array_agg(v), '{}') INTO v_variaciones
      FROM (SELECT variacion(a.valor, b.valor) AS v FROM obs_candidato(h.candidato_id) a
            JOIN obs_candidato(h.candidato_id) b ON b.serie_id = a.serie_id AND b.periodo = (a.periodo - interval '1 month')::date
            WHERE a.periodo = h.periodo AND a.serie_id IS DISTINCT FROM h.serie_id) o
      WHERE v IS NOT NULL;
      v_otras := cardinality(v_variaciones);
      SELECT max(abs(v)) INTO v_mayor FROM unnest(v_variaciones) v;
      SELECT coalesce(array_agg(v), '{}') INTO v_mismas_lista FROM unnest(v_variaciones) v WHERE v * v_var > 0 AND abs(v) >= abs(v_var) / 2;
      v_mismas := cardinality(v_mismas_lista);
      SELECT v INTO v_min_mismas FROM unnest(v_mismas_lista) v ORDER BY abs(v) LIMIT 1;
      SELECT v INTO v_max_mismas FROM unnest(v_mismas_lista) v ORDER BY abs(v) DESC LIMIT 1;
      IF v_otras > 0 THEN
        IF v_mismas::numeric / v_otras >= 0.8 THEN
          v_hechos := v_hechos || jsonb_build_object('texto', format(
            'En %s, %s de las otras %s series también se mueven en el mismo sentido (entre %s y %s): no es algo propio de esta serie.',
            mes_corto(h.periodo), v_mismas, v_otras, pct_es(v_min_mismas), pct_es(v_max_mismas)), 'etiquetas', '["sistemico"]'::jsonb);
        ELSIF v_mayor < abs(v_var) / 4 THEN
          v_hechos := v_hechos || jsonb_build_object('texto', format('Ninguna de las otras %s series se mueve más de %s ese mes: el salto es propio de esta serie.',
                                                                    v_otras, substr(pct_es(v_mayor), 2)), 'etiquetas', '["aislado"]'::jsonb);
        ELSE
          v_hechos := v_hechos || jsonb_build_object('texto', format('En %s, %s de las otras %s series se mueven en el mismo sentido y con una magnitud parecida.',
                                                                    mes_corto(h.periodo), v_mismas, v_otras), 'etiquetas', '[]'::jsonb);
        END IF;
      END IF;
      SELECT valor INTO v_siguiente FROM obs_candidato(h.candidato_id) WHERE serie_id = h.serie_id AND periodo = (h.periodo + interval '1 month')::date;
      IF v_siguiente IS NULL THEN
        v_hechos := v_hechos || jsonb_build_object('texto', 'Es el último mes cargado: todavía no hay un mes siguiente para ver si el nivel se mantiene.', 'etiquetas', '[]'::jsonb);
      ELSIF abs(v_siguiente - v_anterior) < 0.25 * abs(v_actual - v_anterior) THEN
        v_hechos := v_hechos || jsonb_build_object('texto', format('Al mes siguiente el valor vuelve a %s, cerca del nivel anterior (%s): el salto se revierte.',
                                                                  num_es(v_siguiente), num_es(v_anterior)), 'etiquetas', '["revierte"]'::jsonb);
      ELSIF abs(dividir(v_siguiente, v_actual) * 100 - 100) < abs(v_var) / 2 THEN
        v_hechos := v_hechos || jsonb_build_object('texto', format('El nivel nuevo se mantiene: al mes siguiente la serie varía %s.',
                                                                  pct_es(dividir(v_siguiente, v_actual) * 100 - 100)), 'etiquetas', '["persistente"]'::jsonb);
      ELSE
        v_hechos := v_hechos || jsonb_build_object('texto', format('Al mes siguiente la serie varía %s.', pct_es(dividir(v_siguiente, v_actual) * 100 - 100)),
                                                  'etiquetas', '[]'::jsonb);
      END IF;
      SELECT valor INTO v_publicado FROM obs_vigente(h.fuente_id) WHERE serie_id = h.serie_id AND periodo = h.periodo;
      IF v_publicado = v_actual THEN
        v_hechos := v_hechos || jsonb_build_object('texto', format('Ese mes ya figura publicado con este mismo valor (%s): no es un dato nuevo.',
                                                                  coalesce(v_release.release_id, 'release vigente')), 'etiquetas', '["ya_publicado"]'::jsonb);
      END IF;
    END IF;

  ELSIF h.regla = 'historia_intacta' THEN
    SELECT valor INTO v_publicado FROM obs_vigente(h.fuente_id) WHERE serie_id = h.serie_id AND periodo = h.periodo;
    SELECT valor INTO v_nuevo FROM obs_candidato(h.candidato_id) WHERE serie_id = h.serie_id AND periodo = h.periodo;
    IF v_publicado IS NULL OR h.periodo IS NULL THEN
      v_hechos := jsonb_build_array(jsonb_build_object('texto', 'No se encontró el valor publicado de ese período para comparar.', 'etiquetas', '[]'::jsonb));
    ELSE
      v_hechos := v_hechos || jsonb_build_object('texto', CASE WHEN v_nuevo IS NULL
        THEN format('%s: el período %s está publicado (%s) pero falta en el candidato.', v_nombre, mes_corto(h.periodo), num_es(v_publicado))
        ELSE format('%s: el valor publicado de %s era %s y el candidato trae %s (%s).', v_nombre, mes_corto(h.periodo), num_es(v_publicado),
                    num_es(v_nuevo), pct_es((dividir(v_nuevo, v_publicado) - 1) * 100)) END, 'etiquetas', '["valor"]'::jsonb);
      SELECT count(*), min(v.periodo), max(v.periodo) INTO v_cambian, v_desde, v_hasta
      FROM obs_vigente(h.fuente_id) v LEFT JOIN obs_candidato(h.candidato_id) c ON c.serie_id = v.serie_id AND c.periodo = v.periodo
      WHERE v.serie_id = h.serie_id AND c.valor IS DISTINCT FROM v.valor;
      IF v_cambian > 1 THEN
        v_hechos := v_hechos || jsonb_build_object('texto', format(
          'En esta serie cambian %s períodos ya publicados (entre %s y %s): parece una revisión y no un valor suelto.',
          v_cambian, mes_corto(v_desde), mes_corto(v_hasta)), 'etiquetas', '["revision"]'::jsonb);
      END IF;
      SELECT count(DISTINCT v.serie_id), count(DISTINCT v.serie_id) FILTER (WHERE c.valor IS DISTINCT FROM v.valor)
      INTO v_series_vigentes, v_con_cambios
      FROM obs_vigente(h.fuente_id) v LEFT JOIN obs_candidato(h.candidato_id) c ON c.serie_id = v.serie_id AND c.periodo = v.periodo;
      IF v_series_vigentes >= 3 AND v_con_cambios::numeric / v_series_vigentes >= 0.8 THEN
        v_hechos := v_hechos || jsonb_build_object('texto', format('Cambian datos ya publicados en %s de las %s series.', v_con_cambios, v_series_vigentes),
                                                  'etiquetas', '["sistemico"]'::jsonb);
      END IF;
      IF v_archivo ->> 'publicada_en' IS NOT NULL AND v_release.release_id IS NOT NULL THEN
        v_hechos := v_hechos || jsonb_build_object('texto', format(
          'Según el servidor de INDEC, el archivo del dato nuevo (%s) cambió por última vez el %s; el release vigente se publicó el %s.',
          v_archivo ->> 'nombre', fecha_larga(left(v_archivo ->> 'publicada_en', 10)::date), fecha_larga(v_release.publicado_en::date)), 'etiquetas', '[]'::jsonb);
      END IF;
    END IF;

  ELSIF h.regla = 'cobertura' THEN
    SELECT max(periodo) INTO v_ultimo FROM obs_candidato(h.candidato_id) WHERE serie_id = h.serie_id;
    IF v_ultimo IS NULL THEN
      v_hechos := jsonb_build_array(jsonb_build_object('texto', 'No hay datos de esa serie en el candidato.', 'etiquetas', '[]'::jsonb));
    ELSE
      SELECT max(periodo) INTO v_maximo FROM obs_candidato(h.candidato_id);
      v_hechos := v_hechos || jsonb_build_object('texto', format('La serie %s termina en %s; las que más avanzan llegan a %s.', v_nombre, mes_corto(v_ultimo),
                                                                mes_corto(v_maximo)), 'etiquetas', '["valor"]'::jsonb);
      SELECT min(serie_id COLLATE "C") INTO v_delante FROM (SELECT serie_id FROM obs_candidato(h.candidato_id) GROUP BY serie_id HAVING max(periodo) = v_maximo) d;
      v_otro := archivo_de(h.resumen, v_delante);
      IF v_archivo ->> 'publicada_en' IS NOT NULL AND v_otro ->> 'publicada_en' IS NOT NULL THEN
        v_dias := dias_entre((v_archivo ->> 'publicada_en')::timestamptz, (v_otro ->> 'publicada_en')::timestamptz);
        IF v_archivo ->> 'nombre' <> v_otro ->> 'nombre' AND v_dias >= 1 THEN
          v_hechos := v_hechos || jsonb_build_object('texto', format(
            'Según el servidor de INDEC, el archivo de esta serie (%s) cambió por última vez el %s y el de las que están al día (%s) el %s, %s días después.',
            v_archivo ->> 'nombre', fecha_larga(left(v_archivo ->> 'publicada_en', 10)::date), v_otro ->> 'nombre',
            fecha_larga(left(v_otro ->> 'publicada_en', 10)::date), v_dias), 'etiquetas', '["archivo"]'::jsonb);
        ELSIF v_archivo ->> 'nombre' = v_otro ->> 'nombre' THEN
          v_hechos := v_hechos || jsonb_build_object('texto', format('Las dos salen del mismo archivo (%s): el desfase no se explica por archivos distintos.',
                                                                    v_archivo ->> 'nombre'), 'etiquetas', '[]'::jsonb);
        ELSE
          v_hechos := v_hechos || jsonb_build_object('texto', format(
            'Según el servidor de INDEC, los dos archivos (%s y %s) cambiaron el mismo día o el de esta serie después: no hay un archivo más viejo que explique la diferencia.',
            v_archivo ->> 'nombre', v_otro ->> 'nombre'), 'etiquetas', '[]'::jsonb);
        END IF;
      ELSE
        v_hechos := v_hechos || jsonb_build_object('texto', 'No hay fechas de los archivos para comparar.', 'etiquetas', '[]'::jsonb);
      END IF;
    END IF;

  ELSIF h.regla = 'base_referencia' THEN
    SELECT min(periodo) INTO v_primero FROM obs_candidato(h.candidato_id) WHERE serie_id = h.serie_id;
    IF v_primero IS NULL THEN
      v_hechos := jsonb_build_array(jsonb_build_object('texto', 'No hay datos de esa serie en el candidato.', 'etiquetas', '[]'::jsonb));
    ELSE
      SELECT valor INTO v_actual FROM obs_candidato(h.candidato_id) WHERE serie_id = h.serie_id AND periodo = v_primero;
      v_hechos := v_hechos || jsonb_build_object('texto', format('%s: el primer valor del candidato es %s en %s; lo esperado es 100,00 en dic 2016.',
                                                                v_nombre, num_es(v_actual), mes_corto(v_primero)), 'etiquetas', '["base"]'::jsonb);
      SELECT periodo, valor INTO v_desde, v_publicado FROM obs_vigente(h.fuente_id) WHERE serie_id = h.serie_id ORDER BY periodo LIMIT 1;
      IF FOUND THEN
        v_hechos := v_hechos || jsonb_build_object('texto', format('En el release vigente la serie arranca en %s con %s.', mes_corto(v_desde), num_es(v_publicado)),
                                                  'etiquetas', '[]'::jsonb);
      END IF;
    END IF;

  ELSIF h.regla = 'fecha_normalizada' THEN
    v_texto := coalesce(h.detalle, '');
    IF position(': ' IN v_texto) > 0 THEN
      v_texto := substr(v_texto, position(': ' IN v_texto) + 2);
    END IF;
    v_hechos := jsonb_build_array(
      jsonb_build_object('texto', format('El parser registró: %s.', regexp_replace(v_texto, '\.+$', '')), 'etiquetas', '["cosmetico"]'::jsonb),
      jsonb_build_object('texto', 'Esa nota no modifica ningún valor: solo dice cómo se interpretó el encabezado del mes.', 'etiquetas', '["cosmetico"]'::jsonb));

  ELSE  -- una regla sin colector propio: lo que dijo la validación, los últimos valores y la fecha del archivo
    v_hechos := v_hechos || jsonb_build_object('texto', 'La validación informó: ' || coalesce(h.detalle, '(sin detalle)'), 'etiquetas', '["valor"]'::jsonb);
    SELECT 'Últimos valores de la serie: ' || string_agg(mes_corto(periodo) || ' ' || num_es(valor), ', ' ORDER BY periodo) || '.' INTO v_texto
    FROM (SELECT periodo, valor FROM obs_candidato(h.candidato_id) WHERE serie_id = h.serie_id ORDER BY periodo DESC LIMIT 3) u;
    IF v_texto IS NOT NULL THEN
      v_hechos := v_hechos || jsonb_build_object('texto', v_texto, 'etiquetas', '[]'::jsonb);
    END IF;
    IF v_archivo ->> 'publicada_en' IS NOT NULL THEN
      v_hechos := v_hechos || jsonb_build_object('texto', format('Según el servidor de INDEC, el archivo de esta serie (%s) cambió por última vez el %s.',
                                                                v_archivo ->> 'nombre', fecha_larga(left(v_archivo ->> 'publicada_en', 10)::date)), 'etiquetas', '[]'::jsonb);
    END IF;
  END IF;

  RETURN (SELECT jsonb_agg(jsonb_build_object('id', n, 'texto', limpiar_texto(e ->> 'texto', 400), 'etiquetas', e -> 'etiquetas') ORDER BY n)
          FROM jsonb_array_elements(v_hechos) WITH ORDINALITY x(e, n));
END $$;

-- El validador ------------------------------------------------------------------------------------

-- Cómo escribe Python un elemento de una lista JSON (`str`): para contar citas distintas como lo hace `dictamen.py`.
CREATE FUNCTION como_texto_python(p_valor jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jsonb_typeof(p_valor)
    WHEN 'string' THEN p_valor #>> '{}'
    WHEN 'boolean' THEN CASE WHEN p_valor = 'true' THEN 'True' ELSE 'False' END
    WHEN 'null' THEN 'None'
    WHEN 'number' THEN CASE WHEN p_valor::text ~ '\.' THEN regexp_replace(p_valor::text, '(\.\d*?)0+$', '\1') || CASE WHEN p_valor::text ~ '\.0*$' THEN '0' ELSE '' END
                            ELSE p_valor::text END
    ELSE p_valor::text END
$$;

-- Lo que dijo el modelo, ya filtrado: nunca más seguro ni más específico que lo que los hechos sostienen. Las mismas reglas que
-- `dictamen.validar_dictamen` de Python (una prueba los compara):
-- - solo cuenta lo que cita hechos que existen; sin ninguna cita válida, el dictamen es "requiere revisión humana";
-- - cada clasificación exige, entre los hechos citados, uno de la clase que la sostiene;
-- - la acción tiene que ser coherente con la clasificación, y la confianza alta exige dos hechos citados;
-- - lo que se baja o se descarta queda anotado en `notas`.
-- Devuelve {clasificacion, accion_sugerida, confianza, razonamiento, hechos_citados, notas}.
CREATE FUNCTION validar_dictamen(p_crudo jsonb, p_hechos jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_notas text[] := '{}';
  v_clasificacion text;
  v_accion text;
  v_confianza text;
  v_razonamiento text := '';
  v_citas bigint[] := '{}';
  v_cita jsonb;
  v_ids bigint[];
  v_etiquetas text[];
  v_requisitos text[];
  v_coherentes text[];
BEGIN
  IF p_crudo IS NULL OR jsonb_typeof(p_crudo) <> 'object' THEN
    RETURN jsonb_build_object('clasificacion', 'requiere_revision_humana', 'accion_sugerida', 'investigar', 'confianza', 'baja', 'razonamiento', '',
                              'hechos_citados', '[]'::jsonb, 'notas', jsonb_build_array('El modelo no devolvió un objeto JSON.'));
  END IF;
  SELECT array_agg((e ->> 'id')::bigint) INTO v_ids FROM jsonb_array_elements(coalesce(p_hechos, '[]'::jsonb)) e;

  v_clasificacion := CASE WHEN jsonb_typeof(p_crudo -> 'clasificacion') = 'string' THEN p_crudo ->> 'clasificacion' END;
  IF v_clasificacion IS NULL OR v_clasificacion NOT IN ('dato_real', 'cosmetico', 'posible_error_de_carga', 'desfase_de_archivo', 'cambio_de_base',
                                                        'requiere_revision_humana') THEN
    v_clasificacion := 'requiere_revision_humana';
    v_notas := v_notas || 'La clasificación no era una de las permitidas.'::text;
  END IF;
  v_accion := CASE WHEN jsonb_typeof(p_crudo -> 'accion_sugerida') = 'string' THEN p_crudo ->> 'accion_sugerida' END;
  IF v_accion IS NULL OR v_accion NOT IN ('aceptar', 'rechazar', 'investigar') THEN
    v_accion := 'investigar';
    v_notas := v_notas || 'La acción no era una de las permitidas.'::text;
  END IF;
  v_confianza := CASE WHEN jsonb_typeof(p_crudo -> 'confianza') = 'string' THEN p_crudo ->> 'confianza' END;
  IF v_confianza IS NULL OR v_confianza NOT IN ('baja', 'media', 'alta') THEN
    v_confianza := 'baja';
    v_notas := v_notas || 'La confianza no era una de las permitidas.'::text;
  END IF;

  IF jsonb_typeof(p_crudo -> 'hechos_citados') = 'array' THEN
    FOR v_cita IN SELECT e FROM jsonb_array_elements(p_crudo -> 'hechos_citados') e LOOP
      IF jsonb_typeof(v_cita) = 'number' AND v_cita::text ~ '^-?[0-9]+$' THEN
        IF (v_cita::text)::numeric = ANY (v_ids::numeric[]) AND NOT (v_cita::text)::numeric = ANY (v_citas::numeric[]) THEN
          v_citas := v_citas || (v_cita::text)::bigint;
        END IF;
      END IF;
    END LOOP;
    IF cardinality(v_citas) < (SELECT count(DISTINCT como_texto_python(e)) FROM jsonb_array_elements(p_crudo -> 'hechos_citados') e) THEN
      v_notas := v_notas || 'Se descartaron citas a hechos que no existen.'::text;
    END IF;
  END IF;
  IF jsonb_typeof(p_crudo -> 'razonamiento') = 'string' THEN
    v_razonamiento := limpiar_texto(p_crudo ->> 'razonamiento', 600);
  END IF;

  IF cardinality(v_citas) = 0 THEN
    RETURN jsonb_build_object('clasificacion', 'requiere_revision_humana', 'accion_sugerida', 'investigar', 'confianza', 'baja', 'razonamiento', v_razonamiento,
                              'hechos_citados', '[]'::jsonb, 'notas', jsonb_build_array('No citó ningún hecho: sin evidencia no hay propuesta.'));
  END IF;
  SELECT coalesce(array_agg(DISTINCT t), '{}') INTO v_etiquetas
  FROM jsonb_array_elements(p_hechos) e, jsonb_array_elements_text(e -> 'etiquetas') t WHERE (e ->> 'id')::bigint = ANY (v_citas);

  v_requisitos := CASE v_clasificacion
    WHEN 'dato_real' THEN ARRAY['sistemico', 'persistente', 'precedente']
    WHEN 'cosmetico' THEN ARRAY['cosmetico', 'precedente']
    WHEN 'posible_error_de_carga' THEN ARRAY['aislado', 'revierte']
    WHEN 'desfase_de_archivo' THEN ARRAY['archivo']
    WHEN 'cambio_de_base' THEN ARRAY['base'] END;
  IF v_requisitos IS NOT NULL AND NOT (v_requisitos && v_etiquetas) THEN
    v_notas := v_notas || format('Para decir «%s» hace falta citar un hecho que muestre %s, y no lo hizo.', v_clasificacion, CASE v_clasificacion
      WHEN 'dato_real' THEN 'que el movimiento se ve en varias series a la vez, que el nivel se mantiene o que una persona ya lo aceptó antes'
      WHEN 'cosmetico' THEN 'que es una nota del parser sobre cómo leyó el archivo, o que una persona ya la aceptó antes'
      WHEN 'posible_error_de_carga' THEN 'que el salto es propio de esta serie o que se revierte'
      WHEN 'desfase_de_archivo' THEN 'que el archivo de esta serie es más viejo que el de las demás'
      WHEN 'cambio_de_base' THEN 'que la serie ya no arranca en la base de referencia' END);
    v_clasificacion := 'requiere_revision_humana';
    v_accion := 'investigar';
    v_confianza := 'baja';
  END IF;
  v_coherentes := CASE v_clasificacion
    WHEN 'dato_real' THEN ARRAY['aceptar', 'investigar']
    WHEN 'cosmetico' THEN ARRAY['aceptar', 'investigar']
    WHEN 'posible_error_de_carga' THEN ARRAY['rechazar', 'investigar']
    WHEN 'desfase_de_archivo' THEN ARRAY['rechazar', 'investigar']
    ELSE ARRAY['investigar'] END;
  IF NOT v_accion = ANY (v_coherentes) THEN
    v_notas := v_notas || format('La acción «%s» no es coherente con «%s».', v_accion, v_clasificacion);
    v_accion := 'investigar';
    v_confianza := 'baja';
  END IF;
  IF v_clasificacion = 'requiere_revision_humana' THEN
    v_accion := 'investigar';
    v_confianza := 'baja';
  END IF;
  IF v_confianza = 'alta' AND cardinality(v_citas) < 2 THEN
    v_notas := v_notas || 'La confianza alta exige al menos dos hechos citados.'::text;
    v_confianza := 'media';
  END IF;
  RETURN jsonb_build_object('clasificacion', v_clasificacion, 'accion_sugerida', v_accion, 'confianza', v_confianza, 'razonamiento', v_razonamiento,
                            'hechos_citados', to_jsonb(v_citas), 'notas', to_jsonb(v_notas));
END $$;

-- Proponer ---------------------------------------------------------------------------------------

-- Los hallazgos de un candidato que todavía esperan una propuesta: sin decisión de una persona y sin propuesta del analista, los
-- más graves primero.
CREATE FUNCTION hallazgos_por_analizar(p_candidato bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'regla', h.regla, 'severidad', h.severidad, 'serie_id', h.serie_id, 'serie_nombre', s.nombre,
                                               'periodo', h.periodo, 'detalle', h.detalle)
                            ORDER BY CASE h.severidad WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END, h.id), '[]'::jsonb)
  FROM hallazgo h JOIN candidato c ON c.corrida_id = h.corrida_id LEFT JOIN serie s ON s.id = h.serie_id
  WHERE c.id = p_candidato
    AND NOT EXISTS (SELECT 1 FROM revision_hallazgo r WHERE r.hallazgo_id = h.id)
    AND NOT EXISTS (SELECT 1 FROM propuesta p WHERE p.hallazgo_id = h.id AND p.accion_sugerida IS NOT NULL)
$$;

-- La decisión más reciente que una persona tomó sobre un hallazgo idéntico (misma regla, serie, período y detalle) de otro
-- candidato: {decision, revisor, comentario, decidida_en, candidato_id}, o NULL.
CREATE FUNCTION precedente_de(p_hallazgo bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT to_jsonb(x) FROM (
    SELECT u.decision, u.revisor, u.comentario, u.decidida_en, c2.id AS candidato_id
    FROM hallazgo h JOIN candidato c ON c.corrida_id = h.corrida_id
    JOIN hallazgo h2 ON h2.regla = h.regla AND h2.serie_id IS NOT DISTINCT FROM h.serie_id AND h2.periodo IS NOT DISTINCT FROM h.periodo
                    AND h2.detalle IS NOT DISTINCT FROM h.detalle
    JOIN candidato c2 ON c2.corrida_id = h2.corrida_id AND c2.id <> c.id
    JOIN LATERAL (SELECT r.decision, r.revisor, r.comentario, r.decidida_en FROM revision_hallazgo r WHERE r.hallazgo_id = h2.id ORDER BY r.id DESC LIMIT 1) u ON true
    WHERE h.id = p_hallazgo ORDER BY u.decidida_en DESC LIMIT 1) x
$$;

-- Guarda una propuesta si el candidato sigue abierto, nadie escribió antes sobre ese hallazgo y una persona no lo decidió (eso
-- lo frena el trigger de la migración 0007). Devuelve el id, o NULL si no se guardó.
CREATE FUNCTION guardar_propuesta(p_hallazgo bigint, p_tipo text, p_confianza text, p_accion text, p_razonamiento text, p_hechos jsonb,
                                  p_notas jsonb, p_origen text, p_modelo text) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO propuesta (hallazgo_id, tipo, evidencia, confianza, accion_sugerida, razonamiento, hechos, notas, origen, modelo)
  SELECT p_hallazgo, p_tipo,
         coalesce((SELECT string_agg(format('[%s] %s', e ->> 'id', e ->> 'texto'), E'\n' ORDER BY n) FROM jsonb_array_elements(p_hechos) WITH ORDINALITY x(e, n)), ''),
         p_confianza, p_accion, p_razonamiento, p_hechos, p_notas, p_origen, p_modelo
  WHERE EXISTS (SELECT 1 FROM hallazgo h JOIN candidato c ON c.corrida_id = h.corrida_id WHERE h.id = p_hallazgo AND c.estado = 'abierto')
  ON CONFLICT (hallazgo_id) WHERE accion_sugerida IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN raise_exception THEN  -- el trigger que no deja aconsejar sobre lo que una persona ya decidió
  RETURN NULL;
END $$;

-- Si una persona ya decidió sobre un hallazgo idéntico de otro candidato, repite esa decisión como propuesta, sin consultar al
-- modelo. Devuelve 'por_precedente', 'sin_precedente' u 'omitido' (había precedente pero no se pudo guardar).
CREATE FUNCTION proponer_por_precedente(p_hallazgo bigint) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_p jsonb := precedente_de(p_hallazgo);
  v_comentario text;
  v_hechos jsonb;
BEGIN
  IF v_p IS NULL THEN
    RETURN 'sin_precedente';
  END IF;
  v_comentario := limpiar_texto(v_p ->> 'comentario', 400);
  v_hechos := jsonb_build_array(jsonb_build_object(
    'id', 1,
    'texto', limpiar_texto(format('%s decidió «%s» el %s sobre un hallazgo idéntico del candidato %s', v_p ->> 'revisor', v_p ->> 'decision',
                                  fecha_larga((v_p ->> 'decidida_en')::timestamptz::date), v_p ->> 'candidato_id')
                           || CASE WHEN v_comentario <> '' THEN format(': «%s».', v_comentario) ELSE '.' END, 400),
    'etiquetas', jsonb_build_array(CASE WHEN v_p ->> 'decision' = 'aceptado' THEN 'precedente' ELSE 'precedente_rechazado' END)));
  IF guardar_propuesta(p_hallazgo, 'precedente', 'media', CASE WHEN v_p ->> 'decision' = 'aceptado' THEN 'aceptar' ELSE 'rechazar' END,
                       'Una persona ya decidió sobre un hallazgo idéntico: se repite su decisión, sin consultar al modelo.', v_hechos, '[]'::jsonb,
                       'precedente', NULL) IS NULL THEN
    RETURN 'omitido';
  END IF;
  RETURN 'por_precedente';
END $$;

-- Guarda lo que dijo el modelo sobre un hallazgo, pasado por el validador contra los hechos que reúne la base (no los que mande
-- quien llama). `p_hechos_vistos`, si viene, son los hechos que se le mostraron al modelo: si no coinciden con los de la base,
-- sus citas no querrían decir lo mismo, y no se guarda nada. Devuelve 'por_modelo', 'sin_respaldo' (contestó, pero sin nada que
-- los hechos sostengan: queda "requiere revisión humana") u 'omitido' (ya tenía propuesta, una persona lo decidió o el
-- candidato se cerró).
CREATE FUNCTION proponer(p_hallazgo bigint, p_respuesta jsonb, p_modelo text, p_hechos_vistos jsonb DEFAULT NULL) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_hechos jsonb := hechos_de(p_hallazgo);
  v_dictamen jsonb;
  v_citados jsonb;
BEGIN
  IF p_hechos_vistos IS NOT NULL AND p_hechos_vistos IS DISTINCT FROM v_hechos THEN
    PERFORM falla('hechos_distintos', format('Los hechos que vio el modelo no son los del hallazgo %s', p_hallazgo));
  END IF;
  IF length(btrim(coalesce(p_modelo, ''))) = 0 THEN
    PERFORM falla('modelo_vacio', 'Falta qué modelo escribió la propuesta');
  END IF;
  v_dictamen := validar_dictamen(p_respuesta, v_hechos);
  SELECT coalesce(jsonb_agg(e ORDER BY n), '[]'::jsonb) INTO v_citados
  FROM jsonb_array_elements(v_hechos) WITH ORDINALITY x(e, n) WHERE e -> 'id' IN (SELECT jsonb_array_elements(v_dictamen -> 'hechos_citados'));
  IF guardar_propuesta(p_hallazgo, v_dictamen ->> 'clasificacion', v_dictamen ->> 'confianza', v_dictamen ->> 'accion_sugerida', v_dictamen ->> 'razonamiento',
                       v_citados, v_dictamen -> 'notas', 'agente', btrim(p_modelo)) IS NULL THEN
    RETURN 'omitido';
  END IF;
  RETURN CASE WHEN jsonb_array_length(v_citados) > 0 THEN 'por_modelo' ELSE 'sin_respaldo' END;
END $$;

-- Para la Edge Function: todos los candidatos abiertos ------------------------------------------------

-- Propone por precedente todo lo que lo tenga. Devuelve cuántas propuestas dejó.
CREATE FUNCTION proponer_por_precedentes() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_h record;
  v_dejadas integer := 0;
BEGIN
  FOR v_h IN SELECT (e ->> 'id')::bigint AS id FROM candidato c, jsonb_array_elements(hallazgos_por_analizar(c.id)) e WHERE c.estado = 'abierto' ORDER BY c.id LOOP
    IF proponer_por_precedente(v_h.id) = 'por_precedente' THEN
      v_dejadas := v_dejadas + 1;
    END IF;
  END LOOP;
  RETURN v_dejadas;
END $$;

-- Lo que el modelo tiene que mirar, hasta `p_limite` hallazgos: para cada uno, el pedido tal como se le muestra (el hallazgo y
-- los hechos, sin las etiquetas) y los hechos completos, que vuelven con `proponer`.
CREATE FUNCTION hallazgos_para_el_modelo(p_limite integer DEFAULT 50) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'hallazgo_id', (p.h ->> 'id')::bigint, 'candidato_id', p.candidato_id,
    'pedido', jsonb_build_object(
      'hallazgo', jsonb_build_object('regla', p.h ->> 'regla', 'severidad', p.h ->> 'severidad', 'serie', coalesce(p.h ->> 'serie_nombre', p.h ->> 'serie_id'),
                                     'periodo', to_char((p.h ->> 'periodo')::date, 'YYYY-MM'), 'detalle', limpiar_texto(p.h ->> 'detalle', 400)),
      'hechos', (SELECT jsonb_agg(jsonb_build_object('id', e -> 'id', 'texto', e -> 'texto') ORDER BY n) FROM jsonb_array_elements(q.hechos) WITH ORDINALITY y(e, n))),
    'hechos', q.hechos) ORDER BY p.orden), '[]'::jsonb)
  FROM (SELECT c.id AS candidato_id, x.h, row_number() OVER (ORDER BY c.id, x.n) AS orden
        FROM candidato c, jsonb_array_elements(hallazgos_por_analizar(c.id)) WITH ORDINALITY x(h, n)
        WHERE c.estado = 'abierto' ORDER BY c.id, x.n LIMIT p_limite) p,
       LATERAL (SELECT hechos_de((p.h ->> 'id')::bigint) AS hechos) q
$$;

CALL fijar_search_path();
