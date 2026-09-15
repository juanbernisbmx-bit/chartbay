# ChartBay 1.0 — Alcance de la versión

Fecha de cierre de alcance: 28 de agosto de 2026.

> **Actualización de septiembre de 2026.** Mercados, la comunidad de bots, la
> autenticación y el pipeline de análisis técnico con IA **se borraron** del
> repositorio, y la sección Datos quedó **escondida** (sus rutas devuelven 404).
> El resto del documento describe el cierre de 1.0.

Este documento define **qué es ChartBay 1.0** y, sobre todo, qué no es. Existe
porque el repositorio contiene bastante más código del que la versión promete:
dos verticales apagados, un motor Python paralelo y un pipeline de línea de
comandos. Sin un documento que fije el límite, cualquiera —incluido quien lo
escribió— termina leyendo el repositorio como si todo estuviera desplegado.

La regla que ordena todo lo demás: **lo que la web promete tiene que coincidir
con lo que la web ejecuta.**

---

## 1. Definición de "ChartBay 1.0 listo"

ChartBay 1.0 está listo cuando **las nueve** condiciones se cumplen a la vez.
No es una lista de deseos: cada punto es verificable y siete de los nueve están
cubiertos por tests automáticos.

| # | Condición | Cómo se verifica |
|---|---|---|
| 1 | Las cinco secciones activas —Inicio, Econometría, Limpiador, Datos y Documentación— responden 200 en producción | `tests/test_web.py::test_rutas_activas_responden_200` |
| 2 | Las secciones fuera de alcance —Mercados, comunidad, veredictos IA— devuelven 404 y no aparecen en el menú | `test_secciones_apagadas_devuelven_404`, `test_secciones_apagadas_no_aparecen_en_el_menu` |
| 3 | Ninguna afirmación pública atribuye QR al motor OLS desplegado | Revisión manual + sección 4 de este documento |
| 4 | Pro aparece identificada como beta en el laboratorio y en la documentación | Inspección de `/econometria` con Pro seleccionada |
| 5 | Un Blueprint nuevo de Render arranca sin credenciales heredadas y con FRED configurable | `test_arranca_sin_ninguna_variable_de_entorno` + despliegue real |
| 6 | Ninguna sección activa depende de SQLite, de bots ni de Anthropic | Ese código se borró; `test_rutas_de_mercados_ya_no_existen` |
| 7 | No hay recursos bloqueados por CSP ni permisos heredados innecesarios | `test_csp_*` + consola del navegador sin errores |
| 8 | Las dependencias críticas del laboratorio están fijadas y viajan en el bundle local | `package-lock.json`, build reproducible e inspección de `quantbay.html` |
| 9 | Las tres suites pasan: Vitest, providers y Flask | `npm test`, `python tests/test_providers.py`, `python tests/test_web.py` |

**Estado al 28/08/2026: las nueve condiciones se cumplen en el árbol de
trabajo.** Falta la verificación en producción de la 1 y la 5, que requieren un
despliegue real (ver `docs/V1_QA_CHECKLIST.md`).

---

## 2. Dentro del alcance

| Sección | Ruta | Estado |
|---|---|---|
| Inicio | `/` | Estable |
| Econometría | `/econometria` | Estable en **Lite**; **Pro en beta** |
| Limpiador | `/limpiador` | Estable |
| Datos | `/data` | Estable; las 37 series FRED requieren `FRED_API_KEY` |
| Documentación | `/guia` | Estable |
| Versión desplegada | `/version` | Estable; público a propósito, es el health check |

### Lite y Pro no son una escalera

Son **dos motores distintos**, y conviene decirlo así porque el nombre sugiere
lo contrario:

