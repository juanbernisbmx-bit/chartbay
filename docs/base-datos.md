# Base de datos: piloto local

La sección `/base-de-datos` permite seleccionar series económicas argentinas y
llevar un conjunto a `/econometria`. Es independiente de la antigua sección
`/data`, que sigue desactivada. El flag nuevo es `SECCIONES["base_datos"]`.

## Datos disponibles

- 100 entradas de catálogo: nacionales, provinciales y regionales.
- 7 series con valores reales: IPC general nacional y seis regiones de INDEC.
- 819 observaciones mensuales, base diciembre de 2016 = 100.
- Las 7 series cubren de diciembre de 2016 a agosto de 2026. El nacional sale de
  `sh_ipc_09_26.xls` (publicado el 10 de septiembre); el de agosto, `08_26`, llegaba
  hasta julio y dejaba al nacional un mes atrás de las regiones.
- 93 entradas sin observaciones: visibles al desmarcar el filtro de cargadas,
  pero no seleccionables. No se generan valores de ejemplo para ellas.

Las coberturas corresponden al contenido de los archivos conservados, no al
nombre del archivo ni a una promesa de actualización. La revisión humana
integral sigue pendiente; el piloto no representa datos aprobados para entrega.

El catálogo con observaciones está en `datasets/economia/catalogo.json`.
Se genera desde el repositorio separado de la base mediante
`scripts/preparar_piloto.py --chartbay /ruta/chartbay`. No editar esa copia a mano.
`CHARTBAY_DATA_DIR` permite usar otra carpeta que contenga `catalogo.json`.
La API de lectura es `GET /api/base-datos/catalogo`; no descarga datos de INDEC.

## Preparación y análisis

Se pueden seleccionar hasta 12 series mensuales, elegir fechas, una
transformación por serie y rezagos de 0 a 12 meses. Las transformaciones son
nivel original, variación mensual, variación interanual, primera diferencia y
logaritmo natural. Se calculan con el historial disponible antes de recortar
fechas. Los rezagos se miden por mes calendario, no por posición de la fila.

Los faltantes siguen siendo faltantes, nunca ceros. Por defecto se excluyen
los meses incompletos y se muestra cuáles fueron. Para conservarlos en el CSV,
desmarcar esa opción. Econometría mantiene sus propios controles de validación.
El primer ejemplo combina IPC nacional, Pampeana y Cuyo en variación mensual.
Las regiones integran el nacional: esa relación no demuestra causalidad.

En regresión, la serie elegida es Y y las restantes son X. En series de tiempo,
la serie elegida pasa como columna de valor. El CSV y la ficha de procedencia
cruzan juntos por IndexedDB; Econometría consume esa transferencia una vez.
No se ejecuta una estimación hasta que el usuario pulsa el botón del laboratorio.
La selección se conserva localmente en ese navegador.

El CSV contiene fechas y valores transformados. La ficha JSON descargable
contiene versión, variables, transformaciones, rezagos, período efectivo,
meses incompletos/excluidos, fuentes, URLs originales, hashes SHA-256 y las fechas
de publicación (`publishedAt`, la que informa la fuente) y de captura (`retrievedAt`).
Guardar ambos archivos juntos para conservar la trazabilidad del conjunto.

## Desarrollo y pruebas

```bash
cd quantbay
npm run build:database
```

Si cambia la integración del laboratorio, compilar también con `npx vite build`.
`npm run build` ya incluye ambos bundles. La normalización de artefactos sigue
en `npm run normalize:bundles`.

```bash
python tests/test_economic_database.py
python tests/test_web.py
cd quantbay
npm test -- tests/database tests/cleaner/dataCleaner.test.ts
```

La prueba `quantbay/tests/database/browserSmoke.cjs` requiere Playwright y Chrome.
Acepta `PLAYWRIGHT_MODULE`, `DATABASE_TEST_URL` y `DATABASE_SCREENSHOT_DIR`.
Verifica catálogo, descarga, procedencia, persistencia, regresión real, serie
de tiempo, capturas y dimensiones del gráfico en escritorio y móvil.

## Pendiente

PostgreSQL, recolección programada, historial de revisiones, aprobación humana
en una interfaz, permisos de acceso y ampliación provincial. El JSON actual es
un contrato de lectura para probar la experiencia, no el almacenamiento final.
