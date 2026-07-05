# ChartBay Agro Demo Playbook

## Objetivo de la demo

Mostrar ChartBay Agro como una capa aplicada de ChartBay que ayuda a convertir
datos agropecuarios en modelos econometricos, lecturas interpretables y
escenarios de margen. La demo debe dejar claro que el producto no reemplaza al
criterio profesional: acelera la exploracion, ordena el analisis y traduce
resultados tecnicos a lenguaje agropecuario.

## Que es ChartBay Agro

ChartBay Agro es un laboratorio econometrico y de simulacion de margenes para
datos agropecuarios. Toma datasets con variables como rinde, lluvia,
temperatura, precio, costos, superficie o produccion; detecta columnas
relevantes; sugiere presets de modelo; corre el motor econometrico de ChartBay;
y agrega una lectura agropecuaria de los resultados.

Guion breve:

> Este dataset representa campanas agricolas con rinde, lluvia, temperatura y
> precio. ChartBay detecta automaticamente las columnas relevantes, sugiere un
> modelo de rinde y traduce el resultado econometrico a una lectura
> agropecuaria.

## Problema que resuelve

En agro hay muchos datos dispersos y decisiones que mezclan clima, mercado,
costos y manejo. El problema no suele ser solo calcular una regresion, sino
saber que variable usar como objetivo, que variables explicativas revisar, como
leer los coeficientes sin sobrerreaccionar y como llevar el resultado a un
escenario economico.

ChartBay Agro ayuda a:

- ordenar el primer analisis de un CSV agropecuario;
- reducir friccion para probar modelos de rinde, precio, margen o produccion;
- explicar resultados con lenguaje de negocio agro;
- simular margen bruto y puntos de indiferencia;
- exportar un resumen para compartir o documentar.

## Diferencia contra Excel

Excel ordena datos. ChartBay Agro los interpreta.

Excel es excelente para carga manual, tablas, formulas y control operativo, pero
requiere que el usuario arme el modelo, defina variables, calcule resultados y
escriba la interpretacion. ChartBay Agro agrega contexto: detecta columnas
agro, sugiere modelos revisables, corre el motor econometrico y presenta una
lectura orientada al sector.

## Diferencia contra plataformas AgTech

ChartBay Agro no compite frontalmente con plataformas de agricultura de
precision, monitoreo satelital, mapas, telemetria o ERPs rurales. Es una capa
analitica liviana para trabajar con datos tabulares, modelos y escenarios.

Las fuentes dan los datos. ChartBay Agro ayuda a convertirlos en modelos,
escenarios y decisiones.

## Preparacion previa

Antes de la demo:

- abrir ChartBay en la vista de Econometria donde aparece ChartBay Agro;
- confirmar que el feature flag de Agro esta habilitado;
- usar un dataset demo sintetico, idealmente soja/rinde para una primera demo;
- si se quiere mostrar robustez de muestra, generar la demo grande y comparar
  el aviso de capacidad n/k contra la demo chica;
- tener claro que los datos demo son sinteticos y no sirven para decisiones
  reales;
- tener a mano la seccion de fuentes/templates para explicar como se prepara un
  CSV real sin prometer integraciones automaticas;
- evitar prometer causalidad, prediccion perfecta o recomendacion agronomica
  prescriptiva.

## Demo recomendada

1. Abrir ChartBay Agro.
2. Elegir dataset soja/rinde.
3. Usar preset seguro de rinde si existe.
4. Revisar el aviso de capacidad n/k y quitar dummies si el dataset chico queda
   fragil.
5. Correr modelo con variables numericas.
6. Mostrar lectura agropecuaria.
7. Abrir simulador de margen.
8. Cambiar precio/rinde.
9. Mostrar punto de indiferencia.
10. Exportar resumen.

## Flujo paso a paso

### 1. Abrir ChartBay Agro

Mostrar que Agro vive dentro del flujo de ChartBay Econometria. El mensaje clave
es que no se esta usando un motor paralelo: Agro agrega contexto sectorial sobre
la misma base econometrica.

Guion:

> ChartBay Agro esta integrado al flujo econometrico existente. La diferencia es
> que agrega deteccion de variables agropecuarias, presets y una lectura pensada
> para el negocio agro.

### 2. Cargar un dataset demo

Elegir un dataset sintetico de soja/rinde. Aclarar que es una muestra para
demostracion, no una base real.

Guion:

> Voy a cargar un dataset sintetico. Tiene campanas, zonas o provincias, rinde,
> lluvia, temperatura y variables de precio/costo. Lo usamos para mostrar el
> flujo completo sin depender de una fuente externa.

### 3. Revisar deteccion de columnas

Mostrar las columnas detectadas y las razones. La deteccion debe verse como una
asistencia, no como una decision cerrada.

Guion:

> ChartBay identifica columnas candidatas: rinde, clima, precio, costos o
> superficie. Esto no bloquea al usuario; le propone un punto de partida
> revisable.

### 4. Elegir un preset

Seleccionar un preset de rinde. Si aparecen varios presets, explicar que
representan preguntas distintas.

Guion:

> En este caso conviene empezar por un modelo de rinde. La variable objetivo es
> rinde y las explicativas pueden ser lluvia, temperatura u otras variables
> numericas. El usuario puede ajustar la seleccion antes de correr.

### 4 bis. Revisar capacidad n/k

Antes de correr, leer el aviso de capacidad n/k. Si aparece warning por pocas
observaciones o por variables categoricas, quitar provincia/campana como X o
generar la demo grande para mostrar la diferencia.

