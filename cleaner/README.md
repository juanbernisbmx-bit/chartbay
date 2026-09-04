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
| Core C++ (parser, tipado, limpieza, reporte) | listo, 728 checks en verde |
| CLI nativo `csvclean` | listo |
| Modulo WASM (`web/static/wasm/csvclean.wasm`, 221 KB) | compilado y verificado contra el binario nativo |
| Capa adaptativa TypeScript (perfilado, preflight, worker, UI) | lista, 103 tests en verde |
| Conexión a `quantbay/` | hecha: el Limpiador y el laboratorio corren sobre esto |

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
mal formadas. Traduce a UTF-8 lo que venga en Windows-1252, que es lo que
guarda Excel en castellano. Saltea el preámbulo — título, fecha de emisión, líneas en blanco —
que casi todo export de planilla pone encima del encabezado. Decide si la
primera fila de la tabla es encabezado o datos. Filas con más o menos celdas que
el resto se completan o se recortan, contándolo.

**Tipos**, inferidos sobre una muestra: numérica, fecha, categórica, texto,
vacía.

**Normalización de valores.** Coma o punto decimal, separadores de miles
(`.` `,` espacio, NBSP, apóstrofo), símbolos de moneda y códigos ISO,
porcentajes, negativos contables (`(1.234,56)` y `1234-`), notación científica,
espacios invisibles de Excel, y ~30 marcadores de faltante (`NA`, `n/d`, `-`,
`s/d`, `#N/A`…). Fechas ISO, DD/MM, MM/DD, `AAAA-MM`, trimestres (`2024Q2`) y
meses con nombre en español e inglés.

**Limpieza.** Filas vacías, filas duplicadas, el pie de tabla (la fila de
totales y las notas al pie), columnas vacías, constantes y duplicadas fila por
fila. Unifica las escrituras de una misma categoría: mayúsculas, acentos y
espacios internos. Detecta —y opcionalmente fusiona— las que además se parecen,
que es como se ve una errata.

**Índice temporal.** Reconoce la columna de fechas como índice de una serie:
infiere la frecuencia (diaria, días hábiles, semanal, quincenal, mensual,
trimestral, semestral, anual), cuenta las fechas repetidas y los períodos
faltantes con sus ejemplos, y ordena las filas cuando corresponde. Faltantes: conservar, eliminar fila, cero, media,
mediana o arrastre. Atípicos por IQR, z-score o MAD, con política de marcar,
winsorizar, pasar a faltante o eliminar la fila.

**Reporte.** Perfil por columna (n, faltantes, únicos, min/max/media/sd/cuartiles,
rango de fechas, niveles) y un log donde **cada acción viene con su
justificación en castellano**, en el mismo espíritu que
[`autoRepair.ts`](../quantbay/src/services/autoRepair.ts). Nunca desaparece una
columna sin que el reporte diga por qué.

## Ocho decisiones que vale la pena conocer

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

**El encoding se arregla byte a byte, y no se adivina.** Cada secuencia UTF-8
válida se deja intacta — un archivo ya en UTF-8 sale idéntico al que entró, sin
una copia ni un byte cambiado — y todo byte que no pueda ser UTF-8 se traduce
como Windows-1252. La tabla es Windows-1252 y no ISO-8859-1 porque se separan
justo en `0x80`–`0x9F`, donde Latin-1 pone controles y Windows pone las
comillas tipográficas, los guiones y el euro que Word mete en el texto: `0x92`
es el apóstrofo de *don't*, el byte alto más común de todos.

Lo que **no** hace es arreglar el mojibake ya cometido. `Ã³` es UTF-8 perfectamente
válido, así que se respeta. Adivinar ahí rompería los archivos correctos, que
son la mayoría.

Un archivo en UTF-16 tampoco se adivina: se reconoce el BOM y se dice que el
resultado va a estar mal, en vez de entregar una columna llamada `f\0e\0c\0h\0a`
como si nada.

**Las filas se ordenan por fecha, pero solo cuando la columna de fechas es
inequívocamente el índice**: una sola columna de fechas, sin faltantes y sin
repetidas. Las tres condiciones no son cautela de más. Con fechas repetidas lo
que suele haber es un panel — provincia por mes —, y ordenar solo por fecha
mezcla las unidades y arruina cualquier rezago; con más de una columna de
fechas no se sabe cuál es el índice, y `fecha_alta` es tan fecha como
`fecha_baja`. Fuera de esos casos ordenar es lo correcto, y va **antes de
imputar**: el arrastre de faltantes copia el último valor anterior, y sobre
filas desordenadas "anterior" es el renglón de arriba, que puede ser de seis
meses después.

