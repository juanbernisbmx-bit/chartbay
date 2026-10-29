# Catálogo relevante y vigente

La selección del 29/10/2026 contiene 144 series: 126 mensuales, 10 diarias y 8 anuales. Prioriza agregados principales y diversidad temática, limita detalles repetidos y conserva los históricos completos. El manifiesto reproducible se genera en el repositorio de catálogo con `scripts/seleccionar_catalogo_relevante.py` y `scripts/preparar_catalogo_curado.py`.

ChartBay consulta Supabase con el modo `selected`. El catálogo admite búsqueda por nombre, tema, cobertura y frecuencia. La preparación de datos conserva días, meses o años y exige la misma frecuencia para combinar series; no agrega ni completa cifras. Los rezagos diarios son días calendario. La variación interanual diaria compara con la misma fecha del año anterior; si no existe ese dato queda ausente.

## Instalación y actualización

Aplicar `servicio_datos/despliegue/supabase/06_catalogo_curado.sql` y `07_colecta_curada.sql` después de 01–05. La instalación existente puede actualizar su índice y consulta con `08_optimizar_catalogo.sql`, que limita primero a las series elegidas. Desplegar `supabase/functions/colectar-curado` con verificación JWT habilitada. Registrar las series verificadas y capturas originales, cargar las publicaciones y activar la selección al finalizar. `catalogo_curado_config.activo=false` conserva la lectura mensual anterior durante la transición.

El cron existente de series seleccionadas llama a `colectar-curado` cada dos minutos, un trabajo por invocación. Comprueba diarias cada seis horas, mensuales cada 24 horas y anuales cada siete días. Cada descarga valida identificador, definición, frecuencia, unidad, licencia y fechas, conserva cifras decimales originales y guarda la captura privada identificada por SHA-256. Las mensuales y anuales usan CSV oficiales de SSPM; las diarias, la API BCRA v4 paginada.

El usuario autorizó la publicación automática: una captura íntegra y válida se publica dentro de una transacción y registra `sistema:catalogo_curado`. Una captura incompleta, con períodos futuros o una definición distinta no reemplaza el release anterior. No hace falta una aprobación humana de cada actualización. La autorización está limitada a la lista elegida; JWT, cabecera de cron y permisos privados siguen vigentes.

La lista visible también exige una observación dentro de los últimos 14 días para diarias, tres meses para mensuales o dos años para anuales. Si la fuente queda rezagada sale de la búsqueda hasta recuperar vigencia; su recolección sigue activa y sus históricos no se borran. Excluir una serie cambia su visibilidad y programación sin borrar releases. La selección no activa fuentes ajenas ni cambia el recolector independiente de IPC.

Hay un freno antes de 350 MB de base y 750 MB de Storage. Conserva margen en el plan gratuito; si se alcanza, deja de recolectar y exige revisar capacidad, nunca elimina históricos automáticamente. Los originales BCRA mantienen su aviso de uso informativo, educativo y académico con atribución; no se etiquetan como CC BY.

Verificación: pruebas PostgreSQL de aislamiento, publicación, idempotencia, precisión y capturas incompletas; pruebas Deno de CSV y BCRA; preparación diaria/mensual/anual y filtro del lector. Después del despliegue comprobar los 144 identificadores, fechas y cantidades contra el manifiesto, cron y una captura real.
