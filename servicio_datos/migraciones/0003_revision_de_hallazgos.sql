-- Revisión humana de los hallazgos, y motivo de los descartes.
--
-- Hasta ahora un hallazgo no tenía forma de quedar resuelto: las `propuesta` son del
-- agente, que todavía no existe. Para publicar hace falta que una persona haya visto
-- cada hallazgo del candidato, y que quede constancia de quién y por qué.
--
-- Es un registro de solo agregar. Una decisión se cambia agregando otra: vale la última,
-- y el historial completo queda para auditar. Solo se revisan hallazgos de un candidato
-- abierto, así que una publicación no puede reescribirse después.

CREATE TABLE revision_hallazgo (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hallazgo_id  bigint NOT NULL REFERENCES hallazgo(id),
  decision     text NOT NULL CHECK (decision IN ('aceptado', 'rechazado')),
  revisor      text NOT NULL CHECK (length(btrim(revisor)) > 0),
  comentario   text,
  decidida_en  timestamptz NOT NULL DEFAULT now(),
  -- Sin motivo no se rechaza.
  CONSTRAINT revision_rechazo_con_comentario CHECK (
    decision <> 'rechazado' OR length(btrim(coalesce(comentario, ''))) > 0
  )
);
CREATE INDEX revision_hallazgo_ultima ON revision_hallazgo (hallazgo_id, id DESC);

CREATE FUNCTION exigir_candidato_abierto() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  estado_candidato text;
BEGIN
  SELECT c.estado INTO estado_candidato
  FROM hallazgo h LEFT JOIN candidato c ON c.corrida_id = h.corrida_id
  WHERE h.id = NEW.hallazgo_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- el hallazgo no existe: lo rechaza la clave foránea, con su propio mensaje
  END IF;
  IF estado_candidato IS DISTINCT FROM 'abierto' THEN
    RAISE EXCEPTION 'revision_hallazgo: solo se revisan hallazgos de un candidato abierto (estado: %)',
      coalesce(estado_candidato, 'sin candidato');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER revision_hallazgo_solo_en_abiertos
  BEFORE INSERT ON revision_hallazgo
  FOR EACH ROW EXECUTE FUNCTION exigir_candidato_abierto();
CREATE TRIGGER revision_hallazgo_solo_agregar
  BEFORE UPDATE OR DELETE ON revision_hallazgo
  FOR EACH ROW EXECUTE FUNCTION bloquear_modificacion();
CREATE TRIGGER revision_hallazgo_sin_vaciado
  BEFORE TRUNCATE ON revision_hallazgo
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_vaciado();

-- Por qué se descartó un candidato (una persona, o el sistema al reemplazarlo).
ALTER TABLE candidato ADD COLUMN motivo text;
