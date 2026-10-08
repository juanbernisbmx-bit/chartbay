# Puesta en marcha de la base de datos económica

La lista, en orden, de lo que falta para que el servicio de datos ande solo en Supabase: quién lo hace, cómo y cómo se comprueba.
El porqué de cada pieza está en `docs/base-datos-supabase.md`; acá van los pasos. Estado al 2026-10-08.

Proyecto de Supabase: `oqbqdngieifjlgbppvey` (Oregon). Código: rama `claude/base-datos-postgres` (se integra a `main` sin conflictos)
más la página de revisión de Codex.

## Cómo se cargan los secretos sin que queden escritos en ningún lado

- **Contraseñas de roles de la base**: desde `psql` con la conexión de administrador, `\password <rol>` (la pide dos veces y manda solo
  el hash). Nunca en el SQL Editor, que guarda las consultas.
- **Secretos de las Edge Functions**: en un archivo con permisos 600 (`chmod 600 datos.env`), `supabase secrets set --env-file
  datos.env`, y se borra el archivo. Nunca `supabase secrets set CLAVE=valor` en la línea de comandos: queda en el historial.
- **Secretos de GitHub**: `gh secret set <NOMBRE>` pide el valor sin mostrarlo. Las variables no son secretas: `gh variable set
  <NOMBRE> --body <valor>`.
- **Para probar las funciones a mano**: la clave del cron va en un archivo de encabezados con permisos 600, con la línea
  `x-chartbay-clave: <DATOS_CLAVE_CRON>`, y se usa con `curl -H @encabezado-cron.txt`.

## 0. Ya hecho

- [x] Esquema `economia` con las migraciones 0001 a 0014, y la API `revision` instalada, endurecida y expuesta, con un revisor
  activo (`juanbernisbmx@gmail.com`). (Codex)
- [x] Rol `servicio_datos` con contraseña y esquema `servicio`. (Codex)
- [x] Bucket privado `economia-crudos`, pg_cron, pg_net y Vault (`project_url`, `clave_cron`). (Codex)
- [x] Secretos de las Edge Functions `DATOS_CLAVE_CRON`, `DATOS_DATABASE_URL` y `DATOS_AVISOS_DISCORD_URL`. (Codex)
- [x] `colectar-ipc` desplegada, probada y con cron a las 9:30 y 17:30 de Argentina. Dejó el candidato 1. (Codex)
- [x] `avisar` desplegada, en una versión anterior a Discord. (Codex)

## 1. Antes de integrar (Codex)

- [ ] **Aplicar las migraciones 0015, 0016 y 0017**, en orden y con `search_path` en `economia`, como las anteriores. No activan nada
  por sí solas (las funciones del analista, los textos de los avisos del respaldo y la exportación).
- [ ] **Volver a correr el SQL de `python -m servicio_datos.api_servicio`**: le suma al rol `servicio_datos` las funciones del analista.
- [ ] **Volver a desplegar `avisar`** desde la rama de Claude: `supabase functions deploy avisar --no-verify-jwt`.
  Se comprueba con `curl -sS -o /dev/null -w '%{http_code}' -X POST https://oqbqdngieifjlgbppvey.supabase.co/functions/v1/avisar`,
  que tiene que dar 401. **Todavía sin una llamada autorizada**: mandaría el aviso del candidato 1 sin enlace, y ese aviso no se repite.
- [ ] **Commitear la página de revisión** y lo que la acompaña. En `THIRD_PARTY_NOTICES.md`, sumar SheetJS CE 0.20.3 (Apache-2.0,
  licencia en `supabase/functions/_vendor/xlsx-0.20.3/LICENSE`).

Comprobación: `SELECT version FROM economia.schema_migrations ORDER BY 1;` llega a `0017`.

## 2. Integrar y desplegar ChartBay (Juani)

- [ ] **En Render, las variables de la página de revisión**: `SUPABASE_URL=https://oqbqdngieifjlgbppvey.supabase.co` y
  `SUPABASE_PUBLISHABLE_KEY=<la clave publicable, sb_publishable_…>`. Esa clave puede ir al navegador; la secreta nunca va a ChartBay.
- [ ] **Merge a `main` y push.** Render despliega solo.
- [ ] **Apagar los dos flujos programados hasta configurarlos**, si no van a fallar todos los días (y avisar por correo):

  ```bash
  gh workflow disable respaldo-datos.yml
  ```

  ```bash
  gh workflow disable exportar-datos.yml
  ```

Comprobación: `curl -s https://chartbay.onrender.com/version` devuelve el commit nuevo, y
`https://chartbay.onrender.com/base-de-datos/revision` muestra la pantalla de inicio de sesión.

## 3. La revisión con sesión (Codex y Juani)

- [ ] **Supabase Auth**: `Site URL` = `https://chartbay.onrender.com`, y `https://chartbay.onrender.com/base-de-datos/revision` entre
  las direcciones de redirección permitidas. (Codex)