Cuando no se puede ordenar, se dice. Es la diferencia entre un motor que falla
y uno que devuelve un número: un ADF sobre filas en orden alfabético de
provincia no da error, da un estadístico.

**Los huecos se cuentan por calendario, no por días.** Un trimestre no son 90
días ni un año 365, y contarlos así inventa huecos en febrero y en cada
bisiesto. Las frecuencias de calendario —mensual, trimestral, semestral,
anual— se cuentan en meses; las de días —diaria, hábiles, semanal, quincenal—
en días. Y una serie de días hábiles no es una diaria con huecos: son los
mismos saltos de tres días, pero caen todos en fin de semana, así que se
reconocen por dónde caen y no por su tamaño. Sin esa distinción una serie
financiera reportaría un tercio de sus períodos como faltantes.

**Una categoría escrita de dos formas es una sola, y el nivel que queda es la
escritura más frecuente del archivo.** "Buenos Aires", "buenos aires" y
"BUENOS  AIRES" se comparan por una clave con minúsculas, sin acentos y con los
espacios colapsados, pero esa clave no se muestra nunca: el nivel se lee como lo
escribe el archivo casi siempre. Los empates los rompe el orden de aparición,
que es lo que hace que el resultado no dependa del orden de iteración de un
`unordered_map` — si dependiera, el WASM y el binario nativo darían distinto.

El costo real de no hacerlo no son las mayúsculas: **son las escrituras
repetidas las que inflan el conteo de únicos**, y con eso la columna cruza el
umbral de cardinalidad y se tipa como texto libre. Diez provincias escritas de
dos formas dan veinte valores distintos sobre sesenta filas, y esa columna
—que es la variable categórica más importante del archivo— deja de generar
dummies y no entra a ningún modelo, sin que nada diga por qué.

Es la única parte de la limpieza que **cambia lo que el archivo dice**, así que
cada fusión va al reporte con las dos escrituras a la vista y el diagnóstico
ofrece revertirla.

**Parecerse no es lo mismo que ser equivalente, y por eso eso sí se pregunta.**
"CÓRDOBA" y "Córdoba" son la misma palabra escrita distinto en cualquier
archivo; "Cordova" y "Córdoba" son la misma palabra *casi seguro*, y "Salta" y
"Malta" están a una letra y son dos lugares. Los parecidos se detectan siempre
y se listan con las dos escrituras y sus frecuencias, pero fusionarlos es una
decisión del usuario — `--fuzzy-categories`, o un botón en el diagnóstico.

Cuando se piden, la apuesta se acota con tres guardas: claves de menos de cinco
caracteres no se comparan nunca (`AR` y `BR` están a una edición y son dos
países); se admite una edición, o dos si la clave tiene ocho caracteres o más;
y la rara tiene que ser **como mucho la décima parte** de la frecuente, porque
dos escrituras igual de comunes no son una errata y su dueña sino dos
categorías. La distancia es Damerau-Levenshtein, no Levenshtein: el error de
tipeo más común es cambiar dos letras de lugar —"Buenos Aries"— y para
Levenshtein eso son dos ediciones, lo mismo que dos errores independientes.
Tampoco se encadena: que A se parezca a B y B a C no hace que A y C sean lo
mismo. `ñ` pliega a `n`: quien escribe sin teclado en castellano
pone "Nunez" donde el resto del archivo dice "Nuñez", y eso pasa mucho más
seguido de lo que "año" y "ano" son dos categorías distintas — pero si lo son,
la fusión se ve en el reporte.

**El preámbulo solo se saltea si abajo hay un encabezado.** Un título encima de
una tabla y el nombre de una variable encima de una columna sola tienen
exactamente la misma forma: una fila angosta sobre filas anchas. Por eso no
alcanza con ver que las filas de abajo son consistentes — hace falta evidencia
positiva de que la primera de ellas es una fila de nombres. Sin ese requisito,
`tasa / 12,5 / 3,25` se leería como dos columnas separadas por coma, con "tasa"
de título.

**Una fila de totales es un dato de otra escala, no un dato de más.** En un
archivo de cien filas de ~1500, la fila `TOTAL` lleva la media de 1537 a 3068 y
el desvío de 290 a 15296, y siendo una sola fila no hay nada en el perfil que lo
delate salvo el máximo. Se reconoce por la etiqueta, por la aritmética — el
valor es exactamente la suma de lo que tiene encima, que no depende del idioma
ni de que haya etiqueta — o por la forma, cuando es una nota suelta al pie. Se
mira solo la ventana de las últimas tres filas y se frena en la primera que no
lo parece, así que una observación legítima llamada "Total" solo se pierde si
además está al final del archivo. El motivo siempre queda escrito en el reporte,
y `--keep-footer-rows` la devuelve.

