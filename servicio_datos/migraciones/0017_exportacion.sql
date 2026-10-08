-- La copia pública de lo aprobado (exportacion.py): de dónde sale cada release y con qué licencia se puede redistribuir.
--
-- Solo se exporta lo publicado. Cada release se reconstruye tal cual quedó al publicarse (las observaciones son de solo
-- agregar, con su release de alta y de baja), así que la copia de un release viejo es exactamente lo que se aprobó entonces.

-- Con qué licencia y atribución se puede redistribuir lo que viene de cada fuente. Lo completa una persona después de revisar
-- los términos de la fuente: sin esto, la fuente no se exporta.
ALTER TABLE fuente
  ADD COLUMN licencia text,      -- p. ej. 'CC BY-SA 4.0'
  ADD COLUMN licencia_url text,  -- el texto de la licencia
  ADD COLUMN atribucion text;    -- cómo hay que citarla al redistribuir

-- Los releases publicados, del más viejo al más nuevo.
CREATE FUNCTION releases_publicados() RETURNS TABLE (numero integer, release_id text, fuente_id text, publicado_en timestamptz,
                                                      hash_contenido text, procedencia jsonb)
LANGUAGE sql STABLE AS $$
  SELECT r.numero, r.release_id, co.fuente_id, r.publicado_en, r.hash_contenido, r.procedencia
  FROM release r JOIN candidato c ON c.id = r.candidato_id JOIN corrida co ON co.id = c.corrida_id
  ORDER BY r.numero
$$;

-- Lo que quedó vigente al publicar ese release, para su fuente: la foto completa que se aprobó.
CREATE FUNCTION observaciones_de_release(p_numero integer) RETURNS TABLE (serie_id text, periodo date, valor numeric)
LANGUAGE sql STABLE AS $$
  SELECT o.serie_id, o.periodo, o.valor
  FROM observacion o JOIN serie s ON s.id = o.serie_id
  WHERE s.fuente_id = (SELECT co.fuente_id FROM release r JOIN candidato c ON c.id = r.candidato_id JOIN corrida co ON co.id = c.corrida_id
                       WHERE r.numero = p_numero)
    AND o.release_desde <= p_numero AND (o.release_hasta IS NULL OR o.release_hasta > p_numero)
  ORDER BY o.serie_id COLLATE "C", o.periodo
$$;

CALL fijar_search_path();
