# Primer piloto para ChartBay

Las nuevas cargas se pueden mantener con el
[actualizador periódico Python](../despliegue/README.md). La configuración y los
archivos del temporizador están preparados; la activación en el servidor sigue
pendiente. El estado de cada fuente se conserva entre ejecuciones.

## Base masiva — 15 de octubre de 2026

La [importación masiva](base/README.md) amplía la recolección a los paquetes de
series de tiempo de Datos Argentina y los CSV provinciales y sectoriales de
Economía. Guarda observaciones, metadatos y procedencia en `base/economia.sqlite`,
además de un índice CSV y un informe de pendientes. Se consulta y exporta con
`scripts/consultar_base.py`. La [guía del proyecto](../README.md) explica cómo
recolectar, completar y reproducir la carga. Esta base incorpora también las
31 series de la importación local previa, identificadas como `club_local`.

## Ampliación por importación directa — 15 de octubre de 2026

Se descargaron los TOP mensuales oficiales de 2024, 2025 y 2026 y se incorporaron
las 24 jurisdicciones: **773 observaciones TOP**. Junto con los siete IPC del piloto,
el catálogo ampliado tiene **31 series disponibles y 1.592 observaciones**. Está en
[`importadas/catalogo.json`](importadas/catalogo.json) y copiado al catálogo local de
ChartBay. El [detalle de cobertura](importadas/README.md) identifica los últimos meses
por provincia y el faltante de diciembre de 2024 de La Pampa.

La carga conserva las cifras numéricas de la hoja `TOTAL`, sin redondear ni imputar.
Los originales se preservan por SHA-256 y el
[`CSV de observaciones`](importadas/top_mensual.csv) registra archivo, URL, hash,
hoja, fila y celda. Los ceros/vacíos se tratan como faltantes y su significado queda
pendiente de revisión; la representación exacta sigue en los Excel. La unidad se
verificó en cada original: millones de pesos corrientes. No se combinan frecuencias
ni se calcula un total nacional con coberturas provinciales distintas.

Para repetir la importación desde los originales descargados:

```bash
.venv/bin/python scripts/importar_top.py \
  --manifiesto datos/originales/top_candidato_20261015T202113657342Z.json \
  --chartbay /ruta/a/chartbay
```

Para descargar nuevas versiones, usar `--descargar` en lugar de `--manifiesto`.
Omitir `--chartbay` si solo se quieren generar los archivos locales en `datos/importadas`.
El script usa las herramientas existentes, sin agentes ni limpieza automática.
No carga en Supabase ni publica releases. La revisión metodológica y de licencias sigue pendiente.

El piloto auditado de ocho series en `datos/piloto/catalogo.json`, el inventario de
100 propuestas y el cargador administrativo Supabase conservan su comportamiento
anterior. `preparar_piloto.py --chartbay` vuelve a copiar ese piloto de ocho series;
usar `importar_top.py --chartbay` para mantener la ampliación.

## Alcance real

El catálogo mantiene 100 propuestas. Este piloto carga 7 series IPC de INDEC
(nacional y seis regiones) y el total mensual de recursos tributarios de origen
provincial de Córdoba publicado por la Dirección Nacional de Asuntos Provinciales.
Son 851 observaciones mensuales: 819 de IPC con base diciembre de 2016 = 100
y 32 de Córdoba en millones de pesos corrientes. Los valores del piloto no están
aprobados para investigación ni cargados en PostgreSQL. No hay descargas programadas.
La [auditoría técnica de las ocho series](AUDITORIA_8_SERIES.md) coteja las 851
observaciones con las celdas originales y separa ese resultado de la aprobación humana.

## Archivos conservados

| Original | Hoja | Cobertura observada |
| --- | --- | --- |
| `originales/sh_ipc_09_26.xls` | Índices IPC Cobertura Nacional | 2016-12 a 2026-08 |
| `originales/sh_ipc_aperturas.xls` | Índices aperturas | 2016-12 a 2026-08 |
| `originales/top_mensual_2024_0.xlsx` | TOTAL, Córdoba | 2024-01 a 2024-12 |
| `originales/top_mensual_2025_12.xlsx` | TOTAL, Córdoba | 2025-01 a 2025-12 |
| `originales/top_mensual_2026_18.xlsx` | TOTAL, Córdoba | 2026-01 a 2026-08 |

`originales/sh_ipc_08_26.xls` (2016-12 a 2026-07) se conserva como versión anterior del
nacional, pero ya no alimenta el piloto.

Fuentes directas:

