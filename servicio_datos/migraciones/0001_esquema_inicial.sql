-- Esquema inicial de la base de datos de ChartBay.
-- Diseño: docs/base-datos-actualizacion.md
--
-- Tres capas: crudo (descarga), candidato y publicado (observacion + release).
-- Lo que no puede cambiar se protege con triggers, no con la disciplina del
-- código que escribe: el crudo y los releases son de solo agregar, una
-- observación solo se puede cerrar, y una propuesta decidida queda como está.

CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA public;

-- Funciones de protección ---------------------------------------------------

CREATE FUNCTION bloquear_modificacion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% es de solo agregar: no se admite %', TG_TABLE_NAME, TG_OP;
END $$;

CREATE FUNCTION bloquear_vaciado() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% es de solo agregar: no se admite TRUNCATE', TG_TABLE_NAME;
END $$;

-- Fuentes y series ----------------------------------------------------------

CREATE TABLE fuente (
  id           text PRIMARY KEY CHECK (id ~ '^[A-Z0-9_]+$'),
  nombre       text NOT NULL,
  url_base     text,
  calendario   text
);

CREATE TABLE serie (
  id             text PRIMARY KEY CHECK (id ~ '^[a-z0-9_]+$'),
  fuente_id      text NOT NULL REFERENCES fuente(id),
  nombre         text NOT NULL,
  tema           text,
  nivel          text,
  territorio     text,
  clasificacion  text,
  frecuencia     text NOT NULL,
  unidad         text,
  base           text,
  hoja_origen    text,
  fila_origen    integer CHECK (fila_origen > 0),
  creada_en      timestamptz NOT NULL DEFAULT now()
);

-- Crudo: lo que bajó el colector. Inmutable. ---------------------------------

CREATE TABLE descarga (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fuente_id      text NOT NULL REFERENCES fuente(id),
  url            text NOT NULL,
  sha256         text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes          bigint CHECK (bytes >= 0),
  ruta_crudo     text,
  descargada_en  timestamptz NOT NULL DEFAULT now(),
  publicada_en   timestamptz,
  estado         text NOT NULL CHECK (estado IN ('nueva', 'identica', 'fallida')),
  error          text,
  -- Una descarga fallida explica por qué; una lograda tiene el archivo completo.
  CONSTRAINT descarga_estado_coherente CHECK (
    (estado = 'fallida' AND error IS NOT NULL)
    OR (estado <> 'fallida' AND error IS NULL
        AND sha256 IS NOT NULL AND bytes IS NOT NULL AND ruta_crudo IS NOT NULL)
  )
);
CREATE INDEX descarga_fuente_fecha ON descarga (fuente_id, descargada_en DESC);

CREATE TRIGGER descarga_solo_agregar
  BEFORE UPDATE OR DELETE ON descarga
  FOR EACH ROW EXECUTE FUNCTION bloquear_modificacion();
CREATE TRIGGER descarga_sin_vaciado
  BEFORE TRUNCATE ON descarga
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_vaciado();

-- Corridas, candidatos y hallazgos ------------------------------------------

CREATE TABLE corrida (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fuente_id     text NOT NULL REFERENCES fuente(id),
  descarga_id   bigint REFERENCES descarga(id),
  iniciada_en   timestamptz NOT NULL DEFAULT now(),
  terminada_en  timestamptz,
  estado        text NOT NULL CHECK (estado IN ('en_curso', 'sin_cambios', 'con_candidato', 'fallida')),
  error         text,
  resumen       jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT corrida_estado_coherente CHECK (
    (estado = 'en_curso' AND terminada_en IS NULL)
    OR (estado = 'fallida' AND terminada_en IS NOT NULL AND error IS NOT NULL)
    OR (estado IN ('sin_cambios', 'con_candidato') AND terminada_en IS NOT NULL AND error IS NULL)
  )
);
CREATE INDEX corrida_fuente_inicio ON corrida (fuente_id, iniciada_en DESC);

CREATE TABLE candidato (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  corrida_id   bigint NOT NULL UNIQUE REFERENCES corrida(id),
  estado       text NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto', 'publicado', 'descartado')),
  creado_en    timestamptz NOT NULL DEFAULT now(),
  decidido_en  timestamptz,
  decidido_por text,
  CONSTRAINT candidato_decision_coherente CHECK (
    (estado = 'abierto' AND decidido_en IS NULL AND decidido_por IS NULL)
    OR (estado <> 'abierto' AND decidido_en IS NOT NULL AND decidido_por IS NOT NULL)
  )
);

-- Un valor faltante es una fila que no existe, nunca un cero ni un NULL.
CREATE TABLE observacion_candidata (
  candidato_id  bigint NOT NULL REFERENCES candidato(id),
  serie_id      text NOT NULL REFERENCES serie(id),
  periodo       date NOT NULL,
  valor         numeric NOT NULL,
  PRIMARY KEY (candidato_id, serie_id, periodo)
);

