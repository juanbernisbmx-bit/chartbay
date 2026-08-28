# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado según [SemVer](https://semver.org/lang/es/).

Las entradas anteriores a 1.0 se reconstruyeron a partir del historial de git,
así que resumen por temas en vez de listar cada commit.

---

## [1.0.0] — 2026-08-28

Primera versión con un alcance declarado. El trabajo de este ciclo no agregó
funcionalidad: **alineó lo que la web promete con lo que la web ejecuta**, y
puso por escrito dónde termina la versión. El alcance completo está en
[`docs/V1_RELEASE_SCOPE.md`](docs/V1_RELEASE_SCOPE.md).

ChartBay 1.0 son cinco secciones: Inicio, Econometría, Limpiador, Datos y
Documentación. Lite es la versión estable; **Pro es beta**.

### Corregido — afirmaciones que no coincidían con el código

- **El motor OLS desplegado no usa QR.** El README, la tabla de módulos de
  Inicio y la Documentación decían "estimación por descomposición QR".
  `runOLS` (`quantbay/src/regression.ts`) resuelve las **ecuaciones normales**:
  arma X'X y lo invierte por Gauss-Jordan. QR se usa en exactamente dos
  lugares, y ninguno es el estimador general: la regresión auxiliar del test ADF
  (`quantbay/src/qrLeastSquares.ts`, donde mezclar niveles con diferencias
  vuelve inestable a X'X) y el backend Python, que no está desplegado.
- **El backend FastAPI no "hace las cuentas".** La Documentación lo describía
  como el motor que calcula y que "reemplaza de a poco al motor anterior", con
  estado *Disponible*. No está desplegado, `render.yaml` levanta un único
  servicio Flask y la app nunca lo invoca. Ahora figura como experimental.
- **Pro no es una versión disponible, es beta.** Se presentaba igual que Lite.
  El QA numérico y de carga ya cubre los casos principales, pero todavía faltan
  Safari, un móvil real y un equipo modesto. El cálculo ahora corre en un worker
  dedicado, con cancelación a los 120 s, para no congelar la interfaz.
- **Los límites de CSV publicados estaban desactualizados.** Lite admite
  **100 MB** y Pro **10 MB**. Que Pro admita *menos* que Lite no es una
  limitación de producto: es lo que cuesta correr Python en una pestaña.
- **La documentación de pruebas se actualizó.** Son 1510 tests en 86 archivos,
  más 13 de proveedores y 49 de Flask.
- **El cierre de QA corrigió cuatro bloqueantes.** La aplicación sirve su propio
  archivo de código fuente, World Bank sigue descargable sin clave FRED, las
  series Pro usan el dataset completo en lugar de la vista previa de 50 filas y
  el error del laboratorio cumple el contraste mínimo del producto.

### Corregido — las fuentes estaban bloqueadas en todo el sitio

Las 17 plantillas cargan IBM Plex desde Google Fonts, pero el CSP no nombraba
ese origen en ninguna directiva: la hoja de estilos caía por `style-src` y los
`.woff2` por `default-src`. **El sitio entero se veía con la fuente del
sistema**, y el navegador lo reportaba como violación de CSP en cada carga.

Ahora `style-src` incluye `fonts.googleapis.com` y hay un `font-src` con
`fonts.gstatic.com`. Las pruebas Flask verifican ambos orígenes en las páginas
activas; la carga visual en el despliegue queda en el checklist manual.

### Cambiado — el CSP se arma por página

Había una sola política para casi todo el sitio, con permisos de TradingView en
páginas que no lo cargan. Ahora se compone a partir de lo que cada página
realmente pide:

| Páginas | Permisos |
|---|---|
| Inicio, Documentación, Datos | Ni WebAssembly ni CDN |
| Limpiador y su worker | `'wasm-unsafe-eval'`, ningún CDN (sus scripts son locales) |
| Econometría | `'wasm-unsafe-eval'`; sus librerías de UI están en el bundle local |
| Worker Pro | `'wasm-unsafe-eval'` + jsDelivr, sólo para descargar Pyodide bajo demanda |

- Los permisos de TradingView salieron de las páginas activas y quedaron atados
  al flag de Mercados: encenderlo los devuelve, sin tener que acordarse.
- Se agregaron `object-src 'none'`, `base-uri 'self'` y `form-action 'self'`.
- Los scripts inline activos llevan nonce por respuesta y
  `script-src-attr 'none'` bloquea manejadores HTML. `script-src` y `style-src`
  ya no contienen `'unsafe-inline'`; sólo `style-src-attr` lo conserva para los
  estilos de presentación heredados.
- El worker del limpiador conserva su entrada propia: un Worker corre bajo el
  CSP de **su propio script**, no bajo el del documento que lo creó.

### Cambiado — dependencias críticas servidas localmente

Papa Parse 5.4.1, Chart.js 4.5.1, jsPDF 4.2.1 y jsPDF-AutoTable 5.0.8 se fijan en
`package-lock.json` y se incorporan al bundle versionado. El laboratorio Lite
ya no depende de jsDelivr ni cdnjs al abrirse. Pyodide sigue descargándose bajo
demanda, pero sólo desde su worker aislado y con error visible si el CDN falla.

El nuevo `quantbay.pro.worker.js` ejecuta OLS y series de tiempo fuera del hilo
principal. Cambiar a Lite libera su heap; una ejecución que supera 120 segundos
se cancela con un mensaje controlado.

Las exportaciones dejan de usar la marca histórica “Quant Bay” y salen firmadas
como ChartBay. Al cargar CSV, las columnas vacías, constantes o duplicadas que
el limpiador descarte quedan enumeradas en pantalla.

### Cambiado — la autenticación se apagó con Mercados

La sesión existía solo para la comunidad de bots. Con Mercados apagado, ninguna
ruta activa la usa. Todo eso ahora cuelga de `AUTH_ENABLED`:

- La barra superior ya no ofrece **Entrar**.
- `/login`, `/register` y `/logout` devuelven 404.
- **La app arranca sin `APP_PASSWORD`**, que era lo que impedía que un Blueprint
  nuevo levantara por una credencial que nada iba a leer.
- **SQLite no se abre en el import.** Antes creaba tablas, hasheaba una
  contraseña y sembraba bots inalcanzables en cada arranque, dejando un `.db`
  (más su `-wal` y su `-shm`) en el disco efímero de Render.

El código heredado quedó disponible para auditoría.
`CHARTBAY_SECCIONES=mercados=on` expone sus rutas en local, pero no constituye
una reactivación funcional y no debe configurarse en Render.

### Seguridad

Aplicado a la autenticación heredada, para que reactivar Mercados no reintroduzca
los agujeros que tenía:

- **CSRF** en todos los métodos que mutan estado, por formulario (`_csrf`) o por
  cabecera (`X-CSRF-Token`), comparado con `secrets.compare_digest`.
- **Logout por POST.** Con logout por GET alcanzaba un `<img src="/logout">`
  ajeno —o un prefetch del navegador— para cerrarle la sesión al usuario.
- **`SESSION_COOKIE_SECURE`** fuera de desarrollo. En local queda apagado
  porque el servidor de desarrollo no habla HTTPS y el navegador descartaría la
  cookie.
- `HttpOnly` y `SameSite=Lax` se conservan.

### Despliegue

- **`FRED_API_KEY` agregada a `render.yaml`.** Faltaba, así que un Blueprint
  nuevo quedaba con las 37 series de FRED desactivadas y sin pista de por qué.
  Es la única variable que hay que completar a mano.
- **`ANTHROPIC_API_KEY` retirada del servicio web.** La consumen rutas que
  devuelven 404 y un pipeline que se corre a mano. Una clave de pago en el
  entorno de un servicio que no la usa es superficie de filtración sin
  contrapartida.
- **`APP_USERNAME` y `APP_PASSWORD` retiradas**, por lo mismo.
- **Health check en `/version`**, la ruta más barata del sitio: no toca la base,
  no renderiza plantillas y devuelve menos de 200 bytes. Además dice qué commit
  está corriendo, así que verde ahí significa "arrancó **y** es el código que
  esperabas".

### Agregado

- `tests/test_web.py` — tests de la app Flask: rutas activas, rutas apagadas,
  cabeceras, las tres variantes de CSP, `/version`, `/data`, CSRF, cookies y
  feature flags. Cubre **las dos** configuraciones (con y sin sesión), no solo
  la que está fija hoy.
- `CHARTBAY_SECCIONES=mercados=on` — override acotado para auditar el código
  heredado de Mercados sin editar el diccionario. No controla Agro ni las
  secciones activas.
- [`docs/V1_RELEASE_SCOPE.md`](docs/V1_RELEASE_SCOPE.md) — alcance de 1.0, con
  una definición concreta y verificable de "listo", la deuda que queda abierta y
  una recomendación de licencia.
- [`docs/V1_QA_CHECKLIST.md`](docs/V1_QA_CHECKLIST.md) — QA en tres bloques:
  automático, revisión visual y post-despliegue, con el estado medido de
  Pyodide y los entornos que siguen pendientes.
- [`LICENSE`](LICENSE) y [`TRADEMARKS.md`](TRADEMARKS.md) — el código queda bajo
  `AGPL-3.0-only`, con el nombre y los logotipos de ChartBay reservados por
  separado.
- Este `CHANGELOG.md`.

### Riesgos externos al código

- Pro permanece beta hasta completar QA físico en Safari, móvil y hardware
  modesto. La ejecución aislada evita que su carga bloquee la interfaz, pero no
  convierte esa cobertura pendiente en evidencia.
- La verificación del commit y las cabeceras del sitio público sólo puede
  cerrarse después del despliegue; este release no hace push ni deploy.

---

## [0.9.0] — agosto 2026 · rediseño

- Skin v2 en las 17 plantillas, sobre `web/static/redesign.css` scopeado a
  `[data-skin="v2"]` y cargado después de `style.css`.
- El laboratorio se re-maquetó **preservando los ~203 IDs** de los que depende
  el bundle: el rediseño mueve bloques y cambia CSS, nunca reescribe el HTML.
- Barra superior compartida (`_topbar_v2.html`) en lugar de una navegación por
  plantilla.

## [0.8.0] — agosto 2026 · limpiador en WebAssembly

- Limpiador de CSV en C++ compilado a WebAssembly, con worker propio.
- El tope de CSV de Lite quedó en **100 MB**: medido, 516 MB y 7,9 M de filas se
  procesan en 17 s con 727 MB de heap WASM.
- `/limpiador` como sección propia, con su bundle chico en vez del motor entero.

## [0.7.0] — agosto 2026 · Datos frecuentes

- Sección `/data` con 49 indicadores macro: 37 de FRED y 12 de World Bank.
- Paquete `providers/` con normalización, caché diaria en disco y exportación a
  CSV y JSON.

## [0.6.0] — 2026 · ChartBay Pro

- Motor Pro sobre Pyodide: statsmodels en el navegador, errores robustos
  HC1/HC3/HAC, restricciones por Wald/F, ARIMA manual y forecast.

## [0.5.0] — 2026 · Agro y reenfoque

- Vertical Agro y, más tarde, el apagado por flags de Agro y Mercados para
  reenfocar el producto en econometría.

## [0.1.0] — 2026 · origen

- Pipeline de análisis técnico en Python: Yahoo Finance, indicadores y veredicto
  de Claude. Sigue en la raíz del repositorio y se corre desde la línea de
  comandos; ya no se expone en la web.
