# Entrega Codex: parser y validación del IPC

Rama `codex/ipc-parser`, worktree `/private/tmp/chartbay-ipc-parser`, base
`4cacfa0` de `claude/base-datos-postgres`. Archivos propios:
`ipc/parser.py`, `ipc/validacion.py`, `tests/test_parser.py`,
`tests/test_validacion.py` y la línea `xlrd==2.0.2` de `requirements.txt`.

## Contrato listo para el orquestador

- `leer_archivo(descarga.ruta, archivo_configurado)` devuelve
  `dict[str, SerieLeida]` o lanza `ErrorParseo`. Las fechas se normalizan al
  primer día del mes con nota, y los valores son `Decimal(str(float))`.
- `validar(series, vigentes, descargas, *, hoy=None)` devuelve `list[Hallazgo]`.
  El argumento `hoy` es opcional y sirve para fijar el reloj en pruebas. No
  modifica datos ni publica candidatos.
- `descargas` debe incluir los dos archivos de la corrida, nuevos o idénticos;
  la regla de frescura solo corre para archivos presentes ahí.
- Reglas: `estructura`, `base_referencia`, `continuidad`, `rango`,
  `salto_mensual`, `fecha_normalizada`, `historia_intacta`, `cobertura`,
  `cruce_regional`, `frescura`.

## Decisiones provisionales

`SALTO_MENSUAL_ALERTA_PCT = 20` y `DIA_LIMITE_PUBLICACION = 25` están al inicio
de `ipc/validacion.py`. Son umbrales para **alertar**, no para rechazar ni
modificar un valor; Juani puede cambiarlos tras revisar el historial y el
calendario oficial. Al 2026-10-06 los XLS vigentes producen 12 alertas de salto
histórico y 7 notas de encabezado normalizado, ninguna de cobertura o frescura.
Con el nacional viejo `08_26`, la cobertura y la frescura sí alertan.

## Comprobación

Los tests sintéticos de parser y validación no necesitan los XLS de INDEC. Con
`DATOS_IPC_ORIGINALES_DIR` se agrega la prueba contra `09_26` y aperturas.
Comparé los resultados contra `scripts/preparar_piloto.py`: coinciden los 819
valores de las siete series del piloto actualizado.

En el checkout compartido corregí mi test `test_piloto_chartbay.py` para que
se saltee cuando el JSON local no exista, como pediste. No toqué archivos de
Claude ni hice push.

## Auditoría de las ocho series del piloto (2026-10-07)

Acta y pruebas en `/Users/juani/Documents/ChatGPT/base de datos club de economia/datos/AUDITORIA_8_SERIES.md`
y `tests/test_auditoria_piloto.py` de ese repositorio. Las cinco descargas oficiales
actuales coinciden por SHA-256 con los originales locales. Se compararon
independientemente 819 celdas IPC y 32 celdas TOP con la instantánea: 0 diferencias.

- Nuevo `release_id`: `economia-piloto-ab569b5998c1`. Sustituye a
  `economia-piloto-688837c87d24` porque ahora la huella incluye valores y
  metadatos extraídos; **los valores no cambiaron**. No mezclar ambos IDs.
- En TOP Córdoba, la fila es 10 en 2024 y 11 en 2025/2026. El campo global
  `source_row` ahora es `null`; usar `originals[*].source_row` según el año.
  Si copiás la instantánea a `datasets/economia/catalogo.json`, respetar esto.
- IPC: 117 meses por serie, 2016-12 a 2026-08, base dic-2016=100. El informe
  de agosto fue publicado el 10/09/2026, pero la hora oficial no consta: no
  convertir `Last-Modified` HTTP en `published_at`.
- TOP: 32 meses, 2024-01 a 2026-08, millones de ARS corrientes. Los ceros
  terminales de sep-dic 2026 no son datos publicados. Los libros declaran
  fechas `Última actualización` 2025-08-19, 2026-09-14 y 2026-10-02;
  mantenerlas separadas de fecha HTTP, captura y período de referencia.
- La conformidad técnica no autoriza publicar: siguen pendientes la decisión
  humana y la revisión de redistribución/atribución (sitio INDEC CC BY-SA 4.0;
  portal Argentina.gob.ar CC BY 4.0, con origen provincial subyacente). El XLSX
  primario de Córdoba no pudo descargarse: HTTP 403; el cotejo numérico TOP es
  contra el archivo nacional oficial, no contra la base primaria provincial.
- Decisión actual de Juani: sin servidor Ubuntu por ahora. No desplegar el
  servicio local ni dar por funcional el agente con API. La recolección Python,
  la revisión Flask y el modelo local existentes requieren una decisión de
  adaptación para operar solo sobre Supabase más una API externa. Conservar
  candidato y aprobación humana; el agente solo propone.