CREATE TABLE hallazgo (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  corrida_id  bigint NOT NULL REFERENCES corrida(id),
  serie_id    text REFERENCES serie(id),
  periodo     date,
  regla       text NOT NULL,
  severidad   text NOT NULL CHECK (severidad IN ('baja', 'media', 'alta')),
  detalle     text,
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hallazgo_corrida ON hallazgo (corrida_id);

CREATE TABLE propuesta (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hallazgo_id     bigint NOT NULL REFERENCES hallazgo(id),
  tipo            text NOT NULL,
  valor_actual    numeric,
  valor_propuesto numeric,
  evidencia       text,
  confianza       text NOT NULL CHECK (confianza IN ('baja', 'media', 'alta')),
  estado          text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'aprobada', 'rechazada')),
  revisor         text,
  comentario      text,
  creada_en       timestamptz NOT NULL DEFAULT now(),
  decidida_en     timestamptz,
  CONSTRAINT propuesta_decision_coherente CHECK (
    (estado = 'pendiente' AND decidida_en IS NULL AND revisor IS NULL)
    OR (estado <> 'pendiente' AND decidida_en IS NOT NULL AND revisor IS NOT NULL)
  ),
  -- Sin evidencia citada no se aprueba; sin motivo no se rechaza.
  CONSTRAINT propuesta_aprobada_con_evidencia CHECK (
    estado <> 'aprobada' OR length(btrim(coalesce(evidencia, ''))) > 0
  ),
  CONSTRAINT propuesta_rechazada_con_comentario CHECK (
    estado <> 'rechazada' OR length(btrim(coalesce(comentario, ''))) > 0
  )
);
CREATE INDEX propuesta_hallazgo ON propuesta (hallazgo_id);

CREATE FUNCTION proteger_propuesta() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.estado = 'pendiente' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'propuesta: una propuesta decidida no se modifica ni se borra (%)', TG_OP;
END $$;

CREATE TRIGGER propuesta_decidida_intocable
  BEFORE UPDATE OR DELETE ON propuesta
  FOR EACH ROW EXECUTE FUNCTION proteger_propuesta();
CREATE TRIGGER propuesta_sin_vaciado
  BEFORE TRUNCATE ON propuesta
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_vaciado();

-- Publicado: releases y observaciones versionadas ---------------------------

CREATE TABLE release (
  numero          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  release_id      text NOT NULL UNIQUE,
  candidato_id    bigint NOT NULL UNIQUE REFERENCES candidato(id),
  aprobado_por    text NOT NULL,
  publicado_en    timestamptz NOT NULL DEFAULT now(),
  hash_contenido  text NOT NULL CHECK (hash_contenido ~ '^[0-9a-f]{64}$')
);

CREATE TRIGGER release_solo_agregar
  BEFORE UPDATE OR DELETE ON release
  FOR EACH ROW EXECUTE FUNCTION bloquear_modificacion();
CREATE TRIGGER release_sin_vaciado
  BEFORE TRUNCATE ON release
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_vaciado();

-- Una observación es válida desde el release que la puso hasta el release que la
-- reemplazó (exclusivo). release_hasta NULL significa vigente. Para ver los datos
-- tal como estaban en el release N: release_desde <= N AND (release_hasta IS NULL
-- OR release_hasta > N).
CREATE TABLE observacion (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  serie_id       text NOT NULL REFERENCES serie(id),
  periodo        date NOT NULL,
  valor          numeric NOT NULL,
  release_desde  integer NOT NULL REFERENCES release(numero),
  release_hasta  integer REFERENCES release(numero),
  CONSTRAINT observacion_rango_valido CHECK (release_hasta IS NULL OR release_hasta > release_desde),
  -- Dos versiones del mismo dato no pueden estar vigentes en el mismo release.
  CONSTRAINT observacion_sin_solapes EXCLUDE USING gist (
    serie_id WITH =,
    periodo WITH =,
    int4range(release_desde, release_hasta) WITH &&
  )
);

CREATE VIEW observacion_vigente AS
  SELECT id, serie_id, periodo, valor, release_desde
  FROM observacion
  WHERE release_hasta IS NULL;

CREATE FUNCTION proteger_observacion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.release_hasta IS NULL AND NEW.release_hasta IS NOT NULL
     AND NEW.id = OLD.id AND NEW.serie_id = OLD.serie_id
     AND NEW.periodo = OLD.periodo AND NEW.valor = OLD.valor
     AND NEW.release_desde = OLD.release_desde THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'observacion: solo se puede cerrar una versión vigente fijando release_hasta (%)', TG_OP;
END $$;

CREATE TRIGGER observacion_solo_cerrar
  BEFORE UPDATE OR DELETE ON observacion
  FOR EACH ROW EXECUTE FUNCTION proteger_observacion();
CREATE TRIGGER observacion_sin_vaciado
  BEFORE TRUNCATE ON observacion
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_vaciado();
