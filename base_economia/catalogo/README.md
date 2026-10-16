# Catálogo inicial de 100 series

Actualización del 15 de octubre de 2026: este inventario conserva las 100 propuestas
originales. La [base masiva importada](../datos/base/README.md) tiene un catálogo
independiente generado desde las fuentes, que no está limitado a esas propuestas.
La [ampliación TOP](../datos/importadas/README.md) está copiada al catálogo local de
ChartBay. El piloto auditado de ocho series permanece como referencia histórica.

Consulta documental: 5 de octubre de 2026.

Este es el inventario de series propuestas para la primera base. El CSV se actualizó para precisar la unidad y definición de TOP Córdoba; el Excel conserva la versión inicial y todavía no está sincronizado. El [piloto separado](../datos/README.md) tiene 7 series IPC y una provincial, con 851 observaciones reales para probar ChartBay. El esquema PostgreSQL existe en Supabase, pero esas observaciones aún no están cargadas allí.

## Archivos

- `series.csv`: 100 filas, una por serie propuesta.
- `fuentes.csv`: 23 entradas de fuente o conjunto, con productor y distribuidor separados.
- La versión Excel en `outputs/01a0fe5e-a5e3-7711-b27a-f096a2219b1c/catalogo_100_series.xlsx` contiene el mismo inventario en dos hojas con filtros.

Los CSV son UTF-8, separados por coma y con campos entre comillas. Son la versión de trabajo para revisar en VS Code. El Excel es una copia de revisión de esta versión; todavía no existe sincronización automática entre ambos formatos.

## Selección

| Grupo | Series |
| --- | ---: |
| IPC nacional y seis regiones | 7 |
| Variables monetarias y cambiarias BCRA | 8 |
| PIB y componentes de oferta y demanda | 7 |
| EMAE, IPI manufacturero e ISAC | 3 |
| Comercio exterior nacional de bienes | 2 |
| Recaudación y resultados fiscales nacionales | 5 |
| Deuda de la Administración Central | 1 |
| Producción de petróleo y gas, por confirmar | 2 |
| Producción agrícola por campaña | 3 |
| Empleo registrado privado: 24 jurisdicciones | 24 |
| Recaudación mensual de origen provincial: 24 jurisdicciones | 24 |
| Exportaciones: cinco regiones OPEX | 5 |
| Producto geográfico: Buenos Aires, CABA y Córdoba | 3 |
| UTDT, FIEL, CAME, IERIC y BCR | 6 |
| **Total** | **100** |

La cobertura propuesta es de 37 series nacionales, 51 provinciales y 12 regionales. "Provincial" incluye CABA. Las 6 series privadas o académicas son parte de esas 100, no una suma adicional.

Un indicador para un territorio determinado cuenta como una serie. Por eso 24 series de empleo no equivalen a 24 indicadores diferentes. Una descarga puede contener muchas series; no se necesitan necesariamente 100 recolectores.

## Lectura de los estados

| Identificación documental | Cantidad | Significado |
| --- | ---: | --- |
| Serie identificada | 42 | El indicador se identifica en una publicación o catálogo del productor. No confirma acceso automático, histórico completo ni derechos de redistribución. |
| Conjunto identificado | 55 | Se localizó una familia de datos. Falta comprobar en sus archivos la serie exacta, el total territorial, la escala y la cobertura. |
| Por confirmar | 3 | Candidatos de producción de petróleo, producción de gas y PBG de Córdoba. Hay que localizar o comprobar la distribución adecuada. |

Las 100 entradas del inventario mantienen el estado `Sin recolectar` como marca histórica del catálogo; la disponibilidad del piloto se registra por separado en `datos/piloto/catalogo.json`: 8 cargadas y 92 pendientes. No hay entradas aprobadas para investigación ni para entrega comercial.

## Campos de cada serie

