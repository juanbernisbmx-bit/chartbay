# IPC de INDEC: recolección, validación y promoción manual

El recolector genera candidatas locales de nivel general nacional y seis regiones,
base diciembre de 2016 = 100. No publica en Supabase, no copia a ChartBay y no ejecuta
tareas programadas. Recolectar o validar nunca modifica `datos/piloto/catalogo.json`,
los manifiestos vigentes ni los originales anteriores.

## Recolectar

Desde la raíz, con las dependencias de `requirements.txt` instaladas:

```bash
.venv/bin/python scripts/recolectar_ipc.py
```

El comando devuelve JSON con `manifest`, `status`, `errors` y `publica: false`.
Copiar la ruta **exacta** de `manifest` para los pasos siguientes; no usar un glob
que pueda seleccionar varias candidatas. Código de salida 0 significa candidata
técnicamente válida, pendiente de revisión humana; 1 significa rechazo o error.

Descubre los enlaces XLS en la [página oficial del IPC](https://www.indec.gob.ar/Nivel4/Tema/3/5/31).
Exige un único enlace nacional `sh_ipc_MM_AA.xls` y el regional
`sh_ipc_aperturas.xls`. Los enlaces repetidos al mismo archivo se deduplican;
varios nacionales distintos requieren revisión del descubrimiento. No adivina URLs,
no busca un archivo anterior si falla el actual ni deduce cobertura del nombre.
Limita cada respuesta a 15 MB y cada solicitud a 30 segundos. Rechaza redirecciones
fuera de HTTPS y del host oficial antes de contactar el destino.

Por defecto guarda en `datos/originales/ipc/`:

- `ipc_<sha256>.xls`: bytes originales, sin reescribir libros ni redondear cifras.
- `ipc_pagina_<sha256>.html`: página utilizada para descubrir los enlaces.
- `ipc_base_<sha256>.json`: copia exacta del piloto contra el cual se compara.
- `ipc_candidato_<fechaUTC>_<id>.json`: manifiesto exclusivo por corrida con
  intentos, errores, metadatos, extracción por serie y comparación histórica.

Un contenido repetido reutiliza el original, pero cada corrida registra su propia
captura. Un hash existente cuyos bytes fueron alterados provoca rechazo y nunca
se sobrescribe. Los objetos y manifiestos se escriben con publicación atómica sin
reemplazo. Se conservan también los originales recibidos antes de un rechazo por
formato, fechas, cobertura o error posterior de red. Un proceso terminado por el
sistema puede dejar objetos sin manifiesto; no deben interpretarse como candidatas.

`--raw-dir RUTA` cambia la carpeta de salida; `--baseline RUTA` permite una base
de comparación explícita con las siete series IPC. Para promoción al piloto,
recolectar contra el piloto vigente y conservar la candidata dentro de
`datos/originales/`, porque el contrato de procedencia usa rutas relativas a esa
carpeta. Una corrida en otra carpeta sirve para ensayos y validación aislada.

## Fechas y procedencia

Cada descarga conserva URL solicitada (`requested_url`), URL final (`url`), tamaño,
SHA-256, estado HTTP y tipo de contenido. La extracción registra hoja, fila (desde
1), archivo y notas de normalización. Las fechas tienen significados separados:

| Campo | Significado |
| --- | --- |
| `observations[].date` | Mes medido, representado por su primer día |
| `published_at` | Publicación oficial del XLS; queda nulo en esta versión |
| `http_last_modified_raw` / `http_last_modified_at` | `Last-Modified` recibido y convertido a UTC |
| `http_date_raw` / `http_date_at` | `Date` de la respuesta y su conversión a UTC |
| `retrieved_at` | Captura UTC al terminar de leer la respuesta, nunca el mtime local |
| `started_at` / `finished_at` | Inicio y fin de corrida o intento |

La fecha del informe en la página no prueba la publicación de esos bytes XLS.
No se convierte `Last-Modified` ni el mes del nombre en fecha oficial. Si falta
un encabezado HTTP, se guarda nulo. Si está presente pero es inválido, carece de
zona o es posterior a la captura, se rechaza. El validador coteja el encabezado
original con su fecha normalizada. Para registrar una publicación oficial futura
hará falta representar su precisión y conservar evidencia vinculada al archivo;
editar `published_at` a mano no está admitido por el esquema v1.

## Validar y revisar

Reemplazar `RUTA_CANDIDATA` por la ruta devuelta por el recolector:

```bash
.venv/bin/python scripts/recolectar_ipc.py --check-candidate RUTA_CANDIDATA
.venv/bin/python scripts/preparar_piloto.py --check-ipc-candidate RUTA_CANDIDATA
.venv/bin/python -m unittest discover -s tests -v
```

Ambos comandos de validación son offline y no escriben archivos. El primero
reverifica hashes, tamaños, rutas, fechas, roles, extracción y comparación. El
segundo construye además el catálogo completo con TOP sin guardarlo. Una candidata
rechazada nunca se puede promover cambiando solo su estado: se repiten los controles
y se coteja la extracción y comparación con lo guardado en el manifiesto.

Los controles exigen una sola fila por región y de nivel general, rótulo y valor
de base, valores numéricos finitos positivos, meses ordenados y continuos, sin
duplicados ni valores sin encabezado. Los siete calendarios completos deben
coincidir. No se truncan series para igualarlas. Los días distintos de 1 se
normalizan al mes con una nota, como el encabezado real `2026-03-26`.

Revisar el manifiesto y cotejar celdas con los XLS:

1. `comparison.additions`: meses nuevos respecto de la base conservada.
2. `comparison.revisions`: serie, mes, valor previo y valor candidato. Se compara
   el valor completo, sin tolerancia ni redondeo; cambiar el hash sin cambiar
   cifras no genera una revisión numérica. La fecha de detección es la corrida,
   no una fecha de revisión atribuida a INDEC.
3. `comparison.removals`: meses desaparecidos. Cualquiera provoca rechazo incluso
   si los siete calendarios retrocedieron juntos.
4. Cobertura, notas, originales y fechas. Verificar revisiones históricas, cambios
   de formato/metodología y condiciones de reutilización antes de aprobar.

Una candidata con revisiones puede ser técnicamente válida; **no queda aprobada**.
Una desalineación o pérdida histórica requiere una nueva corrida una vez resuelta
la causa, manteniendo el manifiesto rechazado. La detección cubre revisiones frente
al piloto elegido, no versiones anteriores al inicio de la conservación ni cambios
intermedios que hayan sido revertidos entre capturas.

## Promover manualmente al piloto local

Este paso es una decisión humana posterior; **no se ejecuta al recolectar**.
Registrar junto a la candidata la persona revisora, fecha, SHA-256 del manifiesto,
identificador y hash de la base, decisión y justificación de cada revisión.
Después de revisar y validar, ejecutar explícitamente:

```bash
.venv/bin/python scripts/preparar_piloto.py --promote-ipc-candidate RUTA_CANDIDATA
```

El comando vuelve a validar contra el piloto actual. Si cambió desde la captura,
se detiene: recolectar y revisar otra candidata contra esa nueva base. Construye
el catálogo completo, respalda los bytes anteriores como
`datos/piloto/respaldos/catalogo_<sha256>.json` y reemplaza atómicamente
`datos/piloto/catalogo.json`. Conserva TOP y los originales anteriores. No modifica
`INPUTS`, `manifiesto.json` ni el código del piloto para apuntar a nuevas descargas.

Para copiar también a ChartBay en la misma promoción aprobada, agregar
`--chartbay /ruta/a/chartbay`. Las dos copias son atómicas por archivo, no una
transacción entre repositorios: ante un fallo de la segunda copia, el piloto
local puede estar actualizado y ChartBay no. Conservar ambos respaldos antes de
usar esa opción. La validación `--check-*` rechaza `--chartbay`.

**No ejecutar `preparar_piloto.py` sin opciones después de una promoción esperando
reproducirla**: el modo histórico continúa leyendo los originales fijos del piloto
inicial y reconstruye esa instantánea. Es intencional mantener ese comportamiento
para reproducir la auditoría original. La instantánea promovida y la candidata
conservada son los artefactos de la promoción. El cargador Supabase actual también
exige igualdad con la construcción histórica: este cambio no lo adapta para subir
nuevas candidatas IPC ni ejecuta funciones de publicación.

Para revertir una promoción local, verificar el hash del respaldo elegido, copiarlo
a `datos/piloto/catalogo.json.tmp` y reemplazar `catalogo.json` con `mv` en ese mismo
directorio. Si se copió a ChartBay, restaurar también su copia previamente guardada.
No borrar candidatas, originales ni informes de revisión para hacer una reversión.

## Pruebas

`tests/test_ipc_candidate.py` usa HTML sintético, expectativas de celdas fijadas en
JSON y los tres XLS históricos conservados como fixtures binarios. Simula descargas,
fallos HTTP, archivos corruptos, cambios de formato y revisiones. Incluye una
promoción real en una copia temporal del repositorio con respaldo y conservación
de TOP. Ver [detalle de fixtures](../tests/fixtures/ipc/README.md).
