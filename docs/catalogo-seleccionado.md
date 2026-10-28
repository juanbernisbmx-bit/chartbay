# Catálogo seleccionado y recolección en Supabase Free

Implementación del 27 de octubre de 2026. La selección reproducible y el cargador
viven en el proyecto `base de datos club de economia`; ChartBay mantiene la lectura
web, las funciones Deno y los contratos de PostgreSQL.

Estado remoto comprobado el 28/10/2026: contratos instalados, recolector desplegado
con JWT habilitado y cron activo cada dos minutos. 1.000 series cargadas; 997
consultas activas y tres variantes de salario mínimo pausadas porque incluyen
períodos hasta abril de 2027. Una prueba real entregó candidatos y se comprobaron
ejecuciones de Cron exitosas. El usuario autorizó la publicación e integración
el 28/10/2026: se publicaron las 997 series activas, con 257.373 observaciones,
licencia y atribución por fuente. La base ocupaba 115,9 MB al finalizar los lotes.
Este cambio activa el modo `selected` en el Blueprint de Render; su despliegue
debe comprobarse con `/version` y el catálogo público.

## Componentes

- `03_catalogo_paginado.sql`: instala búsqueda de metadatos, con 50 resultados por
  página, y consulta independiente de los valores de una serie. Solo devuelve
  series mensuales publicadas de fuentes con licencia y atribución.
- `04_colecta_series_api.sql`: reserva trabajos por serie, carga candidatos,
  conserva revisiones, evita copias idénticas y registra reintentos. El rol
  existente `servicio_datos` solo recibe las funciones de `servicio_series`; no
  puede revisar ni publicar ni leer directamente las tablas.
- `colectar-series`: consulta dos series por invocación en la API oficial de Datos
  Argentina, conserva la captura privada en Storage y entrega sus cifras a la base.
  Paginación completa, máximo 5.000 períodos, 500 KB por página y 1 MB por captura.
  Conserva los tokens numéricos antes de convertirlos a `double`; un cero sigue
  siendo cero y una celda nula no se rellena. No transforma ni agrega frecuencias.
- `05_programar_series.sql`: programa una ejecución cada dos minutos, usando los
  secretos existentes `project_url` y `clave_cron` y la clave pública JWT `anon`,
  conservada como `clave_publica_jwt` en Vault. Cada serie se consulta
  nuevamente a las 24 horas de su éxito. Fallos: 1, 2, 4, 8, 16 y 24 horas de espera.

Las reservas vencen a los ocho minutos para recuperar trabajos interrumpidos.
Una captura nueva compara sus valores con el candidato abierto o el release
vigente. Si no cambiaron, no se crea otra copia candidata. Si cambiaron, el
candidato anterior se conserva como descartado y el nuevo espera revisión.
No se habilita publicación automática ni se envían mensajes a otros servicios.

La recolección deja de reservar trabajos al alcanzar 350 MB de base o 750 MB de
Storage. Esto protege el margen de Free; no garantiza operación indefinida sin
administrar históricos. Los candidatos anteriores siguen ocupando espacio:
la política de archivo/retención y la copia externa siguen pendientes. Ese freno
aparece como respuesta 503 con el motivo de presupuesto; no borra datos.

## Instalación

1. Completar la carga privada seleccionada desde el proyecto de la base.
2. Ejecutar 03 y 04 en el proyecto existente, con `postgres`. Son instaladores
   idempotentes adicionales; no reescriben los checksums de migraciones 0001–0017.
3. Ejecutar el SQL generado por `scripts/preparar_consultas_supabase.py`, que solo
   registra identificadores ya presentes en la base. Antes de activar el cron,
   aplicar `outputs/supabase/pausar_futuros.sql` del proyecto de la base para
   mantener apartadas las tres variantes salariales de esta selección.
4. Desplegar `supabase functions deploy colectar-series --project-ref
   oqbqdngieifjlgbppvey`, manteniendo la verificación JWT habilitada. Reutiliza `DATOS_DATABASE_URL`,
   `DATOS_CLAVE_CRON`, `SUPABASE_URL` y la clave interna de Storage que el runtime
   ya entrega. No copiar claves al código, al navegador o al SQL Editor.
   La llamada usa el JWT público `anon` para la puerta JWT de Supabase y el
   encabezado secreto del cron para autorizar el trabajo. El JWT público por sí
   solo no inicia una colecta: una petición sin el secreto devuelve 401.
5. Probar una invocación autenticada desde Vault y verificar sus candidatos.
6. Aplicar 05 y comprobar `cron.job` y los registros de `consulta_serie_api`.
7. Tras revisar y publicar una primera fuente, desplegar el cambio de ChartBay y
   configurar `CHARTBAY_DATABASE_MODE=selected`, junto con `SUPABASE_URL` y su clave
   publicable existente. No usar claves administrativas en Render para la lectura.

El modo `selected` es adicional a `published` y al piloto. Sus rutas son:

- `GET /api/base-datos/catalogo?q=&topic=&level=&page=1`: metadatos paginados.
- `GET /api/base-datos/serie/<id>`: una ficha publicada con sus valores.

Una selección guardada en el navegador puede incluir series de otras páginas;
se recuperan por identificador. La tabla y las descargas siguen trabajando con
un máximo de 12 series. Este modo pide los valores al seleccionar y conserva el
identificador de release de cada serie en la ficha de procedencia. Su caché de
metadatos está acotada a 128 búsquedas y cinco minutos. Ante una caída se informa
el error; el modo seleccionado no usa la copia masiva de GitHub como respaldo.

Las fichas sin clasificación territorial se muestran como `Sin clasificar`.
El selector inicial usa los metadatos y popularidad del catálogo de origen;
no equivale a una revisión metodológica ni completa licencias automáticamente.

## Verificación

```bash
python -m unittest tests.test_economic_database tests.test_selected_catalogue tests.test_web
python -m unittest servicio_datos.tests.test_catalogo_seleccionado
deno test supabase/functions/colectar-series/api_test.ts
deno check supabase/functions/colectar-series/index.ts
cd quantbay
npm test -- tests/database
npm run build:database
```

Las pruebas PostgreSQL usan un cluster temporal y comprueban permisos, separación
de candidatos, paginación, decimales, idempotencia y fallos. Las de interfaz
comprueban que abrir la página solo pida metadatos y que elegir una serie descargue
sus valores y conserve la selección al pasar de página.

El estado remoto verificado y las mediciones se registran en los informes del
proyecto de la base; la existencia de estos archivos no acredita su despliegue.
