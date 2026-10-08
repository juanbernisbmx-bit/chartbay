"""El esquema `revision`: lo único de la base que ve la página de revisión de ChartBay.

La página corre en el navegador del revisor, que inicia sesión con Supabase Auth y llama a estas funciones por la API de
Supabase. El servidor de ChartBay no guarda ninguna clave de la base. Las tablas siguen en el esquema privado del servicio
(`economia`), que no se expone; acá solo hay funciones, y cada una:

- es `SECURITY DEFINER` con `search_path` fijo: corre con los permisos de quien la instaló, sin que quien llama pueda
  cambiarle a qué tablas apunta;
- exige que el correo de la sesión (lo que Supabase pone en `request.jwt.claims`) esté en la tabla `revisor` y activo; si
  no, falla con SQLSTATE 42501 y DETAIL `no_autorizado`;
- revisa y publica con el nombre de la tabla `revisor`, no con lo que mande el navegador.

Los errores de negocio llegan como en el resto de la base: SQLSTATE CB001 y un código en DETAIL (ver migración 0010).

No es una migración porque vive en otro esquema y se puede volver a instalar entera (`CREATE OR REPLACE`). Para el panel de
Supabase: `python -m servicio_datos.api_revision` imprime el SQL. Hay que agregar el esquema a "Exposed schemas" y mantener la
confirmación de correo de Supabase Auth: la lista de revisores confía en que el correo de la sesión es de quien inició sesión.
"""
from __future__ import annotations

import argparse
import re
import sys

import psycopg

NOMBRE = re.compile(r"^[a-z_][a-z0-9_]*$")

