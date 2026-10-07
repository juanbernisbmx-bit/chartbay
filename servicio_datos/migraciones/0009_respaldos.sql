-- Registro de los respaldos (base y crudo) y los avisos que salen de él.
--
-- Cada corrida del respaldo deja una fila: cuándo, si salió bien y qué guardó. Es de solo agregar,
-- como el resto de la historia. Los avisos miran este registro y no el resultado del proceso: así
-- también se enteran cuando el respaldo deja de correr del todo (un cron muerto no deja filas).

CREATE TABLE respaldo (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  iniciado_en   timestamptz NOT NULL,
  terminado_en  timestamptz NOT NULL DEFAULT now(),
  ok            boolean NOT NULL,
  error         text,
  -- archivo, tamaño y hash del volcado, filas por tabla, archivos del crudo copiados y verificados, ensayo
  detalle       jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT respaldo_error_coherente CHECK (ok = (error IS NULL)),
  CONSTRAINT respaldo_tiempos CHECK (terminado_en >= iniciado_en)
);
CREATE INDEX respaldo_recientes ON respaldo (id DESC);

CREATE TRIGGER respaldo_solo_agregar
  BEFORE UPDATE OR DELETE ON respaldo
  FOR EACH ROW EXECUTE FUNCTION bloquear_modificacion();
CREATE TRIGGER respaldo_sin_vaciado
  BEFORE TRUNCATE ON respaldo
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_vaciado();

ALTER TABLE aviso DROP CONSTRAINT aviso_tipo_check;
ALTER TABLE aviso ADD CONSTRAINT aviso_tipo_check
  CHECK (tipo IN ('candidato_nuevo', 'candidato_pendiente', 'corrida_fallida', 'sin_datos', 'colector_inactivo',
                  'respaldo_fallido', 'respaldo_atrasado'));