- [ ] **Invitar a `juanbernisbmx@gmail.com`** desde Auth → Users. El registro libre sigue apagado. (Codex)
- [ ] **Aceptar la invitación**, elegir la contraseña y entrar a la página. (Juani)

Comprobación: con la sesión iniciada se ve la cola con el candidato 1 (19 hallazgos).

## 4. Avisos con enlace (Codex)

- [ ] **Secreto `DATOS_REVISION_URL`** = `https://chartbay.onrender.com/base-de-datos/revision` (con `--env-file`, como arriba).
- [ ] **Un aviso a mano**: `curl -sS -X POST -H @encabezado-cron.txt https://oqbqdngieifjlgbppvey.supabase.co/functions/v1/avisar`.
  Tiene que contestar `"creados"` y `"enviados"` de al menos 1, sin `errores`, y llegar a `#alertas-datos` el aviso del candidato 1
  con su enlace (abre la revisión en `#candidato=1`). Si llega sin enlace, volver a desplegar `avisar` y probar con el próximo aviso.
- [ ] **Su cron**, cada hora a los 45 minutos:

  ```sql
  SELECT cron.schedule('avisar', '45 * * * *', $$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/avisar',
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'x-chartbay-clave', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'clave_cron')),
      body := '{}'::jsonb, timeout_milliseconds := 60000)
  $$);
  ```

Comprobación: `SELECT tipo, estado, entregas FROM economia.aviso ORDER BY id DESC LIMIT 5;` muestra `enviado` con
`"discord": {"ok": true, ...}`.

## 5. El analista (Juani autoriza, Codex instala). Opcional antes del paso 6

Si querés las propuestas del analista para revisar el candidato 1, este paso va antes del 6; si no, puede ir después.

- [ ] **Autorizar el gasto** (del orden de un dólar por candidato con `claude-opus-5-5`, la mitad con `claude-sonnet-5-5`) y crear
  una clave de la API de Anthropic. (Juani)
- [ ] **Secretos** `ANTHROPIC_API_KEY` y, si se cambia el modelo, `DATOS_ANALISTA_MODELO`. (Codex)
- [ ] **Desplegar**: `supabase functions deploy analizar --no-verify-jwt`. (Codex)
- [ ] **Una corrida a mano**: `curl -sS -X POST -H @encabezado-cron.txt https://oqbqdngieifjlgbppvey.supabase.co/functions/v1/analizar`.
  Tiene que contestar `por_modelo`, `sin_respaldo` y `por_precedente`, sin `fallidos`; si quedan `sin_tiempo`, la próxima corrida
  sigue. En la página, cada hallazgo aparece con su propuesta.
- [ ] **Su cron**, cada hora a los 35 minutos: el mismo SQL del paso 4 con `'analizar'`, `'35 * * * *'`, `/functions/v1/analizar` y
  `timeout_milliseconds := 150000`.

## 6. El primer release (Juani)

- [ ] **Revisar los hallazgos del candidato 1** en la página (aceptar o rechazar, con comentario) y **publicar**.

Comprobación: la cola muestra el release vigente, y `SELECT release_id, publicado_en FROM economia.release;` tiene una fila.

## 7. La copia pública (Juani y Codex)

- [ ] **Confirmar la licencia de INDEC** y cargarla. Según la auditoría de Codex, el sitio declara CC BY-SA 4.0. (Juani)

  ```sql
  UPDATE economia.fuente SET licencia = '<licencia>', licencia_url = '<enlace a su texto>', atribucion = '<cómo citarla>'
  WHERE id = 'INDEC_IPC';
  ```

- [ ] **El rol `datos_respaldo`**: correr en `psql` lo que imprime `python -m servicio_datos.respaldar sql-del-rol`, con el mismo
  usuario que aplica las migraciones, y después `\password datos_respaldo`. Lo usan la copia y el respaldo. (Codex)
- [ ] **Secreto del repo** `DATOS_RESPALDO_DATABASE_URL` = `postgresql://datos_respaldo.oqbqdngieifjlgbppvey:<contraseña>@<host del
  pooler>:5432/postgres?sslmode=require`: el pooler en **modo sesión** (puerto 5432), no la conexión directa. (Codex o Juani)

  ```bash
  gh secret set DATOS_RESPALDO_DATABASE_URL
  ```

- [ ] **Prender el flujo y correrlo**. (Codex o Juani)

  ```bash
  gh workflow enable exportar-datos.yml
  ```

  ```bash
  gh workflow run exportar-datos.yml
  ```

Comprobación: aparece en `main` un commit «datos: copia pública de ipc-…» que solo toca `datasets/economia/publicado/`, y después de
traerlo, `python -m servicio_datos.exportar comprobar --destino datasets/economia/publicado` no da errores. Render redespliega solo.

## 8. El respaldo (Juani y Codex)

