"""El esquema `servicio` y el rol `servicio_datos`: lo único que pueden tocar las Edge Functions (colecta, avisos y analista).

Las Edge Functions se conectan a Postgres con un rol propio que no ve las tablas. Solo puede ejecutar estas funciones, que
envuelven las del servicio:

- la colecta (migraciones 0011 y 0012): abrir una corrida, registrar lo que bajó, anotarla y cerrarla sin candidato
  (`sin_cambios` o `fallida`), saber si un archivo ya se conocía y dejar un candidato con `cargar_candidato`, que valida y
  anota los hallazgos;
- los avisos (migración 0014): detectarlos, tomar los pendientes para entregarlos y anotar cómo fue cada entrega;
- el analista (migración 0015): proponer por precedente, ver los hallazgos con sus hechos y entregar lo que dijo el modelo, que la
  base valida contra los hechos que reúne ella antes de guardarlo como propuesta.

No puede leer ni cambiar lo publicado, revisar hallazgos ni publicar. Si su contraseña se filtrara, lo peor que se puede hacer
con ella es dejar un candidato falso (que igual tiene que pasar por la revisión de una persona), callar un aviso o dejar una
propuesta tonta (que pasa por el validador y que una persona igual decide).

Un solo rol para todas las Edge Functions: sus secretos son de todo el proyecto (cada función ve los de las otras), así que un
rol por función no aislaría nada y sumaría contraseñas.

Cada función es `SECURITY DEFINER` con `search_path` fijo, como las de `revision`. El esquema no se expone en la API de
Supabase: las Edge Functions llegan directo a Postgres.

No es una migración porque crea un rol (que es de todo el servidor, no de un esquema) y se puede reinstalar entera. Para el
panel de Supabase: `python -m servicio_datos.api_servicio` imprime el SQL. El rol se crea sin poder iniciar sesión; se habilita
aparte, con una contraseña que no pasa por este código (ver docs/base-datos-supabase.md).
"""
from __future__ import annotations

import argparse
import re
import sys

import psycopg

NOMBRE = re.compile(r"^[a-z_][a-z0-9_]*$")