Guion:

> ChartBay no bloquea la exploracion, pero avisa cuando la relacion entre
> observaciones y regresores es fragil. Ese aviso es deliberado: ayuda a no
> vender como estable un modelo que todavia necesita mas datos o menos X.

### 5. Correr un modelo

Usar variables numericas y ejecutar la regresion desde el flujo normal de
Econometria. Evitar modelos con demasiadas dummies en demos cortas.

Guion:

> Ahora corremos la regresion con el motor comun de ChartBay. Agro no ejecuta el
> modelo automaticamente: primero deja revisar Y y X, y despues el usuario
> decide.

### 6. Leer la interpretacion agropecuaria

Mostrar el panel de lectura agropecuaria despues del resultado econometrico.
Enfatizar correlacion, magnitud y limites.

Guion:

> La lectura agropecuaria traduce el resultado. Si lluvia tiene coeficiente
> positivo, el sistema explica como leerlo en terminos de rinde, pero tambien
> recuerda que esto es asociacion estadistica sobre este dataset, no prueba
> causal automatica.

### 7. Usar el simulador de margen

Abrir el simulador, cargar hectareas, rinde esperado, precio y costos. Mostrar
ingreso, costo total, margen bruto, margen por hectarea y escenarios.

Guion:

> Pasamos del modelo al margen. Si cambia el precio o el rinde, vemos como se
> mueve el resultado economico. Esto ayuda a discutir sensibilidad, no a cerrar
> una recomendacion unica.

### 8. Mostrar punto de indiferencia

Cambiar precio o rinde hasta que el margen se acerque al equilibrio. Mostrar el
rinde de indiferencia y el precio de indiferencia.

Guion:

> El punto de indiferencia contesta una pregunta comercial muy concreta: con
> esta estructura de costos, que rinde o que precio necesito para no perder.

### 9. Exportar resumen

Usar copiar resumen o export TXT. Explicar que sirve para dejar registro de la
hipotesis, no como informe final auditado.

Guion:

> Exportamos el resumen para compartir la hipotesis de trabajo: inputs, margen,
> escenarios y puntos de indiferencia. Es una base para conversar y ajustar.

## Datos reales y templates

Para una demo externa, mostrar la seccion "Cargar datos reales" despues del
flujo principal. El mensaje correcto es que ChartBay Agro no descarga datos ni
llama APIs todavia: orienta fuentes publicas y ofrece templates CSV para que el
usuario prepare su propio archivo.

Guion:

> Las fuentes publicas dan datos de rinde, produccion o precio. ChartBay Agro no
> las descarga automaticamente en este MVP; muestra referencias y templates para
> que el usuario exporte un CSV, conserve fuente/fecha y lo cargue manualmente.

## Demo para ingeniero agronomo

Enfocar la demo en trazabilidad de variables, plausibilidad agronomica y
limitaciones.

Guion sugerido:

> La herramienta no decide el manejo agronomico. Ayuda a revisar si los datos
> disponibles muestran relaciones consistentes entre clima, rinde, precio y
> margen. El valor esta en acelerar la lectura y dejar visibles los supuestos.

Puntos a resaltar:

- la seleccion de variables es revisable;
- no se promete causalidad por defecto;
- los warnings importan tanto como el coeficiente;
- datos sinteticos o incompletos no deben usarse para recomendaciones reales.

## Demo para profesor universitario

Enfocar la demo en enseñanza de econometria aplicada y lectura critica.

Guion sugerido:

> Para una clase, ChartBay Agro permite pasar de un CSV a una regresion aplicada
> y discutir supuestos: tamano muestral, colinealidad, interpretacion de
> coeficientes y diferencia entre correlacion y causalidad.

Puntos a resaltar:

- muestra un flujo completo sin programar;
- ayuda a explicar variable dependiente e independientes;
- conserva el resultado econometrico general;
- agrega una traduccion sectorial para debate.

## Demo para posible socio o inversor

Enfocar la demo en verticalizacion de ChartBay y potencial comercial.

Guion sugerido:

> ChartBay Agro muestra como el motor de ChartBay puede verticalizarse. No
> construimos una plataforma operativa agro desde cero: agregamos contexto,
> presets, interpretacion y simulacion sobre datos tabulares que ya existen.

Puntos a resaltar:

- aprovecha el motor existente;
- no necesita backend ni APIs para el MVP;
- genera una demo comprensible y exportable;
- abre camino a verticales por industria.

## Demo para productor o asesor agropecuario

Enfocar la demo en preguntas practicas: margen, precio, rinde y sensibilidad.

Guion sugerido:

> La pregunta no es solo cuanto rinde el cultivo, sino que pasa con el margen si
> cambia el precio, el rinde o los costos. ChartBay Agro ayuda a poner numeros a
> esa conversacion.

Puntos a resaltar:

- se puede cargar un CSV propio;
- la herramienta propone, no impone;
- el simulador permite probar escenarios;
- el resultado debe validarse con conocimiento local y datos reales confiables.

## Cierre recomendado

Cerrar la demo con tres ideas:

- ChartBay Agro acelera el pasaje de datos a modelo.
- La interpretacion agropecuaria baja la barrera tecnica.
- El simulador conecta el analisis con margen y sensibilidad.

Frase final:

> ChartBay Agro no reemplaza al criterio profesional: lo acompana con modelos,
> escenarios y una lectura mas clara de los datos.