- [ ] **Claves S3 del bucket**: en la configuración de Storage, activar la conexión S3 y crear un par de claves de acceso. (Codex)
- [ ] **Secretos y variables del repo**: `gh secret set SUPABASE_S3_ACCESS_KEY_ID`, `gh secret set SUPABASE_S3_SECRET_ACCESS_KEY`,
  `gh variable set SUPABASE_S3_ENDPOINT --body https://oqbqdngieifjlgbppvey.supabase.co/storage/v1/s3` y `gh variable set
  SUPABASE_S3_REGION --body <la región que muestra Storage>`. `DATOS_RESPALDO_DATABASE_URL` ya está del paso 7. (Codex o Juani)
- [ ] **Recomendado, el cifrado**: `age-keygen -o chartbay-respaldo.key` en una computadora propia (`brew install age`), la clave
  privada guardada fuera del repo (un gestor de contraseñas), y `gh variable set DATOS_RESPALDO_AGE_DESTINATARIO --body age1…`. (Juani)
- [ ] **Prender el flujo y correrlo**: `gh workflow enable respaldo-datos.yml` y `gh workflow run respaldo-datos.yml`.
- [ ] **Abrir un paquete una vez**, para saber que se puede: `gh run download <corrida> -n respaldo-datos-<corrida>`, `age -d -i
  chartbay-respaldo.key -o respaldo.tar.gz <paquete>.age` y `tar -tzf respaldo.tar.gz`. (Juani)

Comprobación: la corrida termina en verde con su artefacto, y `SELECT ok, error, detalle -> 'ensayo' FROM economia.respaldo ORDER BY
id DESC LIMIT 1;` da `ok = true` y el ensayo de la restauración.

## 9. Opcional: el monitor externo

Un chequeo de Healthchecks por función, cada uno en su secreto: `DATOS_MONITOR_COLECTA_URL` (dos veces por día),
`DATOS_MONITOR_AVISAR_URL` (cada hora) y `DATOS_MONITOR_ANALIZAR_URL` (cada hora). Si una función deja de correr, avisa el silencio.

## 10. Después (Claude)

Con un mes andando sin problemas, borrar el Python que ya no se usa (el colector, la revisión Flask, el despliegue en Ubuntu, el modelo
local y el respaldo a disco), según `docs/base-datos-supabase.md`, "Qué pasa con el Python".

## Todas las variables, de un vistazo

| Dónde | Nombre | Qué es | Paso |
| --- | --- | --- | --- |
| Edge Functions | `DATOS_CLAVE_CRON` | lo que manda pg_cron en `x-chartbay-clave` | hecho |
| Edge Functions | `DATOS_DATABASE_URL` | la base con el rol `servicio_datos`, por el pooler de transacciones | hecho |
| Edge Functions | `DATOS_AVISOS_DISCORD_URL` | el webhook de `#alertas-datos` | hecho |
| Edge Functions | `DATOS_REVISION_URL` | la página de revisión, para los enlaces de los avisos | 4 |
| Edge Functions | `ANTHROPIC_API_KEY`, `DATOS_ANALISTA_MODELO` | el analista (el modelo es opcional) | 5 |
| Edge Functions | `DATOS_MONITOR_COLECTA_URL`, `DATOS_MONITOR_AVISAR_URL`, `DATOS_MONITOR_ANALIZAR_URL` | latidos, opcionales | 9 |
| Edge Functions | `DATOS_AVISOS_SLACK_URL`, `DATOS_AVISOS_RECORDATORIO_DIAS`, `DATOS_CLAVE_SERVIDOR` | opcionales: Slack, días del primer recordatorio (3), una clave `sb_secret_…` para Storage | — |
| Edge Functions | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | los pone Supabase | — |
| Render | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | la página de revisión (clave publicable) | 2 |
| GitHub, secreto | `DATOS_RESPALDO_DATABASE_URL` | el rol `datos_respaldo`, por el pooler en modo sesión | 7 |
| GitHub, secreto | `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY` | las claves S3 del bucket | 8 |
| GitHub, variable | `SUPABASE_S3_ENDPOINT`, `SUPABASE_S3_REGION` | dónde está el bucket | 8 |
| GitHub, variable | `DATOS_RESPALDO_AGE_DESTINATARIO` | la clave pública de age, opcional | 8 |

## Cómo ver que todo anda

```sql
SELECT version FROM economia.schema_migrations ORDER BY 1 DESC LIMIT 1;                 -- 0017
SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;                         -- colectar-ipc, avisar, analizar
SELECT id, estado, iniciada_en FROM economia.corrida ORDER BY id DESC LIMIT 5;           -- la colecta corre dos veces por día
SELECT tipo, estado, intentos FROM economia.aviso ORDER BY id DESC LIMIT 5;              -- enviados, sin fallidos
SELECT ok, iniciado_en FROM economia.respaldo ORDER BY id DESC LIMIT 3;                  -- uno bueno por día
SELECT release_id, publicado_en FROM economia.release ORDER BY numero DESC LIMIT 3;      -- lo publicado
```