| | Lite | Pro |
|---|---|---|
| Estado 1.0 | **Estable** | **Beta** |
| Motor | TypeScript en el navegador + limpiador C++/WebAssembly | Python real (Pyodide) con NumPy, pandas y statsmodels |
| Límite de CSV | **100 MB** | **10 MB** |
| Estimación OLS | Ecuaciones normales (X'X invertida por Gauss-Jordan) | statsmodels |

Que Pro admita archivos **más chicos** que Lite no es una limitación de
producto: le pasa el CSV entero como texto a Python y encima carga tres
librerías científicas en un worker. Superar el límite de Lite nunca es una
razón para cambiar a Pro.

### Por qué Pro es beta

El motor funciona y nueve escenarios coinciden con statsmodels de escritorio a
seis decimales. También procesó 363.493 filas / 9,5 MiB. OLS y series ahora
corren en un Web Worker dedicado, con cancelación a los 120 s, para mantener
utilizable el hilo de la interfaz; Pyodide tardó entre 21 y 35 segundos en
arrancar en una máquina rápida. Todavía faltan Safari, un móvil real y un equipo
modesto. El tope de 10 MB sigue siendo conservador y no debe subirse.

Hasta que ese QA exista, la recomendación pública es Lite.

---

## 3. Fuera del alcance

Mercados y todo lo que colgaba de él —comunidad, IA y autenticación— se borró
en septiembre de 2026. Nada de esto forma parte de lo que 1.0 promete.

| Componente | Dónde vive | Estado real |
|---|---|---|
| **Mercados, comunidad de bots, análisis con IA y autenticación** | — | **Borrados** en septiembre de 2026. |
| **Backend FastAPI** — motor Python paralelo | `backend/chartbay_engine/` | **Experimental y no desplegado.** |

### El backend FastAPI, explícitamente

Es la confusión más fácil de cometer al leer el repositorio, así que conviene
ser categórico:

- `render.yaml` levanta **un solo servicio**, con `gunicorn web.app:app`.
- La app Flask **no lo invoca nunca**. No hay un cliente HTTP hacia él.
- Requiere Python ≥ 3.12 y tiene su propia suite de pytest.
- Estima OLS por descomposición QR — **pero eso no describe lo que ejecuta el
  sitio desplegado.**

Es un motor de referencia y un banco de pruebas numérico. Nada más, por ahora.

### La autenticación, y por qué se apagó

La sesión existía por una sola razón: la comunidad de bots de Mercados, que es
lo único con autor y contenido por usuario. Las cinco secciones de 1.0 calculan
todo en el navegador y no guardan nada.

Con Mercados apagado, mantener el login activo tenía cuatro costos y ningún
beneficio: pedía credenciales al arrancar (rompiendo cualquier Blueprint nuevo),
abría SQLite en el import para sembrar un usuario y unos bots inalcanzables,
exponía un formulario de acceso que no desbloqueaba nada, y ofrecía un botón
"Entrar" que no llevaba a ningún lado.

En 1.0 todo eso quedó colgado de un flag; en septiembre de 2026 se borró junto
con Mercados.

---

## 4. Correcciones de veracidad aplicadas

El motivo por el que este documento existe. Cada línea era una afirmación
pública que no coincidía con el código.

| Afirmación anterior | Dónde | Realidad |
|---|---|---|
| "Estimación por MCO mediante descomposición QR" | README | `runOLS` usa **ecuaciones normales** (`quantbay/src/regression.ts`). QR solo lo usa la regresión auxiliar del ADF (`quantbay/src/qrLeastSquares.ts`) y el backend Python. |
| "OLS por descomposición QR" | `home.html`, tabla de módulos | Ídem. Ahora dice "ecuaciones normales". |
| "El motor en Python (FastAPI) que hace las cuentas… Reemplaza de a poco al motor anterior. Estado: Disponible" | `guia.html` | El FastAPI **no está desplegado** y la web no lo llama. |
| Pro presentada como "Disponible" | Panel de versión del laboratorio | Pro es **beta**: el QA numérico pasó, pero faltan Safari, móvil y hardware modesto. |

---

## 5. Riesgos residuales declarados

Ninguno amplía lo que ChartBay 1.0 promete:

1. **Pro permanece beta.** Pasó la paridad numérica y las pruebas de carga
   disponibles, y ya no calcula en el hilo principal; faltan Safari, un móvil
   real y un equipo modesto. Ver el checklist de QA.
2. **Pro permanece pesado aunque Pyodide ya es local.** El runtime y el cierre
   fijado de statsmodels se sirven desde ChartBay con caché inmutable y hashes
   reproducibles. La precarga y la reutilización del worker reducen la espera,
   pero Safari, móvil real, hardware modesto y memoria máxima siguen pendientes
   de medición; por eso Pro conserva la etiqueta beta y el límite de 10 MB.
3. **Los estilos HTML heredados usan `style-src-attr 'unsafe-inline'`.** Los
   scripts inline llevan nonce, los manejadores HTML están bloqueados y ni
   `script-src` ni `style-src` aceptan inline global. El permiso restante sólo
   cubre atributos de presentación existentes.
4. **Producción se verifica después del deploy.** El commit de `/version`, las
   cabeceras reales y la clave FRED no pueden certificarse desde el árbol local.

---

## 6. Licencia: AGPL-3.0-only

El propietario eligió la **GNU Affero General Public License v3.0 únicamente**.
El texto completo está en [`LICENSE`](../LICENSE). La licencia permite usar,
modificar y redistribuir el código, incluso comercialmente, y exige conservar
la misma licencia en las obras derivadas cubiertas. Cuando una versión
modificada se ofrece para interacción por red, sus usuarios deben poder obtener
el código fuente correspondiente. Todas las páginas activas muestran “Código
fuente”, que descarga `/source.tar.gz` desde la misma versión desplegada y no
depende de que el repositorio remoto sea público.

El nombre ChartBay y los archivos de identidad visual quedan fuera de la
licencia del código. La excepción y las reglas de uso están documentadas en
[`TRADEMARKS.md`](../TRADEMARKS.md). Los componentes y datos de terceros
conservan sus propias licencias; sus excepciones y atribuciones están en
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

---

## 7. Reactivar algo que está apagado

El apagado es un flag, no una amputación. Pero los flags no alcanzan solos.

**Datos:** poner `SECCIONES["datos"] = True` en `web/app.py`. Vuelven la
pestaña, la fila de Inicio y las rutas; para las 37 series FRED hace falta
`FRED_API_KEY` en Render.
