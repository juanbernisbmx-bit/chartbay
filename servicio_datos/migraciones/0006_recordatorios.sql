-- Recordatorios de un candidato que sigue abierto: un tipo de aviso más.
-- El tipo es una lista cerrada (migración 0005), así que se amplía acá.

ALTER TABLE aviso DROP CONSTRAINT aviso_tipo_check;
ALTER TABLE aviso ADD CONSTRAINT aviso_tipo_check
  CHECK (tipo IN ('candidato_nuevo', 'candidato_pendiente', 'corrida_fallida', 'sin_datos', 'colector_inactivo'));
