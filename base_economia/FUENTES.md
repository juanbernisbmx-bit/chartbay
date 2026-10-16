# Catálogo inicial de fuentes económicas de Argentina

**Estado al 15 de octubre de 2026:** se realizó una [importación masiva directa](datos/base/README.md)
de los paquetes globales y por catálogo de Datos Argentina, de los indicadores
provinciales y sectoriales de Economía y de enlaces descargables de las fuentes
inventariadas. El informe distingue series con valores, metadatos sin valores,
originales pendientes de extracción y errores. El agente y la limpieza quedan
para una etapa posterior. El inventario documental que sigue conserva su fecha
original; ya no describe por sí solo el estado de la recolección.

Fecha de consulta documental: 2 de octubre de 2026.

Este documento inicia el inventario de fuentes para una base con cobertura nacional, provincial y regional. El proyecto previsto incluye actualización automática, revisión humana y un frontend de consulta, para su posterior entrega a una facultad.

Se identificaron publicaciones, catálogos y documentación oficial de los productores. Todavía no se descargaron ni validaron las series y no se probaron conexiones automáticas. La existencia de un portal o una API no confirma que todas sus series estén actualizadas ni que todo su contenido admita redistribución comercial.

## Cómo elegir la fuente

1. Registrar el organismo que produce el dato y, por separado, el portal que lo distribuye.
2. Usar catálogos generales para descubrir series y localizar su fuente primaria.
3. Mantener como series distintas las mediciones con diferente fuente, metodología o cobertura.
4. Priorizar API y archivos estructurados. Evaluar páginas y PDF por separado porque requieren más mantenimiento.
5. Registrar el permiso de reutilización de cada conjunto antes de incluirlo en la entrega comercial.

## Puntos de entrada nacionales y con desagregación territorial

La columna Acceso describe lo documentado por el portal. Cada archivo, consulta y endpoint requiere una evaluación posterior.

