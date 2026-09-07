# Data Cleaner: revisión, reglas y cruce local de archivos

`/limpiador` importa CSV y Excel **.xlsx** en el navegador. La sección estadística
C++ existente sigue en `/limpiador?motor=estadistico` (imputación, atípicos e índices
temporales). Los datos de ambas rutas permanecen en el dispositivo.

## Operaciones disponibles

- **Perfilado avanzado:** inferencia de tipo sobre hasta 200 filas / 2 MiB, con
  corrección manual; faltantes y porcentaje de nulos, únicos **exactos**, min/max,
  media, mediana y cuartiles exactos, desvío estándar muestral, rango de fechas,
  categorías principales y ejemplos de errores. Se procesa el archivo completo
  para estadísticas y validaciones. La inferencia decimal ambigua lleva un aviso;
  no se reescriben números automáticamente.
- **Reglas por columna:** dato obligatorio; mínimo/máximo numérico inclusivos;
  intervalo de fechas inclusivo; cantidad exacta de dígitos; catálogo de valores
  permitidos. Incluye un catálogo editable de las 23 provincias argentinas + CABA.
- **Reglas entre columnas:** fecha de baja >= fecha de alta; total = suma de
  componentes, con tolerancia absoluta; edad en años cumplidos según nacimiento,
  fecha de referencia explícita y tolerancia en años. Los operandos ausentes o
  incompatibles incumplen la condición; no se tratan como cero ni como aprobados.
- **Outliers:** IQR (`Q1 − k×IQR`, `Q3 + k×IQR`), z-score con desvío muestral o
  percentiles configurables. Se puede elegir una o varias columnas numéricas.
  Nunca eliminan ni alteran celdas: solo generan banderas. IQR y percentiles
  requieren al menos 4 valores; z-score, 3 y desvío positivo. El método usa límites
  estrictos y cuantiles con interpolación lineal `p × (n−1)`.
- **Categorías:** sugiere equivalencias por mayúsculas, acentos, puntos, espacios
  y variantes habituales de Buenos Aires. Requiere selección explícita del usuario.
  También permite grupos manuales. Compara variantes exactas del original, aplica
  un único destino por valor y no encadena reemplazos. No se fusiona por similitud
  de forma automática. Las sugerencias se basan en las 32 categorías principales.
- **Severidad:** crítico, advertencia e informativo. Cada regla personalizada lleva
  su propia severidad. Texto sucio es informativo; faltantes, duplicados, tipos
  inválidos y outliers son advertencias. CUIT/CUIL inválido en al menos 20% de datos
  presentes es crítico. La severidad se recalcula para la propuesta.
- **Antes/después:** cuenta filas, incidencias por severidad y filas con errores.
  “Errores” suma críticos y advertencias, no informativos; una fila puede incumplir
  varias reglas. Se vuelve a validar la propuesta, incluidos duplicados que surjan
  al normalizar categorías. Los umbrales de outliers del original se mantienen
  fijos para comparar. Las filas descartadas se informan por separado. Antes de
  aplicar, el resultado es una proyección claramente etiquetada.
- **Recetas:** guarda políticas, tipos por nombre de columna, reglas, grupos y
  parámetros de outliers. Persisten en `localStorage`, se pueden importar/exportar
  como JSON, actualizar por nombre y eliminar. Máximo 50 recetas / 1 MiB total.
  Se vinculan por nombre, no por posición; si falta una columna requerida, se
  rechaza la carga antes de cambiar la configuración. Cargar no aplica cambios:
  requiere actualizar la vista previa y aplicar explícitamente. Son datos
  declarativos, nunca código evaluado.
- **Cruce e histórico:** archivo principal = actual; segundo archivo = referencia
  o mes anterior. Cada uno admite CSV o una hoja de Excel y opciones de importación
  independientes. Se elige una clave de cada archivo, aunque tengan distinto nombre.
  Informa claves compartidas, filas sin cambios/modificadas, nuevas, eliminadas,
  claves repetidas de ambos lados, filas ambiguas y claves faltantes. Compara campos
  comunes por encabezado, informa columnas nuevas/eliminadas y variaciones de
  media/mediana, nulos y cambios bruscos de valores por clave. El umbral porcentual
  es configurable (25% inicial); una base numérica cero se marca sin inventar un
  porcentaje. El cruce usa **los originales**, con independencia de la propuesta.

## Semántica de integridad

- La primera fila no vacía es el encabezado. Nombres vacíos/repetidos se normalizan
  solo con la regla correspondiente; aparecen en la propuesta y auditoría y se
  pueden conservar literalmente. CSV mal formado o filas inconsistentes fallan
  sin truncar campos. UTF-8, Windows-1252 y UTF-16 con BOM; delimitador automático
  o seleccionado por el usuario.
- Los duplicados de limpieza son filas originales exactamente iguales; se conserva
  la primera. Las claves de cruce son otra cosa: si se repite una clave en cualquiera
  de los dos archivos, **no se emparejan filas arbitrariamente** ni se genera un
  producto cartesiano. Se exportan todas esas filas como ambiguas cuando la clave
  existe en ambos. Las claves vacías no coinciden entre sí.
- El cruce compara claves literalmente por defecto. Opcionalmente ignora espacios
  y mayúsculas, o quita guiones de CUIT/CUIL válidos. Nunca convierte claves a número:
  `001` y `1` siguen siendo distintas. Campos no clave se comparan literalmente.
- CUIT/CUIL: 11 dígitos, prefijos 20/23/24/27/30/33/34 y módulo 11. No consulta
  padrones ni valida titularidad. Las claves inválidas se conservan por defecto;
  solo se quitan guiones a las válidas. La regla personalizada “11 dígitos” es más
  estricta sobre la escritura y no reemplaza el control del dígito verificador.