| Campo | Uso |
| --- | --- |
| `serie_id` | Identificador interno estable y único; no es el código de la API del productor. |
| `nombre`, `tema` | Descripción y familia económica. |
| `nivel`, `territorio`, `clasificacion_geografica` | Cobertura medida y regionalización utilizada. No reemplazan los códigos oficiales, todavía pendientes de mapear. |
| `frecuencia` | Período estadístico propuesto; no es la frecuencia de descarga ni el calendario de publicación. |
| `unidad`, `base_o_ajuste` | Unidad, escala, año base, valoración y ajuste elegido. Los pendientes están escritos, no inferidos. |
| `fuente_id` | Enlace a una entrada de `fuentes.csv`. En esta fase puede representar un conjunto, no solo un organismo. |
| `url_publicacion`, `referencia_origen` | Evidencia y ubicación conceptual de la serie. Los enlaces no son endpoints listos para recolectar. |
| `identificacion`, `pendientes` | Alcance de la comprobación documental y lo que falta resolver. |
| `redistribucion` | Revisión de condiciones de reutilización. La licencia CC BY 4.0 de PBA se identificó en su catálogo; las demás condiciones quedan pendientes. |
| `etapa_propuesta` | Inicial, Ampliación o Privadas; es orden de trabajo, no una calificación de calidad. |
| `estado` | Estado del inventario inicial; consultar la instantánea del piloto para disponibilidad actual. |

No se asignaron inicios o finales históricos: hay que verificarlos sobre cada serie. Un espacio sin datos no se convertirá en cero. Las revisiones se diseñarán después, conservando período de referencia, fecha de publicación cuando exista y fecha de captura.

## Decisiones metodológicas que no debemos perder

- Las regiones IPC, las regiones OPEX y la Región Núcleo de GEA son clasificaciones diferentes, aunque compartan algunos nombres.
- OEDE mide empleo asalariado registrado privado con su asignación territorial, no toda la ocupación de una provincia.
- TOP mensual replica información de los organismos recaudadores y puede tener un universo distinto de TOP trimestral o anual. La fuente advierte que no necesariamente coinciden. No empalmar esas versiones por conveniencia.
- El PIB incluye bienes y servicios. ICA y OPEX se refieren a bienes. Las importaciones ICA se valoran CIF, las de cuentas nacionales aquí elegidas se presentan FOB.
- El resultado fiscal base caja del SPN no equivale a ejecución presupuestaria de la Administración Nacional. Registrar exclusiones y cambios de metodología antes de empalmar años.
- Las campañas agrícolas no son años calendario. Los informes semanales pueden revisar la estimación de una misma campaña sin generar una campaña nueva.
- El recurso PBG PBA a precios de 2004 muestra una etiqueta de metadatos que dice precios corrientes. Hay que comprobar el encabezado y la escala del archivo antes de cargarlo.
- El catálogo de Córdoba no pudo comprobarse en esta consulta. Su PBG queda como candidato, con base, unidad y frecuencia explícitamente pendientes.

## Relación con el inventario anterior

La selección usa el inventario de [FUENTES.md](../FUENTES.md) y agrega EMAE, IPI, ISAC y comercio de bienes dentro de INDEC. No pretende incorporar una serie de cada portal a cualquier costo.

Datos Argentina, API-INDEC y Georef son herramientas de descubrimiento, acceso o normalización, no series económicas que debamos contar nuevamente. Presupuesto Abierto, Mapa Fiscal, otras estadísticas de ONP, EPH, Mendoza, Santa Fe y el resto de las fuentes provinciales siguen pendientes de ampliación. Tampoco hay series de remuneraciones o empresas en estas primeras 100.

Las fuentes privadas se incluyen en el diseño sin recolectar ni redistribuir sus cifras. Incorporarlas al producto requiere comprobar su acceso y las condiciones de uso correspondientes.

## Próxima etapa

1. Revisar esta selección y confirmar qué series son prioritarias para la facultad.
2. Resolver los tres candidatos y comprobar los totales territoriales de OEDE; TOP Córdoba ya tiene una muestra real validada automáticamente.
3. Completar la revisión humana del IPC y TOP Córdoba, incluidas metodología, fecha oficial de publicación y condiciones de reutilización.
4. Integrar los originales y observaciones candidatos en el esquema privado `economia` de Supabase, sin saltar la aprobación.
5. Mantener la prueba de ChartBay con la instantánea JSON local hasta verificar roles y lectura desde PostgreSQL.

Se mantiene la rama local `codex/base-datos`. No hacer push sin revisión y aprobación del usuario.
