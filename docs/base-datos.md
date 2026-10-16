# Base de datos: piloto local

La sección `/base-de-datos` permite seleccionar series económicas argentinas y
llevar un conjunto a `/econometria`. Es independiente de la antigua sección
`/data`, que sigue desactivada. El flag nuevo es `SECCIONES["base_datos"]`.

## Datos disponibles

- 100 entradas de catálogo: nacionales, provinciales y regionales.
- 31 series con valores: 7 IPC de INDEC y 24 TOP provinciales.
- 1.592 observaciones: 819 IPC y 773 TOP.
- IPC: diciembre de 2016 a agosto de 2026, base diciembre de 2016 = 100.
- TOP: enero de 2024 a julio, agosto o septiembre de 2026 según jurisdicción,
  en millones de pesos corrientes. La Pampa tiene un faltante en diciembre de 2024.
- 69 entradas siguen sin observaciones y no se habilitan para análisis.

Se conservan los valores y archivos de origen, sin redondear ni completar faltantes.
Los ceros/vacíos del TOP se omiten como faltantes y su significado sigue pendiente
de revisión. La captura y Last-Modified HTTP no se presentan como publicación oficial.
La revisión humana integral sigue pendiente.

El catálogo del piloto está en `datasets/economia/catalogo.json`.
`CHARTBAY_DATA_DIR` permite leer otro directorio. La API
`GET /api/base-datos/catalogo` no inicia descargas.

## Recolección y actualización en Python

El módulo [base_economia](../base_economia/README.md) contiene los importadores,
originales del piloto, pruebas, catálogo masivo y actualizador periódico.
El catálogo masivo SQLite se consulta con su buscador/exportador; la web sigue
usando el piloto JSON de 31 series. Los archivos masivos y SQLite se conservan
fuera de Git.

Para generar la copia del piloto desde los TOP conservados, desde esta raíz:

```bash
python base_economia/scripts/importar_top.py \
  --manifiesto base_economia/datos/originales/top_candidato_20261015T202113657342Z.json \
  --chartbay .
```

El [actualizador Python](../base_economia/scripts/actualizar_base.py) decide qué
fuentes consultar por frecuencia, conserva revisiones, reintenta fallos y evita
duplicados. La [guía de servidor](../base_economia/despliegue/README.md) incluye
las unidades systemd preparadas; todavía no están instaladas en un servidor.
Esta carga no activa el agente, no limpia datos ni publica releases en Supabase.

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
en una interfaz, permisos de acceso y activación del actualizador. El JSON actual es
un contrato de lectura para probar la experiencia, no el almacenamiento final.
