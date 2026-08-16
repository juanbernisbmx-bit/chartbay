# cleaner — limpiador de CSV en C++

Motor de limpieza y tipado de CSV, sin dependencias, pensado para compilarse a
WebAssembly y correr **dentro del navegador** de ChartBay. Mismo criterio que el
resto del proyecto: los datos no salen de la máquina del usuario.

Entra un CSV sucio, salen **columnas tipadas** (`Float64Array`, `Int32Array`) más
un reporte de todo lo que se tocó y por qué.

## Por qué existe

El camino actual ([`quantbay/src/csvParser.ts`](../quantbay/src/csvParser.ts))
usa PapaParse con `header: true`, que devuelve **un objeto JavaScript por fila**
con claves string. Para 2 millones de filas y 7 columnas eso son 14 millones de
propiedades: varios GB de heap y la pestaña se muere mucho antes de que el motor
econométrico vea un número.

Acá una columna numérica de *n* filas ocupa exactamente 8*n* bytes contiguos, y
la representación es la que el motor quiere de todos modos para armar X e y.

El segundo motivo es de correctitud. `Number("1.234")` en JavaScript da `1.234`,
pero en un CSV argentino ese valor es *mil doscientos treinta y cuatro*. La
convención decimal no es una propiedad de la celda, es de la columna — y a veces
ni siquiera de la columna (ver más abajo).

## Estado

| Pieza | Estado |
|---|---|
| Core C++ (parser, tipado, limpieza, reporte) | listo, 435 checks en verde |
| CLI nativo `csvclean` | listo |
| Modulo WASM (`web/static/wasm/csvclean.wasm`, 160 KB) | compilado y verificado contra el binario nativo |
| Capa adaptativa TypeScript (perfilado, preflight, worker, UI) | lista, 45 tests en verde |
| Conexión a `quantbay/` | **pendiente** |

`make wasm-test` corre el modulo compilado bajo Node y exige que su reporte sea
**identico byte a byte** al del binario nativo. Compilar no prueba nada por si
solo; esto si.

## Correr

```bash
cd cleaner && make && make test
```

```bash
./build/csvclean datos.csv --out limpio.csv --report reporte.json
```

`csvclean --help` lista las opciones. Sin `--out` escribe a stdout, y el resumen
legible siempre va a stderr, así que se puede pipear.

## Qué hace

**Parseo.** Detecta el separador (`,` `;` tab `|`), comillas, BOM, CRLF, saltos
de línea dentro de campos entrecomillados, `""` escapadas y comillas sueltas
mal formadas. Decide si la primera fila es encabezado o datos. Filas con más o
menos celdas que el resto se completan o se recortan, contándolo.

**Tipos**, inferidos sobre una muestra: numérica, fecha, categórica, texto,
vacía.

**Normalización de valores.** Coma o punto decimal, separadores de miles
(`.` `,` espacio, NBSP, apóstrofo), símbolos de moneda y códigos ISO,
porcentajes, negativos contables (`(1.234,56)` y `1234-`), notación científica,
espacios invisibles de Excel, y ~30 marcadores de faltante (`NA`, `n/d`, `-`,
`s/d`, `#N/A`…). Fechas ISO, DD/MM, MM/DD, `AAAA-MM`, trimestres (`2024Q2`) y
meses con nombre en español e inglés.

**Limpieza.** Filas vacías, filas duplicadas, columnas vacías, constantes y
duplicadas fila por fila. Faltantes: conservar, eliminar fila, cero, media,
mediana o arrastre. Atípicos por IQR, z-score o MAD, con política de marcar,
winsorizar, pasar a faltante o eliminar la fila.

**Reporte.** Perfil por columna (n, faltantes, únicos, min/max/media/sd/cuartiles,
rango de fechas, niveles) y un log donde **cada acción viene con su
justificación en castellano**, en el mismo espíritu que
[`autoRepair.ts`](../quantbay/src/services/autoRepair.ts). Nunca desaparece una
columna sin que el reporte diga por qué.

## Tres decisiones que vale la pena conocer