Este archivo es una nota de integración; no modifica tus módulos ni la rama.

## Integración de revisión en ChartBay (2026-10-07)

Vi `servicio_datos/api_revision.py` recién creado y adapté el cliente a su
contrato real: `revision.cola()`, `candidato(candidato_id)`, `revisar`,
`aceptar_pendientes`, `publicar`, `descartar`. La corrida fallida usa el error
que ya trae `cola`, porque todavía no hay una RPC de detalle de corrida. La
interfaz usa Supabase Auth con clave **publicable** y no envía identidad ni
prefijo de release; la API exige el revisor activo y los toma de la base.

El proyecto remoto conserva `economia` fuera de los esquemas expuestos. En
Data API desactivé la exposición automática de tablas nuevas. Instalé las
migraciones 0005-0010 (las 0001-0004 ya estaban) y `api_revision.py`, y
registré las diez migraciones en `economia.schema_migrations`. Expuse
`revision` y solo sus siete RPC públicas (`cola`, `candidato`, `series`,
`revisar`, `aceptar_pendientes`, `publicar`, `descartar`), sin exponer tablas.
Los helpers `revisor_actual` y `exigir_revisor` no están seleccionados en la
Data API. Confirmé que `anon` no puede ejecutar `revision.cola()` (HTTP 401)
ni acceder a `economia` (HTTP 406 porque el esquema no está expuesto).
También comprobé con `has_*_privilege` que `authenticated` no tiene acceso
directo a `economia` y que sí puede ejecutar `revision.cola()`.

Registré como único revisor activo `juanbernisbmx@gmail.com` (nombre `Juani`).
En Auth desactivé el registro libre y mantuve la confirmación por correo.
Todavía no hay usuarios de Auth: Juani eligió enviar su invitación **después
del despliegue de ChartBay**, porque el `Site URL` actual es
`http://localhost:3000`. Hasta entonces no hay prueba de extremo a extremo
con una sesión autenticada real. No incluir claves secretas en ChartBay.

## Infraestructura Supabase para la colecta (2026-10-07)

- Bucket privado de Storage: **`economia-crudos`**. Está vacío, `public=false`,
  sin políticas para `anon`/`authenticated` y con el límite global de 50 MB
  por archivo. Claude: usar exactamente este nombre en `colectar-ipc`; guardar
  cada original con una clave derivada de SHA-256 y metadatos de procedencia en
  la base. La Edge Function deberá usar la credencial de servidor, nunca la
  clave publicable del navegador.
- Extensiones `pg_cron` (esquema `pg_catalog`) y `pg_net` (esquema `extensions`)
  habilitadas. Cron muestra cero trabajos. Vault ya estaba instalado y no tiene
  secretos. No se creó el trabajo ni se agregó un secreto todavía: hace falta
  definir el endpoint desplegado, el método de autenticación y una prueba
  manual satisfactoria de la Edge Function antes de programar su ejecución.
- En el remoto no existen los roles personalizados `datos_escritura` ni
  `chartbay_lectura`; los permisos de revisión operan con `authenticated` y
  RPCs `SECURITY DEFINER`. Para la colecta, acordar con Claude un acceso de
  servidor de privilegio mínimo antes de desplegar y no poner credenciales
  privilegiadas en el frontend.
- Security Advisor de Supabase: 0 errores y 34 advertencias al 2026-10-07.
  Entre las visibles hay funciones de `economia` sin `search_path` fijado,
  incluidas `publicar_candidato`, `descartar_candidato` y
  `aceptar_pendientes`. Claude: evaluar y cubrir esto en una migración SQL
  propia, con pruebas de publicación y de permisos antes de aplicarla al
  remoto. No cambié las funciones SQL desde el panel.

## Distribución de series aprobadas por GitHub (decisión de Juani)

GitHub será una copia versionada para consultar y descargar **solo releases
aprobados**. Supabase sigue siendo la fuente de verdad y conserva candidatos,
hallazgos, decisiones, corridas y archivos crudos; nada de eso se exporta al
repositorio público. La sincronización ocurre después de `publicar`, no antes.

Para el piloto, propongo un archivo CSV por serie y release, más un manifiesto
JSON que enumere `release_id`, `serie_id`, fuente, unidad, frecuencia, cobertura,
licencia/atribución, cantidad de observaciones y SHA-256 de cada CSV. ChartBay
puede consultar la copia publicada con caché; nunca debe tomar un candidato de
GitHub. Si falla la exportación, el release de la base sigue aprobado, pero la
sincronización queda pendiente y reintentable; no anunciar un manifiesto
incompleto como versión vigente. Falta decidir el repositorio de destino (el
propio, el de la facultad o ambos) y revisar permisos de redistribución antes
de automatizar la subida. Juani pidió no hacer push todavía.

## Despliegue Supabase de la colecta y los avisos (2026-10-08)

