-- Contrato de lectura para ChartBay.
--
-- La web no lee las tablas del servicio: lee estas dos vistas. Así el servicio puede
-- reorganizar sus tablas sin romperla, y la web solo necesita permiso de lectura sobre
-- ellas (ver el README: un rol aparte, sin acceso a nada más).
--
-- La procedencia (qué archivos, con qué hash y fecha, y qué hoja y notas de cada serie)
-- se guarda en el release al publicar. Es parte de lo publicado: no cambia aunque el
-- servicio siga descargando archivos nuevos.

ALTER TABLE release ADD COLUMN procedencia jsonb NOT NULL DEFAULT '{}'::jsonb;

-- El release vigente de cada fuente.
CREATE VIEW publicado_release AS
  SELECT DISTINCT ON (co.fuente_id)
         co.fuente_id, r.numero, r.release_id, r.publicado_en, r.hash_contenido, r.procedencia
  FROM release r
  JOIN candidato c ON c.id = r.candidato_id
  JOIN corrida co ON co.id = c.corrida_id
  ORDER BY co.fuente_id, r.numero DESC;

-- Los datos de ese release, listos para servir.
CREATE VIEW publicado_observaciones AS
  SELECT s.fuente_id, o.serie_id, o.periodo, o.valor
  FROM observacion_vigente o
  JOIN serie s ON s.id = o.serie_id;