| ID | Productor o distribuidor y enlace | Información de interés | Cobertura | Acceso identificado |
| --- | --- | --- | --- | --- |
| N01 | [Ministerio de Economía: Economía en números](https://www.argentina.gob.ar/economia/datos) | Catálogo de series agregadas, provinciales y sectoriales; valores, metadatos y fuentes | Nacional y subnacional según conjunto | CSV, XLSX y otros formatos; enlaces a conjuntos |
| N02 | [Datos Argentina: APIs](https://www.datos.gob.ar/apis) | Descubrimiento de conjuntos y consulta de series de distintos organismos | Según conjunto | API de series; API de metadatos CKAN |
| N03 | [Catálogo API-INDEC](https://api.indec.gob.ar/) | Servicios de estadísticas oficiales disponibles en el catálogo | Según servicio | API; cuenta y token. La oferta está en beta |
| N04 | [INDEC: IPC](https://www.indec.gob.ar/indec/web/Nivel4-Tema-3-5-31) | Índices, variaciones, divisiones y precios promedio | Total nacional y seis regiones estadísticas | Series, cuadros, informes y metadatos |
| N05 | [INDEC: agregados macroeconómicos](https://www.indec.gob.ar/Nivel4/Tema/3/9/47) | PIB, valor agregado sectorial, consumo, inversión y componentes de oferta y demanda | Nacional | Cuadros y publicaciones de cuentas nacionales |
| N06 | [INDEC: bases de datos](https://www.indec.gob.ar/Institucional/Indec/BasesDeDatos) | EPH, hogares, personas y documentación para investigaciones sobre trabajo e ingresos | Cobertura específica de cada encuesta | TXT, XLS y documentos metodológicos; geometrías de cobertura EPH |
| N07 | [INDEC: origen provincial de las exportaciones](https://www.indec.gob.ar/indec/web/Nivel4-Tema-3-2-79) | Exportaciones por origen provincial, rubros y regiones | Provincias y regiones económicas | Series históricas, consulta y bases descargables XLS/ZIP |
| N08 | [BCRA: catálogo de APIs](https://www.bcra.gob.ar/apis-banco-central/) | Reservas, tasas, dinero, crédito y estadísticas cambiarias según servicio | Según variable y servicio | APIs documentadas; Estadísticas Monetarias v4.0 como versión vigente indicada en el catálogo |
| N09 | [Oficina Nacional de Presupuesto](https://www.argentina.gob.ar/economia/onp) | Cuenta ahorro-inversión-financiamiento y ejecución; resultado fiscal con su universo contable | Sector público nacional según publicación | Publicaciones y descargas; localizar distribución de cada serie |
| N10 | [Presupuesto Abierto: datos abiertos](https://www.presupuestoabierto.gob.ar/sici/datos-abiertos) | Presupuesto y ejecución de gastos y recursos, con clasificadores y apertura geográfica | Administración nacional según universo presupuestario | Descargas de datos |
| N11 | [Finanzas: datos de deuda pública](https://www.argentina.gob.ar/economia/finanzas/datos) | Stock, composición e instrumentos de deuda | Nacional | [Datos mensuales](https://www.argentina.gob.ar/economia/finanzas/datos-mensuales) y [bases trimestrales](https://www.argentina.gob.ar/economia/finanzas/datos-trimestrales-de-la-deuda) |
| N12 | [Economía: recaudación](https://www.argentina.gob.ar/economia/ingresospublicos/dniaf/recaudacion) | Recaudación nacional por mes y tributo | Nacional | Cuadros, publicaciones y descargas |
| N13 | [Recursos Tributarios de Origen Provincial](https://www.argentina.gob.ar/economia/sechacienda/asuntosprovinciales/direccion-de-recursos-provinciales/recursos-tributarios-de-origen-provincial-top) | Recaudación propia provincial; series mensuales, trimestrales y anuales | Provincias y CABA | Informes; series históricas en Excel y CSV |
| N14 | [Mapa Fiscal provincial](https://www.argentina.gob.ar/economia/sechacienda/coordinacion-fiscal-provincial/mapa-fiscal) | Recursos, gastos y deuda provincial | Provincias y CABA | Portal; identificar datos subyacentes antes de automatizar |
| N15 | [OEDE: estadísticas nacionales](https://www.argentina.gob.ar/trabajo/estadisticas/oede-estadisticas-nacionales) y [regionales](https://www.argentina.gob.ar/trabajo/estadisticas/oede-estadisticas-provinciales) | Empleo registrado, remuneraciones y empresas, con aperturas sectoriales y territoriales | Nacional, provincial, departamentos y áreas económicas locales, según serie | Series descargables y notas metodológicas |
| N16 | [Secretaría de Energía: datos y estadísticas](https://www.argentina.gob.ar/economia/energia/datos-y-estadisticas) | Hidrocarburos, electricidad y balances energéticos | Según conjunto | Portal de datos abiertos, estadísticas y series |
| N17 | [Agricultura: datos abiertos](https://www.argentina.gob.ar/economia/agricultura/datos-abiertos) | Producción, estimaciones agrícolas y variables agropecuarias | Según conjunto | Catálogos, tableros e informes; evaluar distribución por conjunto |
| N18 | [Georef y catálogos geográficos](https://www.datos.gob.ar/apis) | Identificadores y normalización de provincias, departamentos, municipios y localidades | Argentina | API y conjuntos geográficos. Deben vincularse con los códigos utilizados por cada productor |

N01 y N02 pueden redistribuir series de otros organismos. Incorporar una serie desde varios portales debe conservar su identidad y procedencia para evitar duplicarla.

La apertura geográfica del gasto nacional de N10 identifica una distribución del gasto nacional; no equivale al gasto ejecutado por un gobierno provincial.

## Fuentes propias de las jurisdicciones

Las direcciones estadísticas aportan cuentas provinciales, índices locales, anuarios y encuestas propias. Para completar el inventario también deben localizarse los organismos de recaudación y las publicaciones de Hacienda de cada jurisdicción.

| ID | Jurisdicción | Punto de entrada identificado | Qué revisar primero |
| --- | --- | --- | --- |
| P01 | Buenos Aires | [Dirección Provincial de Estadística](https://www.estadistica.ec.gba.gov.ar/) y [PBG, base 2004](https://datos.estadistica.ec.gba.gov.ar/dataset/producto-bruto-geografico) | PBG, actividad y catálogo abierto. El conjunto de PBG indica archivos XLS, frecuencia anual y licencia CC BY 4.0 |
| P02 | CABA | [Anuario IDECBA y acceso al banco de datos](https://www.estadisticaciudad.gob.ar/eyc/anuario-estadistico-idecba-2025/) | Producto geográfico, IPCBA, ocupación, ingresos, construcción, comercio y finanzas públicas |
| P03 | Córdoba | [Catálogo de cuentas provinciales de la DGEC](https://datosestadistica.cba.gov.ar/dataset/?_groups_limit=0&groups=cuentas-provinciales) | Producto y actividad provincial; identificar archivos y metadatos de cada conjunto |
| P04 | Mendoza | [Publicaciones de la DEIE](https://www.mendoza.gov.ar/prensa/la-deie-entrego-datos-estadisticos-a-los-municipios-para-la-toma-de-decisiones/) | Series económicas y departamentales; localizar las distribuciones vigentes. El acceso directo al portal DEIE no pudo verificarse con el navegador de consulta |
| P05 | Santa Fe | [Catálogo de datos abiertos](https://datos.santafe.gov.ar/dataset?tags=censo) y publicaciones de IPEC | La existencia del catálogo está identificada; falta localizar y evaluar las distribuciones económicas actuales |

Estos cinco puntos son un comienzo del relevamiento. La revisión documental de todas las jurisdicciones todavía está pendiente.

| Jurisdicción | Estado del inventario |
| --- | --- |
| Buenos Aires | Punto de entrada y conjunto de PBG identificados; falta auditar series |
| CABA | Publicaciones y acceso al banco de datos identificados; falta auditar series |
| Catamarca | Pendiente |
| Chaco | Pendiente |
| Chubut | Pendiente |
| Córdoba | Catálogo identificado; falta comprobar distribuciones |
| Corrientes | Pendiente |
| Entre Ríos | Pendiente |
| Formosa | Pendiente |
| Jujuy | Pendiente |
| La Pampa | Pendiente |
| La Rioja | Pendiente |
| Mendoza | Publicaciones identificadas; acceso y distribuciones pendientes |
| Misiones | Pendiente |
| Neuquén | Pendiente |
| Río Negro | Pendiente |
| Salta | Pendiente |
| San Juan | Pendiente |
| San Luis | Pendiente |
| Santa Cruz | Pendiente |
| Santa Fe | Catálogo identificado; conjuntos económicos pendientes |
| Santiago del Estero | Pendiente |
| Tierra del Fuego | Pendiente |
| Tucumán | Pendiente |

## Indicadores de entidades privadas, académicas y sectoriales

Las fuentes siguientes publican indicadores que pueden complementar las estadísticas oficiales. Su incorporación comercial queda pendiente de revisar las condiciones del productor y, cuando corresponda, obtener autorización. Una publicación visible en internet no confirma permiso para redistribuirla en el producto.

| ID | Productor y enlace | Información de interés | Acceso a evaluar |
| --- | --- | --- | --- |
| X01 | [UTDT: Centro de Investigación en Finanzas](https://www.utdt.edu/ver_contenido.php?id_contenido=3160&id_item_menu=6230) | Confianza del consumidor, expectativas de inflación e índice líder | Informes, metodología y series históricas; evaluar acceso de cada indicador |
| X02 | [FIEL: estadísticas](https://fiel.org/estadisticas) | Índice de Producción Industrial de FIEL | Publicaciones y disponibilidad de series; condiciones pendientes |
| X03 | [CAME: ventas minoristas y metodología, octubre de 2025](https://www.redcame.org.ar/documentos-online/13711) | Indicador de ventas minoristas pyme | Publicación histórica identificada; localizar la publicación vigente y la serie completa desde el portal del productor |
| X04 | [IERIC: estadísticas](https://www.ieric.org.ar/estadisticas/) | Empleo y empresas de la construcción a nivel nacional y provincial | Series e informes; distinguir estadísticas propias de las republicadas desde INDEC o Trabajo |
| X05 | [Bolsa de Comercio de Rosario: GEA](https://www.bcr.com.ar/es/mercados/gea) | Estimaciones agrícolas y seguimiento de la Región Núcleo | Informes y cuadros; cobertura, metodología y condiciones pendientes |

Las consultoras y proveedores comerciales adicionales deben incorporarse al catálogo cuando se conozcan los indicadores necesarios y el presupuesto para licencias. Este inventario no presume suscripciones ni derechos sobre sus contenidos.

## Tratamiento de las regiones

El modelo geográfico debe permitir varias clasificaciones en paralelo, con fuente, composición y vigencia.

- El [IPC de INDEC](https://www.indec.gob.ar/indec/web/Nivel4-Tema-3-5-31) presenta total nacional y seis regiones estadísticas.
- El [OPEX](https://www.indec.gob.ar/indec/web/Nivel4-Tema-3-2-79) presenta provincias y cinco regiones económicas.
- Las bases EPH distinguen sus dominios y aglomerados; la cobertura debe obtenerse de sus [documentos y geometrías](https://www.indec.gob.ar/Institucional/Indec/BasesDeDatos).
- OEDE publica también áreas económicas locales y series departamentales.
- La [Región Núcleo de GEA](https://www.bcr.com.ar/es/mercados/gea/sobre-gea/sobre-guia-estrategica-para-el-agro) tiene una definición productiva propia.

Un aglomerado no representa automáticamente a toda su provincia. Un total de encuesta debe conservar su población cubierta. Las tasas regionales requieren el método y las ponderaciones correspondientes; la suma o el promedio simple solo se aplicará cuando exista una justificación documentada.

## Ficha que debemos completar para cada conjunto

| Campo | Contenido |
| --- | --- |
| Identificador interno | Código estable del conjunto |
| Productor | Organismo o entidad que elabora el dato |
| Distribuidor | Portal desde el que se descarga |
| URL de publicación y descarga | Enlaces de origen y distribución |
| Series y dimensiones | Indicadores, sectores, categorías y territorios |
| Cobertura temporal | Primera y última observación verificadas |
| Cobertura geográfica | Dominio medido, códigos y definición regional |
| Frecuencia estadística | Diaria, mensual, trimestral, anual u otra |
| Calendario y frecuencia de consulta | Cuándo publica la fuente y cuándo revisará el sistema |
| Unidad y metodología | Moneda, escala, precios corrientes/constantes, año base y ajuste estacional |
| Estado de los valores | Preliminar, provisorio, definitivo o sin especificar |
| Acceso | API, CSV, XLSX, HTML, PDF, autenticación y límites |
| Licencia | Texto o enlace; condiciones de uso comercial, redistribución y cita |
| Revisiones | Cómo detectar cambios y conservar versiones |
| Validación | Reglas aprobadas y responsable de revisión |
| Estado de incorporación | Identificado, acceso probado, validado y aprobado para la entrega |

La descarga debe conservar el archivo original y la fecha de captura. La fecha de publicación solo se registra como tal si la fuente la informa. El historial recolectado comienza cuando se capturan versiones; los datos históricos actuales no prueban qué valor estaba publicado en una fecha pasada.

## Primeros conjuntos propuestos para evaluar

1. IPC de INDEC: total nacional y seis regiones, para probar índices mensuales y definiciones regionales.
2. Un grupo pequeño de variables del BCRA, para probar acceso API y series diarias.
3. Empleo registrado provincial de OEDE, para probar aperturas territoriales y sectoriales.
4. Recaudación provincial mensual de TOP, para probar cobertura y diferencias de calendario entre jurisdicciones.
5. PBG de Buenos Aires, para probar frecuencia anual, unidades y año base.

Estos conjuntos permiten evaluar el modelo en los tres niveles territoriales antes de ampliar el catálogo. La prioridad es una decisión de diseño; su carga y automatización requieren completar las fichas.

## Cobertura pendiente

- Auditar las restantes jurisdicciones y sus series propias.
- Completar familias de INDEC: industria, construcción, comercio interno, salarios, cuentas internacionales, población y turismo, entre otras.
- Revisar transferencias intergubernamentales, deuda provincial y resultados fiscales con sus universos contables.
- Localizar datasets de minería, transporte y otros sectores que solicite la facultad.
- Verificar archivos, endpoints, continuidad histórica, licencias y última publicación efectiva.
- Definir con el potencial cliente cuáles son las series mínimas para aceptar la primera entrega.

La cobertura debe informarse como un inventario medible de fuentes y series incorporadas. La expresión "todos los datos disponibles" no se considerará una garantía de exhaustividad.