- Proyecto `oqbqdngieifjlgbppvey` (Oregon): migraciones 0011-0014 aplicadas y
  registradas en `economia.schema_migrations`. El rol `servicio_datos` tiene
  LOGIN, contraseña elegida por Juani y acceso solo a las funciones del esquema
  privado `servicio`; no ve tablas de `economia` ni puede revisar o publicar.
- Los secretos `DATOS_CLAVE_CRON` y `DATOS_DATABASE_URL` están cargados como
  secretos de Edge Functions. La URL usa el pooler de transacciones y el rol
  limitado. Las dos funciones `colectar-ipc` y `avisar` están desplegadas con
  autenticación propia por `x-chartbay-clave` y sin verificación JWT externa.
  Sin encabezado, ambas devolvieron HTTP 401.
- La primera llamada autorizada a `colectar-ipc` devolvió `con_candidato`
  (corrida 1, candidato 1, 19 hallazgos); la segunda, `sin_cambios` (corrida 2).
  La base guarda 819 observaciones candidatas, cuatro registros de descarga y
  dos originales en el bucket privado `economia-crudos`. `avisar` devolvió
  `sin_canales: true`: no hay webhook de Slack configurado.
- `colectar-ipc` tiene un único trabajo activo en `pg_cron`:
  `30 12,20 * * *` UTC, equivalente a 9:30 y 17:30 de Argentina. La URL del
  proyecto y la clave del cron están en Vault; no se escribieron en el SQL del
  trabajo. `avisar` sigue **sin cron** hasta tener un webhook y una URL pública
  de la revisión.
- Probé la misma llamada de `pg_net` que ejecutará el cron, leyendo ambos
  valores de Vault: HTTP 200, `sin_cambios`, corrida 3. El tramo
  Vault -> pg_net -> Edge Function -> base quedó comprobado.
- Endurecí `api_revision.py` y la instalación remota: las nueve funciones de
  `revision` tienen `EXECUTE` solo para `authenticated`, no para `anon` ni
  `service_role`. Los helpers `revisor_actual` y `exigir_revisor` tampoco están
  expuestos en Data API. Falta la prueba de interfaz con una sesión real:
  Juani decidió invitar su único usuario de Auth después del despliegue web.
- El empaquetador de Supabase no pudo bajar SheetJS del CDN. Dejé la versión
  CE 0.20.3 vendorizada en `supabase/functions/_vendor/xlsx-0.20.3/` y cambié
  el import de `parser_ipc.ts` a esa copia. Las pruebas Deno relevantes dieron
  17 aprobadas, una omitida (requiere XLS locales). No hice push.

Claude: vi los pasos nuevos del analista (0015) y respaldo (0016). **Todavía no
están desplegados**. El analista necesita la API key externa y autorización de
Juani; el respaldo requiere decidir claves S3/rol y manejo del artefacto. No
asumas que esos pasos se instalaron por haber quedado lista la colecta.

## Canal de avisos por Discord (2026-10-08)

Juani eligió Discord en lugar de Slack. Creó el servidor `ChartBay Datos` y el
canal **privado** `#alertas-datos` (solo él tiene acceso). El webhook
`ChartBay Avisos` quedó asignado a ese canal, no a `#general`. Su URL se cargó
en Supabase como secreto de Edge Functions `DATOS_AVISOS_DISCORD_URL`, mediante
entrada oculta en terminal y archivo temporal eliminado al terminar. No está
en el repositorio ni en esta nota. El espacio de Slack creado antes no tiene
webhook configurado y no se usará para estos avisos.

Claude terminó la integración de Discord en `avisar` (commit `4c7ffc1`).
Codex ejecutó las pruebas locales: 16 aprobadas, ninguna fallida y una omitida
(requiere base). Desplegué esa versión en Supabase el 2026-10-08. Una llamada
manual usando la clave desde Vault respondió HTTP 200 con `creados: 1`,
`enviados: 1`, `fallidos: 0`; una segunda respondió HTTP 200 con `creados: 0`,
`enviados: 0`. La función registró una entrega exitosa a Discord y no duplicó
el aviso. No pude inspeccionar el mensaje en la interfaz de Discord porque la
sesión web había caducado; la confirmación de entrega viene de la respuesta
de la función. Consulté `cron.job`: sigue activo solo `colectar-ipc`; `avisar`
no tiene trabajo programado.

La URL prevista de la revisión es
`https://chartbay.onrender.com/base-de-datos/revision`, pero esa ruta todavía
no está publicada porque Juani pidió no hacer push/despliegue hasta terminar.
No cargar `DATOS_REVISION_URL` ni activar el cron de avisos hasta verificar la
ruta pública y configurar Supabase Auth. La prueba manual de entrega ya pasó,
por ahora sin enlace a la página de revisión.
