# Arquitectura inicial de la base económica

**Actualización operativa — 15 de octubre de 2026:** el usuario eligió ejecutar
las actualizaciones en un servidor siempre encendido. El
[actualizador Python](scripts/actualizar_base.py) programa las consultas por
frecuencia y por archivo compartido, conserva revisiones y reintenta fallos.
La [instalación con systemd](despliegue/README.md) está preparada para Linux;
todavía no se instaló en un servidor remoto. Esta decisión reemplaza para la
recolección local la elección anterior de operar únicamente con Supabase.

**Etapa actual — 15 de octubre de 2026:** por decisión del usuario se prioriza
importar directamente las series descargables y conservar los originales. La
[base masiva SQLite](datos/base/README.md) reúne los dumps de Datos Argentina y
los indicadores provinciales/sectoriales de Economía, con metadatos, procedencia
y pendientes medidos. La limpieza y el agente se posponen. Esta carga local no
publica en Supabase; el diseño de revisión que sigue queda para etapas posteriores.

Actualización del piloto: 7 de octubre de 2026.

Estado: diseño de la base y piloto local integrado con ChartBay. Se extraen 7 series IPC y una serie provincial TOP de cinco originales conservados; la instantánea JSON contiene 851 observaciones. La [auditoría técnica](datos/AUDITORIA_8_SERIES.md) cotejó esas observaciones con los originales, sin aprobar todavía su publicación. El esquema PostgreSQL privado ya está instalado en Supabase y existe un [cargador reproducible de candidatos](datos/README.md#cargar-el-piloto-como-candidato-en-supabase); ejecutarlo requiere credenciales administrativas por variables de entorno y nunca publica. Tampoco hay actualización programada para TOP. Ver [alcance del piloto](datos/README.md).

Decisión de infraestructura para esta etapa: no usar la computadora Ubuntu ni desplegar un servidor propio. El objetivo es alojar la base y los originales en Supabase y estudiar la automatización con funciones programadas de Supabase y una API de modelo externa. Los scripts Python actuales siguen siendo herramientas locales del piloto: no corren en Edge Functions sin adaptación. El servicio Flask de revisión existente en ChartBay tampoco queda alojado en Supabase por esta decisión; su reemplazo o alojamiento queda por resolver antes de habilitar la revisión remota.

## Objetivo y límites

Construir una base de datos económicos de Argentina, con cobertura nacional, provincial y regional, actualizaciones repetibles y trazabilidad para investigación. ChartBay será el frontend de prueba; la base debe poder entregarse y funcionar sin depender de ChartBay.

El inventario inicial está en [FUENTES.md](FUENTES.md). "Todos los datos disponibles" es una dirección de crecimiento, no un alcance verificable para la primera entrega. Cada conjunto requiere revisar cobertura, metodología, acceso y condiciones de reutilización.

La primera etapa incluye series agregadas. Los microdatos de encuestas, como EPH, requieren un diseño y controles propios y quedan fuera del primer piloto.

## Componentes propuestos

| Componente | Elección inicial | Responsabilidad |
| --- | --- | --- |
| Recolección y procesamiento | Python local en el piloto; automatización en Supabase por adaptar | Descargar, registrar originales, transformar y ejecutar controles |
| Base de datos | PostgreSQL | Guardar catálogo, observaciones versionadas y registros de revisión |
| Alojamiento | Supabase, proyecto piloto en Oregon | Ejecutar PostgreSQL y controlar accesos |
| Archivos originales | Supabase Storage, separado de las tablas | Conservar lo descargado y permitir reproducir cada carga |
| Tareas programadas | Supabase Cron y Edge Functions, pendientes de implementación | Iniciar actualizaciones sin servidor propio |
| Asistencia de IA | API de modelo externa, futura | Proponer decisiones sobre candidatos; nunca publicar por sí sola |
| Consulta web | ChartBay existente: Flask y frontend web | Buscar series, mostrar metadatos, descargar y preparar datos para análisis |
| Código y documentación | Repositorio propio | Versionar programas, reglas, pruebas, esquema y manuales, sin credenciales |

Los usuarios consultarán mediante la web. SQL sigue siendo el lenguaje interno de la base, aunque el investigador no necesite escribirlo.

Mientras dure el piloto, Python se ejecuta localmente y separado del servidor web. Para operar solo con Supabase habrá que adaptar esos recolectores y controles a su entorno de ejecución, o revisar esta decisión de infraestructura. Abrir una página no debe iniciar una recolección ni publicar datos nuevos.

## Flujo de datos

Fuente -> archivo original -> carga candidata -> transformación -> controles -> revisión humana -> publicación aprobada -> ChartBay.

1. Registrar cada intento de descarga, incluyendo errores y cuándo se consultó la fuente.
2. Conservar el original con su URL, fecha de descarga y hash del contenido. Un contenido idéntico puede reutilizar el archivo, manteniendo el registro del nuevo intento.
3. Convertir los datos mediante reglas explícitas y versionadas. No completar valores ausentes ni corregir cifras por intuición.
4. Ejecutar controles de estructura, unidades, fechas, duplicados, cobertura y cambios respecto de la carga anterior.
5. Mantener la carga candidata fuera de las consultas públicas hasta su aprobación. Un valor atípico genera una alerta, no demuestra un error.
6. Publicar una versión identificable en una operación atómica. Ante un fallo, conservar la última publicación aprobada.

En el piloto todas las publicaciones requieren aprobación humana. Más adelante pueden automatizarse las cargas rutinarias bajo reglas documentadas, dejando cambios metodológicos y alertas para revisión.

## Modelo de información

Esta es una estructura conceptual, todavía no un esquema SQL definitivo.

| Entidad | Información principal |
| --- | --- |
| Fuentes | Productor, distribuidor, enlaces, condiciones de uso y estado de evaluación |
| Conjuntos | Publicación o conjunto de origen, metodología, acceso y periodicidad esperada |
| Territorios | Identidad y tipo: país, provincia, CABA, región, aglomerado u otra cobertura |
| Clasificaciones geográficas | Definición de una regionalización, autor y vigencia |
| Composición geográfica | Relación entre regiones y sus componentes cuando está documentada; no implica que los valores puedan sumarse |
| Indicadores | Concepto económico medido: IPC, empleo, recaudación, etc. |
| Series | Indicador, territorio, fuente, frecuencia, unidad, base, ajuste y otras dimensiones necesarias |
| Versiones de observaciones | Serie, período de referencia, valor o motivo de ausencia, versión y carga de origen |
| Cargas y archivos | Originales, hashes, fechas, versión del proceso y resultado de ejecución |
| Controles y revisiones | Regla aplicada, resultado, alerta, responsable y decisión |
| Publicaciones | Versión aprobada, fecha de publicación interna y observaciones incluidas |

Una serie no se identifica solamente por su nombre. Un índice y su variación porcentual, una medición nacional y una provincial, o series con distintas bases o ajustes deben distinguirse.

Los territorios no forman necesariamente un árbol único: varias regionalizaciones pueden coexistir y algunos dominios cubren solo una parte de una provincia. No convertir aglomerados EPH en datos provinciales ni calcular regiones sumando o promediando sin una metodología válida.

## Fechas y revisiones

Mantener separados:

- Período de referencia: cuándo ocurrió lo medido; representar también inicio y fin del período.
- Fecha de publicación de la fuente: cuándo se difundió el valor, si se conoce.
- Fecha de consulta o descarga: cuándo nuestro sistema obtuvo el contenido.
- Fecha de aprobación y publicación interna: cuándo pasó a estar disponible en nuestra base.

Si una fuente cambia un valor histórico, conservar la versión anterior y registrar la nueva. Si no publica una fecha de revisión, registrar cuándo detectamos el cambio sin presentarlo como fecha oficial.

La vista habitual mostrará la última versión aprobada. Para investigación, la descarga debe identificar la publicación utilizada y permitir recuperar esa versión posteriormente. Esto no permite reconstruir revisiones anteriores al inicio de nuestra conservación si la fuente no las ofrece.

Guardar la precisión publicada sin redondeos de presentación en la base. Los valores ausentes no son ceros. Conservar también el original para verificar representaciones y conversiones.

## Integración con ChartBay

La revisión de código identificó:

- Aplicación web Flask en `web/app.py` y frontend de econometría en TypeScript.
- Sección `/data` conservada pero desactivada mediante `SECCIONES["datos"]`.
- Rutas existentes para catálogo, series, metadatos y descarga CSV/JSON.
- Contrato de proveedores en `providers/base.py`, con país, frecuencia, fuente, unidad y observaciones.
- Caché diaria en disco que actualmente consulta proveedores externos; no sustituye una base histórica ni un proceso de actualización programado.

Implementación del piloto: la sección `/base-de-datos` lee la instantánea generada desde este repositorio mediante un adaptador Flask; `/data` sigue desactivada. El catálogo de ChartBay no se edita por separado. Ese adaptador podrá pasar a consultar PostgreSQL después de completar roles, carga y aprobación.

Extender el contrato para incluir territorio y clasificación, período, metodología, estado provisional de la fuente, fechas diferenciadas e identificador de publicación. "Aprobado por nuestro sistema" y "definitivo según el productor" son estados distintos.

La ruta actual de metadatos usa la fecha de la última observación como `last_updated`; para esta base se necesitarán campos separados. La caché y las descargas deberán respetar la versión aprobada solicitada.

Recorrido implementado para las ocho series mensuales del piloto: seleccionar series -> elegir período y transformaciones -> consultar valores y fuentes -> descargar CSV y ficha JSON o enviar directamente a Econometría. La transferencia usa IndexedDB y conserva la selección Y/X o la serie temporal. El cálculo sigue en el navegador.

## Acceso, operación y entrega

- ChartBay consultará mediante su servidor con permisos de lectura sobre datos aprobados. No enviar credenciales administrativas al navegador.
- Separar permisos de recolección, revisión y consulta. La interfaz de administración puede empezar como una herramienta interna sencilla.
- Guardar secretos fuera del repositorio. Decidir si el acceso de investigadores será público o restringido antes del despliegue.
- Realizar copias de base y archivos originales fuera del equipo o alojamiento principal, y probar su restauración.
- Registrar fallos y últimas cargas exitosas. Una fuente inaccesible debe mostrarse como pendiente de actualización, no producir valores inventados.
- Acordar qué datos pueden entregarse, quién recibe cuentas y archivos, quién administra las copias y si el mantenimiento posterior forma parte de la venta.

## Piloto propuesto

El [catálogo de 100 series propuestas](catalogo/README.md), definido el 5 de octubre de 2026, mantiene el inventario inicial. La instantánea de prueba agrega observaciones para siete entradas IPC y TOP Córdoba, sin convertirlas en publicaciones aprobadas ni cargarlas en PostgreSQL. Las siguientes tareas siguen necesarias para la versión de investigación:

1. Auditar una serie del IPC nacional: archivo histórico, unidad, base, períodos, metodología y permiso de reutilización.
2. Diseñar el diccionario de campos con una muestra real antes de cerrar las tablas.
3. Incorporar el IPC por las seis regiones publicadas por INDEC como series separadas.
4. Probar una carga repetida, un cambio histórico, una descarga fallida y una carga rechazada sin alterar lo publicado.
5. Conectar las series aprobadas a ChartBay, inicialmente con descarga y metadatos.
6. Revisar humanamente el conjunto provincial incorporado y su permiso de reutilización antes de publicarlo.

Los agentes quedan para una etapa posterior. Podrán proponer extracciones, transformaciones o revisiones, conservando evidencia y reglas aplicadas; no tendrán autorización implícita para modificar datos aprobados.

## Decisiones pendientes

- Presupuesto de operación y política de copias de Supabase.
- Usuarios previstos y acceso público o institucional.
- Primer conjunto provincial y período histórico requerido.
- Persona responsable de aprobar las cargas.
- Condiciones de entrega, mantenimiento y reutilización de cada fuente.