**El separador decimal se vota por columna, no por celda.** Se recorre la
muestra juntando evidencia: un valor con punto *y* coma delata cuál es cuál; un
separador repetido (`1.234.567`) solo puede ser de miles; `1,5` solo puede ser
decimal.

**Cuando la columna no alcanza, decide el archivo.** Una columna entera de
`45.000`, `1.500`, `2.000` es genuinamente ambigua: todos los valores son
compatibles con las dos lecturas. En ese caso hereda la convención que votó el
resto del archivo, y el reporte lo dice explícitamente. Es la diferencia entre
leer `$ 45.000` como 45 mil o como 45.

**Un separador de miles inválido invalida el número.** Con la columna en punto
decimal, `1,5` se rechaza y queda como faltante, en vez de tirar la coma y
devolver `15`. Un faltante señalado es recuperable; un valor multiplicado por
diez en silencio, no.

## Rendimiento

Archivos generados con `tools/gen_csv.py`: 7 columnas, punto y coma, decimales
con coma, moneda, porcentajes, fechas DD/MM/AAAA, faltantes variados y filas
duplicadas. En un M-series:

| Entrada | Filas | Nativo | WASM | Memoria nativa | Heap WASM |
|---|---|---|---|---|---|
| 129 MB | 2 M | 2,2 s | 4,2 s | 159 MB | 180 MB |
| 516 MB | 8 M | 9,1 s | 16,8 s | 617 MB | 727 MB |
| 1,03 GB | 16 M | 18,5 s | — | 1,23 GB | — |

Escala lineal: **58 MB/s nativo, 31 MB/s en WASM** (1,8×, que es la relación
habitual), y pico de memoria ≈ 1,2× la entrada. El CLI tarda otro tanto en
volver a escribir el CSV, cosa que el camino WASM no hace.

Dos cosas costaron la mitad del rendimiento en WASM y no se ven en el codigo:

- **`strtod` de musl usa `long double` internamente.** WASM no tiene ese tipo en
  hardware, asi que se emula en software (`__multf3`, `__addtf3`, `fmodl`):
  **37 % del runtime** en el perfil. `parse_number` ahora resuelve el caso comun
  con una multiplicacion exacta y solo cae a `strtod` cuando el significando o
  la potencia de diez no son representables. De 17 a 31 MB/s.
- **`-ffp-contract=off`.** clang fusiona `a*b + c*d` en un FMA en arm64 y WASM no
  puede; el mismo cuartil daba `58.925000000000004` nativo y `58.925` en el
  navegador. Lo detecto `make wasm-test`.

```bash
make bench
```

### De dónde sale la memoria

El tamaño de chunk no influye: es un buffer fijo de 1–4 MiB. El pico son las
columnas de salida, y se puede calcular por fila:

| Concepto | Bytes por fila |
|---|---|
| Columna numérica o de fecha | 9 (8 del valor + 1 de máscara) |
| Columna categórica | 5 (4 del código + 1 de máscara) |
| Columna de texto | largo promedio + ~32 de overhead de `std::string` |
| Detección de duplicados | ~16 (tabla de hashes) |

Para el archivo de 8 M de filas: 4 × 9 + 2 × 5 + 16 = 62 bytes/fila = 496 MB,
más ~20 % de overhead del allocator y la muestra. Da los 617 MB medidos.

Dos palancas:

- `--keep-duplicate-rows` elimina la tabla de hashes: 617 MB → **493 MB** en el
  archivo de 516 MB.
- **Las columnas de texto de alta cardinalidad son el caso caro** y el único
  donde el consumo se parece al del camino JavaScript. Las categóricas usan
  diccionario y no tienen ese problema.

`CleanOptions::total_bytes` (el CLI lo saca solo del tamaño del archivo, el
wrapper JS de `file.size`) pre-dimensiona los buffers. Sin ese dato las columnas
crecen duplicando capacidad, lo que costaba 900 MB en el archivo de 516 MB en
vez de 617 MB.

## Perfilado del dispositivo y modos de procesamiento