Las dos cosas pasan **antes de que se voten los tipos**, no después. En un
archivo chico la fila `TOTAL` no solo mueve la media: baja a 5/6 = 0,83 la
proporción de celdas que parsean como fecha, por debajo del umbral de 0,9, y la
columna de fechas entera terminaba tipada como texto por culpa del pie.

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

## Compilar el módulo WASM

Tocar `src/`, `include/` o `wasm/` obliga a rehacer el módulo del navegador, y
eso necesita [emsdk](https://emscripten.org/docs/getting_started/downloads.html):

```bash
git clone https://github.com/emscripten-core/emsdk && cd emsdk
./emsdk install 3.1.74 && ./emsdk activate 3.1.74 && source ./emsdk_env.sh
cd ../cleaner && make wasm && make wasm-test
```

**Por que 3.1.74 y no `latest`:** las versiones actuales de emsdk exigen Python
3.10 o superior, y macOS trae 3.9.6 con las Command Line Tools. La 3.1.74 es la
ultima que corre sobre 3.9, trae su propio Node y compila todo esto sin
problemas. Si instalas un Python mas nuevo, `latest` deberia andar igual.

Eso deja `web/static/wasm/csvclean.{js,wasm}`. Igual que `quantbay.bundle.js`,
**hay que commitearlos**: el runtime Python de Render no tiene Node ni
Emscripten, así que nada se compila en el deploy.

Lo que decide si el módulo sirve es `make wasm-test`, no que haya compilado.
Corre el compilado bajo Node y exige que su reporte sea **idéntico byte a byte**
al del binario nativo, sobre un fixture que trae a propósito preámbulo, pie de
tabla, un byte de Windows-1252, escrituras repetidas de una categoría, comillas
mal formadas y una columna vacía.

## Cómo está conectado

- `csvclean.js` se carga desde `web/templates/quantbay.html` y desde
  `web/templates/limpiador.html`.
- `js/csvclean.ts` se quedó acá: los bundles de quantbay lo importan desde
  `cleaner/js/` y no hizo falta moverlo.
- El laboratorio entra por
  [`services/cleanerLoader.ts`](../quantbay/src/services/cleanerLoader.ts), que
  elige el camino WASM y **cae a PapaParse** cuando algo falla. El respaldo no
  es decoración: el módulo hay que bajarlo, y el camino de PapaParse venía
  sosteniendo la app desde mucho antes que esto existiera.
- `getValidRowsFrom()` lee los arrays tipados cuando el dataset viene del
  limpiador, y sólo reconstruye objetos por fila cuando viene de PapaParse. Ahí
  está la ganancia real, porque evita la representación que este módulo existe
  para no tener que armar.
- `report.actions` se muestra en el log del laboratorio y, completo, en la
  sección "Qué se hizo" del Limpiador. Ya viene redactado en castellano y con
  el motivo de cada cosa.
- El Limpiador es su propia página y su propio bundle
  ([`cleaner.entry.ts`](../quantbay/src/cleaner.entry.ts)): no arrastra los 375
  kB del motor econométrico para limpiar un archivo.

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
- **El preámbulo se detecta hasta 20 filas y solo si debajo hay un encabezado.**
  Un preámbulo encima de una tabla sin encabezado no se reconoce: preferir no
  adivinar antes que comerse una fila de datos. `--skip N` lo fija a mano, y
  cuenta filas del parser — las líneas en blanco no son filas.
- **El pie de tabla se busca en las últimas tres filas** y con las columnas
  materializadas. En modo escaneo sobre un archivo más grande que la muestra no
  hay contra qué comparar la suma, así que ahí solo se reconoce por la etiqueta.
- **El índice temporal necesita una única columna de fechas.** Con dos o más no
  se elige ninguna: se informa la ambigüedad y no se ordena nada. Tampoco se
  analiza un rango que supere los cuatro millones de períodos, que es lo que
  pasa cuando una fecha trae el año mal tipeado.
- **Los parecidos se buscan hasta 200 niveles.** La comparación es de todos
  contra todos, y una columna con cientos de niveles no es una categórica que
  alguien vaya a mirar a ojo.
- **La unificación de categorías cubre Latin-1 y Windows-1252**, que es todo el
  castellano, portugués, francés, italiano y alemán. Un alfabeto que caiga
  afuera pasa tal cual y no se unifica: es preferible no unificar a unificar
  mal.
- **UTF-8 y Windows-1252.** Cualquier otro encoding pasa los bytes tal cual. De
  UTF-16 se reconoce el BOM y se avisa, pero no se convierte.
- **Sin paralelismo.** Un solo hilo. Partir el archivo por bloques y usar
  workers es posible, pero complica la inferencia de tipos, que es global.