- Orden de limpieza: descarte de duplicados/faltantes originales según políticas;
  espacios/Unicode; marcadores a vacío; tipos inválidos a vacío si se solicita;
  formato CUIT válido; grupos de categorías aprobados. Las reglas de validación
  y los outliers solo señalan. La auditoría explica cada cambio.
- Aplicar conserva una versión de reglas, no otra copia del dataset. Deshacer
  restaura hasta 50 aplicaciones de la sesión, incluidas filas descartadas.
- Excel usa valores guardados, cadenas compartidas/inline, celdas dispersas y
  calendarios 1900/1904. Las fórmulas no se ejecutan; se informa si falta resultado
  guardado. No se conservan estilos, macros o máscaras numéricas. Identificadores
  con ceros visibles solo por formato deben guardarse como texto. No importa
  .xls/.xlsb ni libros cifrados: convertirlos a .xlsx primero.

## Exportación

- **CSV limpio:** UTF-8 con BOM; opcionalmente escapa fórmulas con apóstrofo.
- **Auditoría JSON v2:** origen/hoja, reglas, perfiles, antes/después, historia,
  todos los cambios y todas las incidencias pendientes, sin recortar ejemplos.
  Usa la protección del último CSV exportado de la versión aplicada; antes de la
  primera exportación usa la opción actual.
- **Reporte antes/después JSON:** también disponible antes de aplicar, etiquetado
  como vista previa; incluye contadores y perfiles completos.
- **Cruce JSON:** resumen, esquemas, distribuciones y todas las filas/diferencias.
  El UI muestra hasta 20 registros por estado y 20 adicionales de claves duplicadas,
  hasta 8 campos por ejemplo; el archivo contiene el detalle íntegro.
- CSV, auditoría y cruce se escriben incrementalmente con File System Access u
  OPFS. No se ensamblan los archivos de datos completos en RAM. El traspaso a
  Econometría utiliza un Blob de disco y espera el commit de IndexedDB.

## Memoria, disco y límites

`storage.ts` mantiene la base de la sesión y una segunda base para la referencia:

| Store | Propósito |
|---|---|
| rows | Originales, bloques de hasta 256 filas / ~512 KiB |
| strings | Cadenas compartidas de Excel, en disco |
| seen | Duplicados exactos del original o de la propuesta; se limpia después |
| numbers | Índice ordenado `[columna, valor, secuencia]` para cuantiles exactos |
| categories | Frecuencias y únicos exactos en disco |
| keys | Índice de claves de cruce con conteo y ubicación de primera fila |
| comparison | Detalles del cruce por bloques |

CSV y XML de Excel se leen en bloques de 64 KiB. Se limita un registro a 4 MiB,
4096 columnas, muestra de tipos a 2 MiB y etiquetas principales a 4 MiB compartidos
entre columnas. Se retienen como máximo 32 etiquetas de hasta 500 caracteres por
columna; si se omiten por estos límites, se avisa que la lista es parcial. Los
conteos y únicos siguen siendo exactos. Las condiciones/grupos tienen un límite
conjunto de 1 MiB y máximo 100 reglas y 100 grupos. Claves de cruce: 4096 caracteres.
Los metadatos XML de Excel se limitan a 4 MiB por entrada.

Los índices numéricos y de frecuencias se liberan al terminar de perfilar. El cruce
solo conserva dos bloques de la referencia en caché. Hay cancelación cooperativa,
controles bloqueados durante operaciones y manejo explícito de falta de cuota.
Al cambiar archivo/salir se libera el worker y se intenta borrar ambas bases y los
archivos temporales; una recarga limpia los restos de la sesión de esa pestaña.
Un cierre abrupto puede dejar datos temporales: borrar datos del sitio los elimina.
Las recetas se conservan separadamente. No hay promesa de tamaño ilimitado: el
espacio de disco/cuota y ancho del registro limitan los archivos, no un dataset
completo materializado en el heap.

## Pruebas y build

Desde `quantbay/`:

```sh
npm test -- tests/cleaner
npx tsc --noEmit
npm run build:cleaner
npm run normalize:bundles
```

Se versionan `quantbay.cleaner.js` y `quantbay.data-cleaner.worker.js`; producción
no compila Node. Las pruebas cubren reglas, fechas límite, tolerancias, cuantiles,
severidad, categorías, restauración, recetas con columnas reordenadas, joins con
claves repetidas/vacías, registros entre bloques y exportación completa.

Con Flask en localhost:5057 y Playwright/Chrome instalados:

```sh
node tests/cleaner/browserSmoke.cjs
node tests/cleaner/browserAdvanced.cjs
CLEANER_LARGE_FILE=/ruta/actual.csv CLEANER_REFERENCE_FILE=/ruta/anterior.csv node tests/cleaner/browserComparisonMemory.cjs
```

`PLAYWRIGHT_MODULE` puede señalar una instalación externa; `CLEANER_TEST_URL`
cambia el origen y `CLEANER_SCREENSHOT` guarda una captura. Los fixtures .xlsx
fueron generados con openpyxl y contienen solo datos sintéticos.

Medición local de la versión avanzada, Chrome, 2026-09-07: dos CSV de 100.377.807 y
100.377.781 bytes, cada uno con 100.000 filas / 3 columnas. Importación + perfilado
exacto + validación: 25,5 s y 25,6 s; cruce: 7,9 s; total: 59,1 s. Resultado:
99.990 claves compartidas, 5.882 filas modificadas, 94.108 sin cambios, 10 nuevas y
10 eliminadas. Pico observado: **35,5 MiB de heap del worker + backing storage**
(235 muestras CDP `Runtime.getHeapUsage`, cada 250 ms). Esto no mide RAM total del
navegador/sistema y depende del equipo, disco y datos.