- [Histórico nacional de INDEC](https://www.indec.gob.ar/ftp/cuadros/economia/sh_ipc_09_26.xls).
- [Histórico regional de INDEC](https://www.indec.gob.ar/ftp/cuadros/economia/sh_ipc_aperturas.xls).
- [TOP mensual y consideraciones metodológicas](https://www.argentina.gob.ar/economia/sechacienda/asuntosprovinciales/direccion-de-recursos-provinciales/recursos-tributarios-de-origen-provincial-top).

La cobertura se obtiene de las celdas, no del nombre de archivo. El nombre
`sh_ipc_MM_AA.xls` lleva un mes de archivo, no el del último dato: `08_26`
llega hasta julio y `09_26` llega hasta agosto. Sus encabezados HTTP
`Last-Modified` son del 13 de agosto y 10 de septiembre de 2026,
respectivamente; no los tratamos como fecha oficial de publicación.
La primera versión del piloto usó `08_26` y dejó al nacional un mes
atrás de las regiones. Las 116 observaciones comunes de ambas versiones son iguales.
Ambos originales contienen un encabezado `2026-03-26`: se interpreta como
marzo de 2026 por tratarse de series mensuales. Esa normalización figura en
cada ficha afectada. No se modifican los valores publicados.

`piloto/catalogo.json` conserva fuente, URL, SHA-256, hoja, fila y notas.
`retrieved_at` de los IPC vigentes se conserva por hash en el manifiesto, separado
de la fecha oficial de publicación. Así una clonación Git, que cambia los tiempos
del sistema de archivos, no cambia la versión auditada. Para originales sin fecha
de captura registrada se mantiene el timestamp local como compatibilidad.

`originales/manifiesto.json` asocia el SHA-256 IPC con el encabezado HTTP
`Last-Modified`. La instantánea lo registra como `http_last_modified_at`, no
como `published_at`: la fecha oficial de publicación aún no está confirmada.
Va por hash porque `sh_ipc_aperturas.xls` conserva el nombre en cada actualización.
Si la fecha HTTP figura posterior a la descarga, el script falla. El recolector
definitivo deberá conservar todas las versiones, sin sobrescribirlas.

`originales/top_manifest.json` identifica los tres archivos TOP por SHA-256,
URL, fecha de captura y encabezado HTTP `Last-Modified`. Este último **no es una
fecha oficial de publicación**: por eso `published_at` queda nulo. El parser
exige la hoja `TOTAL`, la fila única `Córdoba`, el año, la unidad, los doce
encabezados mensuales y que el total de la hoja coincida con la suma de los
meses presentes. Los ceros al final de 2026 indican meses aún sin informar;
no se guardan como recaudación cero. Un hueco interior o cambio de formato
detiene la carga. No se mezclan los informes mensual, trimestral y anual:
la propia fuente advierte que sus universos y criterios pueden diferir.
Cada ficha conserva `originals` con los tres archivos que respaldan la serie,
además de `original` para compatibilidad con el frontend del piloto.

## Reproducir la extracción

Para recolectar y validar nuevas versiones del IPC sin tocar el piloto vigente,
ver la [guía de candidatas IPC](IPC_CANDIDATAS.md). Incluye conservación por hash,
comparación de revisiones, rechazos de cobertura y promoción manual con respaldo.

Desde esta carpeta de proyecto, con Python 3.10 o posterior:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/preparar_piloto.py
.venv/bin/python -m unittest discover -s tests -v
```

Para copiar también el resultado al proyecto ChartBay:

```bash
.venv/bin/python scripts/preparar_piloto.py --chartbay /ruta/a/chartbay
```

El script lee los originales ya conservados; no realiza descargas ni requiere
credenciales. Comprueba regiones, fila Nivel general, números finitos positivos,
base de referencia, continuidad mensual, duplicados e IDs del catálogo. Para
TOP también comprueba encabezados, unidad, año, total y faltantes.
Escribe cada JSON mediante reemplazo atómico. No modifica los CSV del inventario.

Para buscar una nueva versión TOP y validarla sin modificar la instantánea vigente:

```bash
.venv/bin/python scripts/recolectar_top.py
.venv/bin/python scripts/preparar_piloto.py --check-top-candidate datos/originales/top_candidato_FECHA.json
```

El primer comando imprime la ruta real del manifiesto candidato. La recolección
guarda cada XLSX con su SHA-256 en el nombre, no sobrescribe los originales ya
vistos y falla si cambia el formato esperado o se pierde un año. El segundo
comprueba la candidata sin escribir `piloto/catalogo.json` ni copiar a ChartBay.
La comparación de cifras, cambios históricos y condiciones de uso debe revisarse
antes de promover una candidata; todavía no hay aprobación automática ni cron.

La instantánea auditada es `economia-piloto-ab569b5998c1`. El identificador
incluye ahora los valores extraídos; además, la fila de Córdoba se documenta
por archivo (10 en 2024; 11 en 2025 y 2026), no como una fila global única.

La interfaz de ChartBay lee esa copia, permite preparar el conjunto y lo
transfiere al laboratorio. Los cambios de selección no alteran los originales
ni la instantánea. Para reproducir un análisis, descargar conjuntamente el CSV
y la ficha JSON de procedencia desde la web.

## Estado de revisión

Es una versión de prueba local. La auditoría técnica confirmó fidelidad a los
originales publicados, pero no sustituye la decisión humana de publicación ni
la revisión de condiciones de reutilización.
Las otras 92 propuestas siguen sin datos; no se ofrecen para análisis.
El CSV y Excel del catálogo siguen siendo el inventario inicial: el estado
de disponibilidad del piloto está en `piloto/catalogo.json`.

## Cargar el piloto como candidato en Supabase

`scripts/cargar_supabase.py` implementa la carga inicial contra el esquema privado
`economia` ya instalado por ChartBay. Usa las tablas existentes `fuente`, `serie`,
`descarga`, `corrida`, `corrida_descarga`, `candidato`, `observacion_candidata` y
`hallazgo`. No inserta ni actualiza `release` u `observacion`: al terminar quedan dos
candidatos abiertos, uno de 819 observaciones de IPC y otro de 32 observaciones TOP.

Antes de usar credenciales, reproducir y revisar el plan:

```bash
.venv/bin/python scripts/cargar_supabase.py --dry-run
```

Debe informar el identificador `economia-piloto-ab569b5998c1`, 5 originales, 8
series, 851 observaciones y `"publica": false`. El comando vuelve a extraer desde
los XLS/XLSX y exige que el resultado completo sea igual a la instantánea auditada;
no confía solamente en el JSON.

La carga necesita el bucket privado `economia-crudos` y una conexión PostgreSQL
directa con permisos de escritura en el esquema `economia`. Las credenciales van
solo en variables de entorno; `.env` y sus variantes están ignorados por Git y
`.env.example` documenta los nombres:

```bash
export DATOS_DATABASE_URL='postgresql://usuario:contraseña@host:5432/postgres?sslmode=require'
export SUPABASE_URL='https://PROYECTO.supabase.co'
export DATOS_CLAVE_SERVIDOR='sb_secret_...'
# También se admite SUPABASE_SERVICE_ROLE_KEY para proyectos que aún usen esa clave.

.venv/bin/python scripts/cargar_supabase.py
```

Opcionalmente, `DATOS_SCHEMA` cambia `economia` y `DATOS_STORAGE_BUCKET` cambia
`economia-crudos`. No pasar secretos como argumentos: quedarían en el historial del
shell y en la lista de procesos. La URL PostgreSQL tampoco es la clave pública ni la
conexión del rol `servicio_datos` de las Edge Functions: ese rol mínimo solo puede
invocar su API y, deliberadamente, no puede hacer esta importación administrativa.

La operación sigue estas garantías:

- sube cada original con la ruta `<2 primeros caracteres>/<sha256>.<extensión>` y
  sin `upsert`; si ya existe, lo descarga y comprueba tamaño y SHA-256;
- registra URL, hash, bytes, ruta de Storage, captura, `Last-Modified` HTTP y
  `published_at` por separado; `Last-Modified` no se presenta como publicación;
- guarda en `corrida.resumen` los controles exitosos, el detalle de hoja/fila por
  serie, las notas y los pendientes metodológicos y legales;
- guarda como `hallazgo`, sin corregir datos, saltos mensuales mayores al 20 % y
  notas de normalización/procedencia (19 para IPC y 6 para TOP);
- realiza las dos fuentes en una única transacción PostgreSQL y verifica que cubran
  las 851 observaciones;
- es idempotente por identificador de piloto. Repetirla no duplica candidatos. Si
  ya existe un candidato abierto idéntico —por ejemplo, el IPC de una colecta
  anterior— lo reutiliza y registra una corrida `sin_cambios`; si es distinto,
  cancela toda la transacción en vez de descartarlo o reemplazarlo;
- si una persona ya descartó el candidato importado, repetir el comando informa ese
  estado y no lo revive. Tampoco ejecuta ninguna función de publicación.

El JSON final debe sumar 851 en `base`, mostrar cada candidato y terminar con
`"publicados": 0`. La revisión de hallazgos, la decisión humana y la publicación
atómica son pasos posteriores y explícitos del flujo de ChartBay.