El navegador **no puede informar la RAM libre del sistema**, y nada acá lo
finge. Lo que hay son señales opcionales y toscas — `navigator.deviceMemory`,
`hardwareConcurrency`, `performance.memory.jsHeapSizeLimit` — que se combinan en
un presupuesto conservador, con una etiqueta de confianza que dice cuánto vale.

El aviso que ordena todo el diseño: `navigator.deviceMemory` está definida como
la RAM redondeada hacia abajo a una potencia de dos y **topeada en 8**. Una
workstation de 64 GB y una laptop de 8 GB informan lo mismo. Por eso los tramos
por encima de 8 GB solo se alcanzan con `deviceMemoryOverrideGB`, que es lo que
podría pasar una app de escritorio.

### Cuatro modos, cuatro límites distintos

Un único "tamaño máximo de archivo" sería erróneo en las dos direcciones a la
vez, porque **la memoria la determina el algoritmo, no el tamaño**:

| Modo | Qué guarda | Memoria | Medido sobre 516 MB / 7,9 M filas |
|---|---|---|---|
| Escaneo básico | nada por fila | O(columnas) | **16 MB**, 7,6 s |
| Limpieza estándar | columnas tipadas | O(filas) | 727 MB, 17,2 s |
| Duplicados globales | + tabla de hashes | O(filas) | +128 MB |
| Análisis completo | + orden para cuantiles | O(filas) | +8 B/fila |

El escaneo básico (`scan_only`) no materializa nada: cuenta filas, faltantes,
inválidos y tipos, y lleva momentos por Welford. La memoria WASM **no creció ni
una vez** sobre el archivo de 516 MB — se quedó en los 16 MB iniciales. Por eso
ese modo no tiene límite de tamaño derivado de memoria, y el sistema no le
inventa uno.

### Archivos

```
js/processingLimits.ts    todas las constantes, con su procedencia documentada
js/deviceProfiler.ts      detección de señales + cálculo del presupuesto
js/preflight.ts           estimación de filas y recomendación por modo
js/telemetry.ts           métricas locales y monitor de memoria en vivo
js/csvclean.worker.ts     procesamiento fuera del hilo principal
js/workerClient.ts        API del lado del hilo principal
js/deviceProfileView.ts   panel "Dispositivo y procesamiento"
```

Los tests viven en `quantbay/tests/cleaner/` porque ahí está el vitest del
proyecto:

```bash
npm --prefix quantbay run test
```

## Estructura

```
include/chartbay/   value.hpp    normalización de celdas (números, fechas, faltantes)
                    scanner.hpp  parser CSV push, por chunks
                    table.hpp    inferencia de tipos y limpieza
                    report.hpp   JSON y texto
src/                implementaciones
cli/main.cpp        el binario csvclean
wasm/bindings.cpp   ABI en C para el navegador
js/csvclean.ts      wrapper TypeScript
tests/              harness propio, sin dependencias
tools/gen_csv.py    generador de CSV sucios para el bench
```

El scanner es un **push parser**: se le van pasando bloques de bytes y avisa por
callback fila a fila. Esa forma es la que permite usar el mismo código desde el
CLI (que lee en bloques de 1 MiB) y desde el navegador (que pasa `Blob.slice`),
sin que el archivo entero tenga que estar en memoria. Las filas que caen enteras
dentro de un bloque se entregan como vistas sin copiar; solo se copian las que
cruzan un límite de bloque o traen comillas escapadas.

El test `chunk_boundaries_are_invisible` alimenta la misma entrada en **todos**
los tamaños de bloque posibles y exige un único resultado. Es el test que
sostiene todo lo anterior.

## Integrar en ChartBay