SQL = r"""
CREATE SCHEMA IF NOT EXISTS {api};
COMMENT ON SCHEMA {api} IS 'API de la revisión para ChartBay: solo funciones, y todas exigen un revisor de la lista.';

-- Quién llama: el nombre del revisor activo cuyo correo es el de la sesión de Supabase Auth, o nada.
CREATE OR REPLACE FUNCTION {api}.revisor_actual() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
  SELECT r.nombre FROM {datos}.revisor r
  WHERE r.activo AND r.email = lower(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
$$;

CREATE OR REPLACE FUNCTION {api}.exigir_revisor() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
DECLARE
  v_revisor text := {api}.revisor_actual();
BEGIN
  IF v_revisor IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Hace falta iniciar sesión con una cuenta de revisor', DETAIL = 'no_autorizado';
  END IF;
  RETURN v_revisor;
END $$;

-- Acciones ------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION {api}.revisar(hallazgo_id bigint, decision text, comentario text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
BEGIN
  PERFORM {datos}.revisar_hallazgo(revisar.hallazgo_id, revisar.decision, {api}.exigir_revisor(), revisar.comentario);
END $$;

CREATE OR REPLACE FUNCTION {api}.aceptar_pendientes(candidato_id bigint, regla text DEFAULT NULL, comentario text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
BEGIN
  RETURN {datos}.aceptar_pendientes(aceptar_pendientes.candidato_id, {api}.exigir_revisor(), aceptar_pendientes.comentario, aceptar_pendientes.regla);
END $$;

CREATE OR REPLACE FUNCTION {api}.publicar(candidato_id bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
DECLARE
  v_revisor text := {api}.exigir_revisor();
  v_fuente text;
  v_resultado jsonb;
BEGIN
  SELECT co.fuente_id INTO v_fuente FROM {datos}.candidato c JOIN {datos}.corrida co ON co.id = c.corrida_id WHERE c.id = publicar.candidato_id;
  SELECT to_jsonb(p) INTO v_resultado
  FROM {datos}.publicar_candidato(publicar.candidato_id, v_revisor,
                                  CASE v_fuente WHEN 'INDEC_IPC' THEN 'ipc' ELSE lower(coalesce(v_fuente, 'datos')) END) p;
  RETURN v_resultado;
END $$;

CREATE OR REPLACE FUNCTION {api}.descartar(candidato_id bigint, motivo text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
BEGIN
  PERFORM {datos}.descartar_candidato(descartar.candidato_id, {api}.exigir_revisor(), descartar.motivo);
END $$;

-- Lecturas para la pantalla ---------------------------------------------------------------------------

-- La cola: lo que espera revisión, las corridas fallidas sin resolver, lo ya decidido y el release vigente.
CREATE OR REPLACE FUNCTION {api}.cola() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
  SELECT jsonb_build_object(
    'revisor', {api}.exigir_revisor(),
    'abiertos', coalesce((SELECT jsonb_agg(x ORDER BY x.creado_en, x.id) FROM (
        SELECT c.id, c.creado_en, co.fuente_id, count(h.id) AS hallazgos,
               count(h.id) FILTER (WHERE u.decision = 'aceptado') AS aceptados,
               count(h.id) FILTER (WHERE u.decision = 'rechazado') AS rechazados,
               count(h.id) FILTER (WHERE u.decision IS NULL) AS pendientes,
               (SELECT count(*) FROM {datos}.propuesta p JOIN {datos}.hallazgo h2 ON h2.id = p.hallazgo_id
                WHERE h2.corrida_id = c.corrida_id AND p.estado = 'pendiente') AS propuestas_pendientes
        FROM {datos}.candidato c JOIN {datos}.corrida co ON co.id = c.corrida_id
        LEFT JOIN {datos}.hallazgo h ON h.corrida_id = c.corrida_id
        LEFT JOIN LATERAL (SELECT r.decision FROM {datos}.revision_hallazgo r WHERE r.hallazgo_id = h.id ORDER BY r.id DESC LIMIT 1) u ON true
        WHERE c.estado = 'abierto' GROUP BY c.id, co.id) x), '[]'::jsonb),
    'fallidas', coalesce((SELECT jsonb_agg(x ORDER BY x.id DESC) FROM (
        SELECT c.id, c.fuente_id, c.iniciada_en, c.terminada_en, c.error FROM {datos}.corrida c
        WHERE c.estado = 'fallida' AND NOT EXISTS (SELECT 1 FROM {datos}.corrida c2 WHERE c2.fuente_id = c.fuente_id
              AND c2.id > c.id AND c2.estado IN ('sin_cambios', 'con_candidato'))) x), '[]'::jsonb),
    'historial', coalesce((SELECT jsonb_agg(x ORDER BY x.decidido_en DESC, x.id DESC) FROM (
        SELECT c.id, c.estado, c.decidido_en, c.decidido_por, c.motivo, co.fuente_id, r.release_id,
               (SELECT count(*) FROM {datos}.hallazgo h WHERE h.corrida_id = c.corrida_id) AS hallazgos
        FROM {datos}.candidato c JOIN {datos}.corrida co ON co.id = c.corrida_id LEFT JOIN {datos}.release r ON r.candidato_id = c.id
        WHERE c.estado IN ('publicado', 'descartado') ORDER BY c.decidido_en DESC, c.id DESC LIMIT 50) x), '[]'::jsonb),
    'release', (SELECT to_jsonb(x) FROM (SELECT numero, release_id, publicado_en, aprobado_por FROM {datos}.release ORDER BY numero DESC LIMIT 1) x))
$$;

-- Un candidato: su estado, los archivos, los hallazgos con su última decisión y las propuestas del analista, y qué cambia
-- respecto de lo vigente (lo que cambia o falta primero; hasta 40 filas).
CREATE OR REPLACE FUNCTION {api}.candidato(candidato_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
DECLARE
  v_revisor text := {api}.exigir_revisor();
  v_corrida bigint;
  v_fuente text;
BEGIN
  SELECT c.corrida_id, co.fuente_id INTO v_corrida, v_fuente FROM {datos}.candidato c JOIN {datos}.corrida co ON co.id = c.corrida_id
  WHERE c.id = candidato.candidato_id;
  IF NOT FOUND THEN
    PERFORM {datos}.falla('no_existe', format('No existe el candidato %s', candidato.candidato_id));
  END IF;
  RETURN jsonb_build_object(
    'candidato', (SELECT to_jsonb(x) FROM (
        SELECT c.id, c.estado, c.creado_en, c.decidido_en, c.decidido_por, c.motivo, c.corrida_id, co.fuente_id, f.nombre AS fuente_nombre,
               r.numero AS release_numero, r.release_id, r.publicado_en, r.aprobado_por
        FROM {datos}.candidato c JOIN {datos}.corrida co ON co.id = c.corrida_id JOIN {datos}.fuente f ON f.id = co.fuente_id
        LEFT JOIN {datos}.release r ON r.candidato_id = c.id WHERE c.id = candidato.candidato_id) x),
    'estado', (SELECT to_jsonb(e) FROM {datos}.estado_revision(candidato.candidato_id) e),
    'archivos', coalesce((SELECT jsonb_agg(x ORDER BY x.id) FROM (
        SELECT d.id, regexp_replace(d.url, '^.*/', '') AS archivo, d.url, d.sha256, d.estado, d.descargada_en,
               d.publicada_en AS http_last_modified, d.error, d.bytes
        FROM {datos}.corrida_descarga cd JOIN {datos}.descarga d ON d.id = cd.descarga_id WHERE cd.corrida_id = v_corrida) x), '[]'::jsonb),
    'hallazgos', coalesce((SELECT jsonb_agg(x ORDER BY x.id) FROM (
        SELECT h.id, h.regla, h.severidad, h.serie_id, s.nombre AS serie_nombre, h.periodo, h.detalle,
               u.decision, u.revisor, u.comentario, u.decidida_en,
               coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM (
                   SELECT p.id, p.tipo, p.accion_sugerida, p.confianza, p.razonamiento, p.hechos, p.notas, p.origen, p.modelo,
                          p.evidencia, p.estado, p.revisor, p.comentario
                   FROM {datos}.propuesta p WHERE p.hallazgo_id = h.id) p), '[]'::jsonb) AS propuestas
        FROM {datos}.hallazgo h LEFT JOIN {datos}.serie s ON s.id = h.serie_id
        LEFT JOIN LATERAL (SELECT r.decision, r.revisor, r.comentario, r.decidida_en FROM {datos}.revision_hallazgo r
                           WHERE r.hallazgo_id = h.id ORDER BY r.id DESC LIMIT 1) u ON true
        WHERE h.corrida_id = v_corrida) x), '[]'::jsonb),
    'diferencias', (
      WITH filas AS (
        SELECT c.serie_id, c.periodo, c.valor AS nuevo, v.valor AS vigente, CASE WHEN v.valor IS NULL THEN 'nuevo' ELSE 'cambiado' END AS tipo
        FROM {datos}.observacion_candidata c
        LEFT JOIN {datos}.observacion_vigente v ON v.serie_id = c.serie_id AND v.periodo = c.periodo
        WHERE c.candidato_id = candidato.candidato_id AND (v.valor IS NULL OR v.valor <> c.valor)
        UNION ALL
        SELECT v.serie_id, v.periodo, NULL, v.valor, 'faltante' FROM {datos}.observacion_vigente v JOIN {datos}.serie s ON s.id = v.serie_id
        WHERE s.fuente_id = v_fuente AND NOT EXISTS (SELECT 1 FROM {datos}.observacion_candidata c
              WHERE c.candidato_id = candidato.candidato_id AND c.serie_id = v.serie_id AND c.periodo = v.periodo))
      SELECT jsonb_build_object(
        'nuevos', count(*) FILTER (WHERE tipo = 'nuevo'), 'cambiados', count(*) FILTER (WHERE tipo = 'cambiado'),
        'faltantes', count(*) FILTER (WHERE tipo = 'faltante'), 'total', count(*),
        'filas', coalesce((SELECT jsonb_agg(x ORDER BY x.tipo = 'nuevo', x.serie_id, x.periodo) FROM (
            SELECT * FROM filas ORDER BY tipo = 'nuevo', serie_id, periodo LIMIT 40) x), '[]'::jsonb))
      FROM filas));
END $$;

-- Para cada serie pedida, el candidato y lo vigente hoy: lo que dibuja el gráfico de un hallazgo.
CREATE OR REPLACE FUNCTION {api}.series(candidato_id bigint, serie_ids text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
BEGIN
  PERFORM {api}.exigir_revisor();  -- siempre, aunque no se pida ninguna serie
  RETURN (SELECT coalesce(jsonb_object_agg(s.id, jsonb_build_object(
      'candidato', coalesce((SELECT jsonb_agg(jsonb_build_array(c.periodo, c.valor) ORDER BY c.periodo) FROM {datos}.observacion_candidata c
                             WHERE c.candidato_id = series.candidato_id AND c.serie_id = s.id), '[]'::jsonb),
      'vigente', coalesce((SELECT jsonb_agg(jsonb_build_array(v.periodo, v.valor) ORDER BY v.periodo) FROM {datos}.observacion_vigente v
                           WHERE v.serie_id = s.id), '[]'::jsonb))), '{}'::jsonb)
    FROM unnest(series.serie_ids) AS s(id));
END $$;

-- Permisos: solo una sesión iniciada (el rol `authenticated` de Supabase) puede llamarlas; nadie más.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA {api} FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA {api} FROM anon';
    EXECUTE 'REVOKE ALL ON SCHEMA {api} FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA {api} FROM service_role';
    EXECUTE 'REVOKE ALL ON SCHEMA {api} FROM service_role';
  END IF;
END $$;
GRANT USAGE ON SCHEMA {api} TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA {api} TO authenticated;
"""


