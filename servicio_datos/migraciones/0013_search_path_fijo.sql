-- Cada función del servicio resuelve los nombres en su propio esquema, llame quien llame (lo marcó el Security Advisor de
-- Supabase: "Function Search Path Mutable").
--
-- Una función sin search_path propio busca las tablas y las otras funciones que nombra sin esquema en el search_path de quien
-- la llama. Con otro esquema adelante, `publicar_candidato` podría llamar a una `falla` ajena que no frena nada y publicar con
-- hallazgos pendientes, o escribir en una tabla `release` que no es la del servicio. Con el search_path fijo eso no pasa.
-- `pg_temp` va último a propósito: si no se lo nombra, Postgres busca las tablas temporales antes que nada.
--
-- El esquema no tiene un nombre fijo (en Supabase es `economia`; en las pruebas, uno descartable), así que se fija el de la
-- migración. Las migraciones que agreguen funciones terminan con `CALL fijar_search_path();`, y una prueba revisa que no
-- quede ninguna sin fijar.

CREATE PROCEDURE fijar_search_path()
LANGUAGE plpgsql AS $$
DECLARE
  v_rutina regprocedure;
BEGIN
  FOR v_rutina IN
    SELECT p.oid::regprocedure FROM pg_proc p
    WHERE p.pronamespace = current_schema()::regnamespace AND p.prokind IN ('f', 'p')
      AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER ROUTINE %s SET search_path = %I, pg_temp', v_rutina, current_schema());
  END LOOP;
END $$;

CALL fijar_search_path();
