-- Lo que hace falta guardar de una propuesta del agente, y dos reglas que la base misma sostiene.
--
-- El agente solo propone: no toca el candidato ni lo publicado. Cada propuesta lleva qué clasificó
-- (`tipo`), qué haría (`accion_sugerida`), con qué hechos lo respalda (`hechos`: lo que citó, con su
-- texto, tal como lo vio) y por qué (`razonamiento`), y qué modelo la escribió, para poder auditarla.
-- `origen` distingue una propuesta del modelo de una que sale de un precedente: un hallazgo idéntico
-- que una persona ya decidió antes.

ALTER TABLE propuesta
  ADD COLUMN accion_sugerida text CHECK (accion_sugerida IN ('aceptar', 'rechazar', 'investigar')),
  ADD COLUMN razonamiento    text,
  ADD COLUMN hechos          jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN origen          text NOT NULL DEFAULT 'agente' CHECK (origen IN ('agente', 'precedente')),
  ADD COLUMN modelo          text;

-- Una sola propuesta del agente por hallazgo: correr el agente dos veces no duplica nada.
CREATE UNIQUE INDEX propuesta_una_del_agente_por_hallazgo ON propuesta (hallazgo_id) WHERE accion_sugerida IS NOT NULL;

-- No se aconseja sobre un hallazgo que una persona ya decidió. Una propuesta pendiente bloquea la
-- publicación, y si el hallazgo ya está decidido nadie tendría cómo resolverla.
CREATE FUNCTION exigir_hallazgo_sin_decidir() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM revision_hallazgo r WHERE r.hallazgo_id = NEW.hallazgo_id) THEN
    RAISE EXCEPTION 'propuesta: el hallazgo % ya fue decidido por una persona; no se aconseja sobre lo decidido', NEW.hallazgo_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER propuesta_solo_sobre_lo_pendiente
  BEFORE INSERT ON propuesta
  FOR EACH ROW EXECUTE FUNCTION exigir_hallazgo_sin_decidir();
