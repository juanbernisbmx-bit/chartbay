# Importación masiva de series

Recolección iniciada el 15 de octubre de 2026.

**49,201 series catalogadas; 43,599 con observaciones; 7,656,792 registros de valores distintos.**

Base consultable: [economia.sqlite](economia.sqlite). Índice: [catalogo_series.csv](catalogo_series.csv). Registro de cobertura y pendientes: [informe_importacion.json](informe_importacion.json).

## Cobertura

| Catálogo | Series | Con valores | Valores distintos |
| --- | ---: | ---: | ---: |
| agroindustria | 392 | 375 | 55363 |
| bcra | 1550 | 339 | 346450 |
| club_local | 31 | 31 | 1592 |
| cultura | 10 | 10 | 170 |
| defensa | 60 | 60 | 980 |
| economia_sectorial | 14088 | 14088 | 615241 |
| energia | 77 | 35 | 3905 |
| jgm | 581 | 581 | 1258045 |
| justicia | 938 | 863 | 24375 |
| modernizacion | 719 | 719 | 1409060 |
| obras | 2810 | 2526 | 28365 |
| otros | 6 | 6 | 1512 |
| salud | 180 | 180 | 9607 |
| siep | 1148 | 388 | 21316 |
| smn | 240 | 240 | 105839 |
| snic | 4000 | 4000 | 77161 |
| sspm | 20680 | 18178 | 3633775 |
| sspre | 34 | 5 | 106 |
| test_node | 1 | 1 | 3 |
| transporte | 5 | 5 | 12155 |
| turismo | 1651 | 969 | 51772 |

Los nombres son los identificadores de los catálogos de origen; no equivalen a organismos actuales. El dump incluye series económicas y de otras temáticas, catálogos históricos y un nodo de prueba (`test_node`). `economia_sectorial` reúne el archivo de valores provinciales y sectoriales de Economía. `club_local` conserva las series IPC y TOP de la importación previa sin empalmarlas con las del portal.

## Qué se conserva

Cada original se identifica por SHA-256 y cada registro apunta al archivo y a su fila de origen. Las fechas de captura, las URLs y Last-Modified HTTP se guardan aparte. El índice y la base conservan los metadatos de publicación sin presentarlos como fecha de actualización verificada.

Los números se almacenan como texto, con sus decimales y ceros originales. No se corrigen valores, no se completan faltantes, no se convierten monedas ni se agregan frecuencias. Las celdas vacías se conservan, pero no se cuentan como observaciones disponibles ni como revisiones. La tabla `observacion` conserva todas las procedencias. La vista `valores` reúne únicamente copias con catálogo, serie, período, valor y frecuencia textualmente idénticos. Dos cifras distintas del mismo período siguen disponibles y se exportan por separado.

Los CSV adicionales también se guardan por fila como listas de celdas, incluidos encabezados repetidos y campos vacíos. Las distribuciones se vinculan por URL y nombre exacto de columna; no se adivinan correspondencias. El archivo sectorial usa sus identificadores de sector, variable, frecuencia y alcance; las unidades se unen al diccionario solo cuando hay una correspondencia única.

## Pendientes medidos

- 774,112 registros de procedencia contienen celdas vacías; se conservan sin completar y no inflan la cobertura.
- 5,602 series catalogadas siguen sin valores descargados.
- 10,258 series del catálogo global tienen un conteo distinto del declarado en sus metadatos.
- 307,595 períodos de series conservan más de un valor o frecuencia textual; no se elige una revisión.
- 0 series aparecen en los valores sin una ficha de metadatos coincidente.
- 144 Excel/ZIP/otros recursos se descargaron como originales y esperan extracción específica.
- 34 intentos terminaron con error; sus URLs y causas están en el informe.

La descarga masiva global y los dumps por catálogo no tienen idéntica cobertura. Se conservaron y combinaron con procedencia en lugar de asumir que el global estaba completo. Algunos enlaces originales ya no funcionan y parte del material es histórico. La cobertura corresponde a los paquetes y enlaces efectivamente consultados, no a todas las publicaciones que pueden existir en cada sitio.

## Consultar y exportar

Desde la raíz del proyecto:

```bash
.venv/bin/python scripts/consultar_base.py buscar 'actividad' --catalogo sspm --limite 10
.venv/bin/python scripts/consultar_base.py exportar --catalogo CATALOGO --serie ID --salida outputs/serie.csv
```

La exportación crea un CSV y una ficha JSON de procedencia. SQLite se abre en modo de solo lectura. También puede consultarse con DB Browser for SQLite u otra herramienta compatible.

## Reproducir

```bash
.venv/bin/python scripts/importar_masivo.py --manifiesto datos/originales/masivo/manifiesto_20261015T202808911216Z.json
```

Esta base es una importación local sin revisión de cifras. El agente y la limpieza quedan pendientes. No modifica datos aprobados ni publica en Supabase. ChartBay conserva su catálogo local de 31 series; el catálogo masivo se consulta con SQLite y el buscador/exportador de este proyecto.