Falta esto, y necesita [emsdk](https://emscripten.org/docs/getting_started/downloads.html):

```bash
git clone https://github.com/emscripten-core/emsdk && cd emsdk
./emsdk install 3.1.74 && ./emsdk activate 3.1.74 && source ./emsdk_env.sh
cd ../cleaner && make wasm && make wasm-test
```

**Por que 3.1.74 y no `latest`:** las versiones actuales de emsdk exigen Python
3.10 o superior, y macOS trae 3.9.6 con las Command Line Tools. La 3.1.74 es la
ultima que corre sobre 3.9, trae su propio Node y compila todo esto sin
problemas. Si instalas un Python mas nuevo, `latest` deberia andar igual.

Eso deja `web/static/wasm/csvclean.{js,wasm}`. Igual que
`quantbay.bundle.js`, **hay que commitearlos**: el runtime Python de Render no
tiene Node ni Emscripten, así que nada se compila en el deploy.

Después:

1. Cargar `csvclean.js` desde `web/templates/quantbay.html`, junto a PapaParse.
2. Mover `js/csvclean.ts` a `quantbay/src/cleaner/` y agregarlo al bundle.
3. En [`main.ts:506`](../quantbay/src/main.ts), reemplazar `parseCSVFile(file)`
   por `cleanCsv(file)`.
4. Usar `extractMatrix()` en lugar de `getValidRows()` para armar X e y; ahí
   está la ganancia real, porque evita reconstruir objetos por fila.
5. Mostrar `report.actions` en el panel de log — ya vienen redactadas en
   castellano y con el motivo.
6. `toRowObjects(table, 100)` solo para la tabla de preview. Tiene límite de
   filas a propósito: reconstruye exactamente la representación que este módulo
   existe para evitar.

Conviene dejar PapaParse como camino de respaldo hasta que el WASM esté probado
en producción.

### Cuánto aguanta el navegador

El límite duro es del formato, no del código: **wasm32 direcciona 4 GB** y no
hay forma de pasarlo sin `-sMEMORY64`, cuyo soporte todavía es parcial. Contra
ese techo, medido sobre el módulo compilado:

| Entrada | Heap WASM | Tiempo | Margen sobre wasm32 |
|---|---|---|---|
| 129 MB | 180 MB (medido) | 4,2 s | — |
| 512 MB | 727 MB (medido) | 16,8 s | holgado |
| 1 GB | ~1,4 GB (proyectado) | ~34 s | cómodo en desktop |
| ~2,8 GB | ~3,9 GB | — | contra la pared |

Hay un detalle que cambia la cuenta: **la memoria WASM solo crece, nunca se
devuelve**. Copiar las columnas a JavaScript no reemplaza los buffers del
módulo, se suma encima — un archivo de 512 MB pasaría de ~620 MB a ~1,1 GB de
pico solo por copiar.

Por eso `cleanCsv` decide sola: copia los resultados chicos (< 64 MB de datos
columnares) y **entrega vistas sobre la memoria WASM** para los grandes. En ese
modo hay que llamar `dispose()` antes de limpiar otro archivo; si no se hace,
`cleanCsv` tira un error explícito en vez de dejar arrays corruptos. Se puede
forzar con `copy: true` o `copy: false`.

En resumen, para el objetivo de 512 MB por navegador hay margen de sobra en
desktop. Lo que conviene verificar en el navegador real, no acá, es el
comportamiento en mobile, donde el presupuesto total de la pestaña es bastante
menor que estos números.

## Límites conocidos

- **Detección de duplicados por hash de 64 bits.** No se guardan las filas para
  comparar, así que dos filas distintas con el mismo hash se contarían como
  duplicadas. Para 10 M de filas la probabilidad es ~3 × 10⁻⁶. La alternativa
  es tener todo el archivo en memoria, que es justo lo que se quiere evitar.
- **Las columnas de texto de alta cardinalidad se guardan como strings.** Son el
  único caso donde el consumo se parece al del camino JavaScript. Las
  categóricas van con diccionario y no tienen ese problema.
- **wasm32 direcciona 4 GB** y la memoria WASM nunca se devuelve al navegador.
  Ver [Cuánto aguanta el navegador](#cuánto-aguanta-el-navegador).
- **Los tipos se infieren sobre una muestra** (5000 filas por defecto). Si el
  primer tramo del archivo no representa al resto, hay que subir `--sample`.
- **Solo UTF-8 y ASCII.** Un CSV en Latin-1 con acentos pasa los bytes tal cual;
  no se detecta ni se convierte el encoding.
- **Sin paralelismo.** Un solo hilo. Partir el archivo por bloques y usar
  workers es posible, pero complica la inferencia de tipos, que es global.
