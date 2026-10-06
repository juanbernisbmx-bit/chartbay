-- Lo que el validador corrigió de lo que dijo el modelo.
--
-- Un modelo local se equivoca: cita hechos que no existen, exagera su confianza o propone algo incoherente con su
-- propia clasificación. El validador lo corrige antes de guardar la propuesta, y esas correcciones quedan anotadas
-- acá, para poder medir con qué frecuencia y en qué se equivoca el modelo antes de darle más responsabilidad.

ALTER TABLE propuesta
  ADD COLUMN notas jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(notas) = 'array');
