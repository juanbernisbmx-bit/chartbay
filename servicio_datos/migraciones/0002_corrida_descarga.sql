-- Una corrida puede traer varios archivos (el IPC tiene dos: nacional y aperturas),
-- así que la relación con la descarga pasa de una columna a una tabla puente.
-- Se incluyen también las descargas fallidas: son parte de lo que pasó en la corrida.

CREATE TABLE corrida_descarga (
  corrida_id   bigint NOT NULL REFERENCES corrida(id),
  descarga_id  bigint NOT NULL REFERENCES descarga(id),
  PRIMARY KEY (corrida_id, descarga_id)
);
CREATE INDEX corrida_descarga_descarga ON corrida_descarga (descarga_id);

INSERT INTO corrida_descarga (corrida_id, descarga_id)
  SELECT id, descarga_id FROM corrida WHERE descarga_id IS NOT NULL;

ALTER TABLE corrida DROP COLUMN descarga_id;

CREATE TRIGGER corrida_descarga_solo_agregar
  BEFORE UPDATE OR DELETE ON corrida_descarga
  FOR EACH ROW EXECUTE FUNCTION bloquear_modificacion();
CREATE TRIGGER corrida_descarga_sin_vaciado
  BEFORE TRUNCATE ON corrida_descarga
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_vaciado();

-- El colector busca la última descarga conocida de cada URL.
CREATE INDEX descarga_url_fecha ON descarga (url, descargada_en DESC);
