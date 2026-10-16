# Auditoría técnica de las ocho series del piloto

Fecha de revisión: 7 de octubre de 2026. Instantánea: `economia-piloto-ab569b5998c1`.

## Dictamen

**Conformidad técnica con los originales conservados: 8/8 series, 851/851 observaciones, sin diferencias numéricas.** Los cinco archivos que alimentan la instantánea coincidieron byte por byte (SHA-256) con nuevas descargas de sus URL oficiales el día de esta revisión. Las pruebas leen las celdas directamente, con filas y rótulos fijados en `tests/test_auditoria_piloto.py`; no llaman a los parsers de producción para decidir el valor esperado.

Esto **no es aprobación para publicación de investigación**. Los datos siguen siendo un piloto local, no están cargados ni aprobados en Supabase. La revisión final de condiciones de redistribución y la decisión de publicación corresponden a una persona responsable. Esta auditoría acredita fidelidad a los archivos publicados, no la exactitud de los registros administrativos o del relevamiento de origen.

## IPC: siete series

Fuente: [series históricas del IPC de INDEC](https://www.indec.gob.ar/Nivel4/Tema/3/5/31), archivos `sh_ipc_09_26.xls` (total nacional) y `sh_ipc_aperturas.xls` (seis regiones). La [ficha de metadatos de INDEC](https://www.indec.gob.ar/ftp/cuadros/economia/serie_ipc_metadatos.txt) identifica `Indice_IPC` como índice de cobertura nacional por región, base diciembre de 2016=100, distinto de las variaciones mensual e interanual. INDEC confirma esas seis regiones y la cobertura nacional en su [página del indicador](https://www.indec.gob.ar/Nivel4/Tema/3/5/31).

| Serie | Hoja y fila XLS | Períodos | Último índice |
| --- | --- | --- | ---: |
| `ipc_ng_nacional` | Índices IPC Cobertura Nacional, 10 | 2016-12 a 2026-08; 117 | 12276.766 |
| `ipc_ng_gba` | Índices aperturas, 8 | 2016-12 a 2026-08; 117 | 12276.812 |
| `ipc_ng_pampeana` | Índices aperturas, 58 | 2016-12 a 2026-08; 117 | 12223.9951 |
| `ipc_ng_noa` | Índices aperturas, 106 | 2016-12 a 2026-08; 117 | 12397.9365 |
| `ipc_ng_nea` | Índices aperturas, 154 | 2016-12 a 2026-08; 117 | 12404.6845 |
| `ipc_ng_cuyo` | Índices aperturas, 202 | 2016-12 a 2026-08; 117 | 12360.9149 |
| `ipc_ng_patagonia` | Índices aperturas, 250 | 2016-12 a 2026-08; 117 | 12265.2749 |

- Los 819 valores son los de la fila `Nivel general`, no tasas de variación. Cada serie es mensual, continua, sin duplicados, y empieza en 100 en diciembre de 2016. Todas terminan en agosto de 2026.
- La página de INDEC fecha el informe de agosto el 10/09/2026. A partir de los índices nacional de julio (12076.3937) y agosto (12276.766), la variación mensual redondeada a un decimal es 1,7%, igual a la cifra informada en esa página.
- En ambos XLS el encabezado de marzo de 2026 aparece como `2026-03-26`. Se normalizó **solo el día del encabezado** al período mensual `2026-03-01`; no se cambió ningún valor. La nota queda en las fichas.
- Las regiones IPC no son provincias y sus índices no deben sumarse ni promediarse para reconstruir el nacional. Para inflación, calcular variaciones a partir del índice y explicitar el redondeo; no etiquetar el índice como porcentaje.
- INDEC publica una [licencia Creative Commons BY-SA 4.0 en su sitio](https://www.indec.gob.ar/) y su [política de difusión](https://www.indec.gob.ar/ftp/cuadros/publicaciones/politica_difusion_indec.pdf) exige atribución. Antes de redistribuir una base comercial, una persona debe revisar la aplicación concreta de la licencia y preparar el texto de atribución; esta auditoría no es un dictamen legal.

## TOP Córdoba: una serie

Fuente: [TOP mensual de la Dirección Nacional de Asuntos Provinciales](https://www.argentina.gob.ar/economia/sechacienda/asuntosprovinciales/direccion-de-recursos-provinciales/recursos-tributarios-de-origen-provincial-top), hoja `TOTAL`, fila `Córdoba`, **millones de pesos corrientes**.

| Archivo | Fila | Meses incorporados | Total de los meses incorporados | `Última actualización` en el libro |
| --- | ---: | --- | ---: | --- |
| `top_mensual_2024_0.xlsx` | 10 | enero-diciembre 2024 | 2211074.760977 | 2025-08-19 |
| `top_mensual_2025_12.xlsx` | 11 | enero-diciembre 2025 | 3572137.30715372 | 2026-09-14 |
| `top_mensual_2026_18.xlsx` | 11 | enero-agosto 2026 | 2973211.471516 | 2026-10-02 |

- Los 32 valores coinciden exactamente con las celdas de Córdoba. Los totales anuales del archivo concuerdan con la suma de los meses incluidos, dentro de la precisión del XLSX. El último valor es agosto de 2026: 356934.642474 millones de ARS.
- Septiembre-diciembre de 2026 aparecen como ceros terminales en ese libro, pero aún no son meses informados: se excluyen. No se convierten en recaudación cero. La fila cambia de 10 a 11 según el año; `source_row` global queda nulo y cada original conserva su fila propia.
- La hoja `Fuente-Metodología` y la página TOP dicen que el conjunto mensual replica informes de los organismos provinciales, **puede incluir recursos no tributarios**, puede rectificarse y no tiene el mismo universo que los informes trimestrales o anuales. No empalmar esas series ni comparar provincias sin revisar sus potestades tributarias.
- El portal identifica como origen de Córdoba su [sitio provincial de ingresos tributarios](https://economiaygestionpublica.cba.gov.ar/publicacion/ingresos-tributarios/). La página provincial ofrece informes hasta agosto de 2026, pero la descarga de su XLSX histórico devolvió HTTP 403 durante esta revisión. **No se verificaron los 32 valores contra el archivo primario de Córdoba**, solo contra la copia oficial TOP. No atribuir al gobierno provincial una fecha o precisión distinta de la que figura en TOP.
- Los [términos generales de Argentina.gob.ar](https://www.argentina.gob.ar/terminos-y-condiciones) indican CC BY 4.0 para contenidos del portal salvo excepción. Antes de redistribuir los originales o vender una base, corresponde confirmar que no haya condiciones específicas del conjunto ni restricciones del productor provincial y citar tanto al productor como al distribuidor.

## Procedencia y fechas

| Archivo | SHA-256 |
| --- | --- |
| `sh_ipc_09_26.xls` | `f57bf8516dd7e88c733d20d39941590e160f3825a4fe8f660fc6cd3d1c79197c` |
| `sh_ipc_aperturas.xls` | `57870411c5f3ede32532c634cfd8258e58e222a03d5e3925189ff79542030eac` |
| `top_mensual_2024_0.xlsx` | `a97a5bf2dea2aa0b1d842c9f167b46515ccaad3d7563b77c972f1013aa9faa88` |
| `top_mensual_2025_12.xlsx` | `35a5488012267388a2c71255504b9cd93ae93970e1b3fb6173bb81b7abdfbe86` |
| `top_mensual_2026_18.xlsx` | `0ce607ffaa35de8bc87d3d414c3d5c83c6015c72e03af6f77768c0d91ae1ef2e` |

El `Last-Modified` HTTP de los manifiestos es metadato del servidor, **no** fecha oficial de publicación. `Última actualización` en TOP es una fecha declarada dentro del archivo, distinta de `Last-Modified` y de la fecha de captura. La página de INDEC sí da 10/09/2026 como fecha del informe de agosto, pero no su hora exacta: `published_at` permanece nulo en la instantánea hasta representar una fecha oficial con precisión de día. Para los XLS del IPC, `retrieved_at` del piloto procede del tiempo de modificación del archivo local y no es una prueba independiente de la descarga; el colector definitivo debe registrar la captura en el momento de obtener cada original.

## Cambios y controles resultantes

1. La fila global de TOP dejó de afirmar incorrectamente `11` para 2024; las filas 10/11/11 están en `originals` por archivo.
2. El `release_id` ahora incorpora los valores y metadatos extraídos, además de los hashes de los archivos y el catálogo. Cambió de `economia-piloto-688837c87d24` a `economia-piloto-ab569b5998c1`; ninguna cifra cambió.
3. `tests/test_auditoria_piloto.py` compara las 851 observaciones contra las celdas originales y comprueba que un valor alterado cambia el identificador. La suite completa tiene 12 pruebas.

Reproducir sin red ni credenciales:

```bash
.venv/bin/python scripts/preparar_piloto.py
.venv/bin/python -m unittest discover -s tests -v
```

El siguiente paso operativo es cargar los originales y el candidato en Supabase, revisar los pendientes legales/metodológicos y registrar una decisión humana explícita antes de exponerlo como aprobado.