SQL = r"""
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{rol}') THEN
    CREATE ROLE {rol} NOLOGIN;
  END IF;
END $$;
COMMENT ON ROLE {rol} IS 'Las Edge Functions del servicio de datos: solo ejecutan las funciones del esquema {api}.';
ALTER ROLE {rol} SET statement_timeout = '60s';  -- una carga tarda milisegundos: lo que pase de un minuto está trabado

CREATE SCHEMA IF NOT EXISTS {api};
COMMENT ON SCHEMA {api} IS 'Lo que pueden hacer las Edge Functions: corridas, descargas, candidatos, avisos y propuestas. No publican ni leen lo publicado.';

-- La colecta ---------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION {api}.asegurar_fuente(p_fuente text, p_nombre text, p_url_base text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
  SELECT {datos}.asegurar_fuente(p_fuente, p_nombre, p_url_base)
$$;

CREATE OR REPLACE FUNCTION {api}.abrir_corrida(p_fuente text, p_vencimiento_segundos double precision DEFAULT 21600) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
  SELECT {datos}.abrir_corrida(p_fuente, p_vencimiento_segundos)
$$;

CREATE OR REPLACE FUNCTION {api}.ultima_descarga(p_url text) RETURNS TABLE (sha256 text, ruta_crudo text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
  SELECT * FROM {datos}.ultima_descarga(p_url)
$$;

CREATE OR REPLACE FUNCTION {api}.registrar_descarga(p_corrida bigint, p_url text, p_estado text, p_sha256 text DEFAULT NULL,
                                                    p_bytes bigint DEFAULT NULL, p_ruta_crudo text DEFAULT NULL,
                                                    p_publicada_en timestamptz DEFAULT NULL, p_error text DEFAULT NULL) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
  SELECT {datos}.registrar_descarga(p_corrida, p_url, p_estado, p_sha256, p_bytes, p_ruta_crudo, p_publicada_en, p_error)
$$;

CREATE OR REPLACE FUNCTION {api}.anotar_corrida(p_corrida bigint, p_resumen jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
  SELECT {datos}.anotar_corrida(p_corrida, p_resumen)
$$;

-- Sin candidato, nada más: una corrida termina `con_candidato` solo por `cargar_candidato`, que es la que lo deja.
CREATE OR REPLACE FUNCTION {api}.cerrar_corrida(p_corrida bigint, p_estado text, p_error text DEFAULT NULL, p_resumen jsonb DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
BEGIN
  IF p_estado IS DISTINCT FROM 'sin_cambios' AND p_estado IS DISTINCT FROM 'fallida' THEN
    PERFORM {datos}.falla('estado_no_permitido', format('La colecta solo cierra corridas sin cambios o fallidas, no «%s»', p_estado));
  END IF;
  RETURN {datos}.cerrar_corrida(p_corrida, p_estado, p_error, p_resumen);
END $$;

CREATE OR REPLACE FUNCTION {api}.cargar_candidato(p_corrida bigint, p_hoy date, p_carga jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
  SELECT {datos}.cargar_candidato(p_corrida, p_hoy, p_carga)
$$;

-- Los avisos ----------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION {api}.detectar_avisos(p_hoy date, p_ahora timestamptz DEFAULT now(), p_dia_limite integer DEFAULT 25,
                                                 p_recordatorio_dias integer DEFAULT 3) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
  SELECT {datos}.detectar_avisos(p_hoy, p_ahora, p_dia_limite, p_recordatorio_dias)
$$;

CREATE OR REPLACE FUNCTION {api}.tomar_avisos(p_hoy date, p_dia_limite integer DEFAULT 25, p_segundos integer DEFAULT 300) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
  SELECT {datos}.tomar_avisos(p_hoy, p_dia_limite, p_segundos)
$$;

CREATE OR REPLACE FUNCTION {api}.registrar_entrega(p_aviso bigint, p_entregas jsonb, p_completo boolean) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
  SELECT {datos}.registrar_entrega(p_aviso, p_entregas, p_completo)
$$;

-- El analista --------------------------------------------------------------------------------------
-- Solo deja propuestas: los hechos los reúne la base y lo que dice el modelo lo valida la base antes de guardarlo.

CREATE OR REPLACE FUNCTION {api}.proponer_por_precedentes() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
  SELECT {datos}.proponer_por_precedentes()
$$;

CREATE OR REPLACE FUNCTION {api}.hallazgos_para_el_modelo(p_limite integer DEFAULT 50) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
  SELECT {datos}.hallazgos_para_el_modelo(p_limite)
$$;

CREATE OR REPLACE FUNCTION {api}.proponer(p_hallazgo bigint, p_respuesta jsonb, p_modelo text, p_hechos_vistos jsonb) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = {datos}, pg_temp AS $$
  SELECT {datos}.proponer(p_hallazgo, p_respuesta, p_modelo, p_hechos_vistos)
$$;

-- Permisos: el rol de las Edge Functions y nadie más (tampoco los de la API de Supabase).
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA {api} FROM PUBLIC;
REVOKE ALL ON SCHEMA {api} FROM PUBLIC;
DO $$
DECLARE
  v_rol text;
BEGIN
  FOREACH v_rol IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_rol) THEN
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA {api} FROM %I', v_rol);
      EXECUTE format('REVOKE ALL ON SCHEMA {api} FROM %I', v_rol);
    END IF;
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA {api} TO {rol};
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA {api} TO {rol};
"""


def sql_api(datos: str = "economia", api: str = "servicio", rol: str = "servicio_datos") -> str:
    """El SQL que instala el esquema y el rol de las Edge Functions, para `datos` (el esquema del servicio)."""
    for nombre in (datos, api, rol):
        if not NOMBRE.match(nombre):
            raise ValueError(f"Nombre inválido: {nombre!r}")
    if datos == api:
        raise ValueError("La API tiene que ir en otro esquema que los datos: el rol de las Edge Functions no ve el de los datos")
    return SQL.replace("{api}", api).replace("{datos}", datos).replace("{rol}", rol)


def instalar(conn: psycopg.Connection, api: str = "servicio", rol: str = "servicio_datos", datos: str | None = None) -> str:
    """Instala (o reinstala) la API. Sin `datos`, usa el esquema donde está `schema_migrations`. Devuelve el esquema de datos."""
    if datos is None:
        fila = conn.execute("SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                            "WHERE c.oid = to_regclass('schema_migrations')").fetchone()
        if fila is None:
            raise ValueError("No se encontró schema_migrations en el search_path: ¿es la base del servicio, ya migrada?")
        datos = fila[0]
    with conn.transaction():
        conn.execute(sql_api(datos, api, rol))
    return datos


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Imprime el SQL del esquema y el rol de las Edge Functions, para el SQL Editor de Supabase.")
    parser.add_argument("--esquema-datos", default="economia")
    parser.add_argument("--esquema-api", default="servicio")
    parser.add_argument("--rol", default="servicio_datos")
    args = parser.parse_args(argv)
    try:
        print(sql_api(args.esquema_datos, args.esquema_api, args.rol).strip())
    except ValueError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
