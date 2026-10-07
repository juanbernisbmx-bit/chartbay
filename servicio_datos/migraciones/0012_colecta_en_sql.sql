-- El ciclo de una corrida de colecta como funciones de la base (plan: docs/base-datos-supabase.md, paso 3).
--
-- Lo usan igual el colector de Python (`repositorio.py`) y la Edge Function `colectar-ipc`: abrir una corrida exclusiva
-- por fuente, saber si un archivo ya se conocía, registrar cada descarga y cerrar. La red y la lectura de los archivos
-- quedan afuera, en quien colecta.

CREATE FUNCTION asegurar_fuente(p_fuente text, p_nombre text, p_url_base text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO fuente (id, nombre, url_base) VALUES (p_fuente, p_nombre, p_url_base) ON CONFLICT (id) DO NOTHING
$$;

-- Abre una corrida, o devuelve NULL si ya hay otra en curso para la fuente. Una en curso más vieja que el vencimiento se da
-- por abandonada (el proceso murió a mitad de camino) y se cierra como fallida: si no, una caída bloquearía la fuente para siempre.
CREATE FUNCTION abrir_corrida(p_fuente text, p_vencimiento_segundos double precision DEFAULT 21600) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v_corrida bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('colector:' || p_fuente));
  UPDATE corrida SET estado = 'fallida', terminada_en = now(), error = 'Abandonada: quedó en curso más allá del vencimiento'
  WHERE fuente_id = p_fuente AND estado = 'en_curso' AND iniciada_en < now() - make_interval(secs => p_vencimiento_segundos);
  IF EXISTS (SELECT 1 FROM corrida WHERE fuente_id = p_fuente AND estado = 'en_curso') THEN
    RETURN NULL;
  END IF;
  INSERT INTO corrida (fuente_id, estado) VALUES (p_fuente, 'en_curso') RETURNING id INTO v_corrida;
  RETURN v_corrida;
END $$;

-- La última descarga de esa URL que una corrida terminada dio por buena. Las de corridas fallidas o todavía en curso no
-- cuentan: si una corrida se cae a mitad de camino, la próxima tiene que volver a ver ese archivo como nuevo.
CREATE FUNCTION ultima_descarga(p_url text) RETURNS TABLE (sha256 text, ruta_crudo text)
LANGUAGE sql STABLE AS $$
  SELECT d.sha256, d.ruta_crudo FROM descarga d
  JOIN corrida_descarga cd ON cd.descarga_id = d.id JOIN corrida c ON c.id = cd.corrida_id
  WHERE d.url = p_url AND d.estado IN ('nueva', 'identica') AND c.estado IN ('con_candidato', 'sin_cambios')
  ORDER BY d.descargada_en DESC, d.id DESC LIMIT 1
$$;

CREATE FUNCTION registrar_descarga(p_corrida bigint, p_url text, p_estado text, p_sha256 text DEFAULT NULL, p_bytes bigint DEFAULT NULL,
                                   p_ruta_crudo text DEFAULT NULL, p_publicada_en timestamptz DEFAULT NULL, p_error text DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v_fuente text;
  v_estado text;
  v_descarga bigint;
BEGIN
  SELECT fuente_id, estado INTO v_fuente, v_estado FROM corrida WHERE id = p_corrida;
  IF NOT FOUND THEN
    PERFORM falla('no_existe', format('No existe la corrida %s', p_corrida));
  END IF;
  IF v_estado <> 'en_curso' THEN
    PERFORM falla('corrida_cerrada', format('La corrida %s ya terminó (estado: %s)', p_corrida, v_estado));
  END IF;
  INSERT INTO descarga (fuente_id, url, sha256, bytes, ruta_crudo, publicada_en, estado, error)
  VALUES (v_fuente, p_url, p_sha256, p_bytes, p_ruta_crudo, p_publicada_en, p_estado, p_error) RETURNING id INTO v_descarga;
  INSERT INTO corrida_descarga (corrida_id, descarga_id) VALUES (p_corrida, v_descarga);
  RETURN v_descarga;
END $$;

-- Suma datos al resumen de una corrida en curso (lo de la colecta; después `cargar_candidato` agrega lo suyo).
CREATE FUNCTION anotar_corrida(p_corrida bigint, p_resumen jsonb) RETURNS void
LANGUAGE sql AS $$
  UPDATE corrida SET resumen = resumen || coalesce(p_resumen, '{}'::jsonb) WHERE id = p_corrida AND estado = 'en_curso'
$$;

-- Cierra una corrida en curso. Devuelve si la cerró (una ya cerrada no se toca).
CREATE FUNCTION cerrar_corrida(p_corrida bigint, p_estado text, p_error text DEFAULT NULL, p_resumen jsonb DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE corrida SET estado = p_estado, terminada_en = now(), error = p_error, resumen = resumen || coalesce(p_resumen, '{}'::jsonb)
  WHERE id = p_corrida AND estado = 'en_curso';
  RETURN FOUND;
END $$;