def sql_api(datos: str = "economia", api: str = "revision") -> str:
    """El SQL que instala el esquema de la API, para `datos` (el esquema del servicio)."""
    for nombre in (datos, api):
        if not NOMBRE.match(nombre):
            raise ValueError(f"Nombre de esquema inválido: {nombre!r}")
    if datos == api:
        raise ValueError("La API tiene que ir en otro esquema que los datos: el de los datos no se expone")
    return SQL.replace("{api}", api).replace("{datos}", datos)


def instalar(conn: psycopg.Connection, api: str = "revision", datos: str | None = None) -> str:
    """Instala (o reinstala) la API. Sin `datos`, usa el esquema donde está `schema_migrations`. Devuelve el esquema de datos."""
    if datos is None:
        fila = conn.execute("SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                            "WHERE c.oid = to_regclass('schema_migrations')").fetchone()
        if fila is None:
            raise ValueError("No se encontró schema_migrations en el search_path: ¿es la base del servicio, ya migrada?")
        datos = fila[0]
    with conn.transaction():
        # En Supabase el rol existe; en una base propia (o en las pruebas) se crea, sin poder iniciar sesión.
        conn.execute("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN "
                     "CREATE ROLE authenticated NOLOGIN; END IF; END $$")
        conn.execute(sql_api(datos, api))
    return datos


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Imprime el SQL de la API de revisión, para el SQL Editor de Supabase.")
    parser.add_argument("--esquema-datos", default="economia")
    parser.add_argument("--esquema-api", default="revision")
    args = parser.parse_args(argv)
    try:
        print(sql_api(args.esquema_datos, args.esquema_api).strip())
    except ValueError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
