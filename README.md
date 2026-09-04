# ChartBay Engine

**Laboratorio web de econometría orientado a estudiantes.**

[Abrir la aplicación](https://chartbay.onrender.com) ·
[Descargar el código fuente servido](https://chartbay.onrender.com/source.tar.gz)

## Presentación

ChartBay es un proyecto educativo que busca reducir la distancia entre la teoría
econométrica y su aplicación práctica. Permite cargar un conjunto de datos,
especificar un modelo y recorrer la estimación paso a paso, con explicaciones en
castellano sobre los resultados y los supuestos que conviene revisar.

La propuesta no es reemplazar la enseñanza teórica ni el criterio del analista,
sino ofrecer un entorno de práctica accesible: una primera capa guiada para quien
está aprendiendo y herramientas más avanzadas para profundizar.

## Problema que aborda

En las primeras experiencias con econometría, la dificultad suele estar repartida
entre tres frentes: aprender la teoría, dominar la sintaxis de un paquete
estadístico e interpretar correctamente su salida. ChartBay concentra esos pasos
en una misma interfaz para que el estudiante pueda enfocarse primero en la
pregunta económica, la elección de variables y la lectura crítica del modelo.

## Funcionalidades principales

- Estimación por mínimos cuadrados ordinarios mediante ecuaciones normales;
  la regresión auxiliar del ADF usa QR para estabilidad numérica.
- Regresión restringida y contrastes de hipótesis con test de Wald.
- Inferencia estadística, intervalos de confianza y pruebas t y F.
- Diagnósticos de residuos, heterocedasticidad y multicolinealidad.
- Errores estándar robustos HC1, HC3 y HAC.
- Análisis de series de tiempo con ADF, ACF, PACF y Ljung–Box.
- Comparación de especificaciones y registro de decisiones del análisis.
- Exportación de resultados y generación de código reproducible para Python,
  R, Stata y notebooks.
- Limpiador de archivos CSV y catálogo de indicadores macroeconómicos.
- Casos de práctica preparados, documentación conceptual y modo guiado.

## Privacidad y reproducibilidad

El motor econométrico principal se ejecuta localmente en el navegador. Los CSV
cargados por el usuario no se envían al servidor. El repositorio contiene el
código fuente, los casos de prueba y los datos de ejemplo utilizados para
reproducir y revisar el comportamiento de la aplicación.

Los resultados del motor se contrastan mediante tests automatizados con
implementaciones de referencia de `statsmodels` y `scipy`. La aplicación también
puede generar la sintaxis equivalente para continuar el análisis fuera de
ChartBay.

## Recorrido sugerido para evaluar el proyecto

1. Abrir [ChartBay](https://chartbay.onrender.com) y entrar al laboratorio.
2. Elegir uno de los casos de práctica incluidos o cargar un CSV propio.
3. Definir la variable que se desea explicar y sus regresores.
4. Ejecutar la estimación y revisar la interpretación, los coeficientes y los
   diagnósticos.
5. Cambiar al modo avanzado para explorar restricciones, errores robustos o
   series de tiempo.
6. Exportar el informe o el código reproducible del análisis.

## Alcance y limitaciones

ChartBay 1.0 es una herramienta educativa. Sus resultados deben
interpretarse dentro del contexto de cada ejercicio y no sustituyen la revisión
metodológica, el diagnóstico del modelo ni el trabajo con software estadístico
de propósito general. No constituye asesoramiento financiero.

## Documentación técnica

Aplicación web para estimar modelos econométricos desde el navegador: cargás un
CSV, corrés una regresión, validás supuestos y exportás resultados. El cálculo
ocurre **en el navegador** (motor en TypeScript), así que no hay datos que suban
a ningún servidor.

## Qué incluye

| Sección | Ruta | Qué hace |
|---|---|---|
| Inicio | `/` | Presentación, acceso al laboratorio y recorrido de módulos activos |
| Econometría | `/econometria` | OLS, RLS con test de Wald, inferencia t/F, intervalos al 95%, diagnósticos de residuos y colinealidad (VIF), series de tiempo (ADF, ACF, PACF, Ljung-Box) |
| Limpiador | `/limpiador` | Inspección y limpieza de CSV con motor C++/WebAssembly |
| Datos | `/data` | 49 indicadores macro (37 de FRED, 12 de World Bank), con caché diaria y descarga en CSV o JSON con atribución de origen |
| Documentación | `/guia` | Conceptos, ejemplos guiados y un curso de econometría |

### Versiones del laboratorio

| Versión | Estado 1.0 | Motor | Límite CSV |
|---|---|---|---:|
| Lite | Estable | TypeScript + limpiador WebAssembly | 100 MB |
| Pro | Beta | Python/statsmodels vía Pyodide en un Web Worker | 10 MB |

Lite y Pro son motores distintos, no niveles de una escalera. Lite admite
archivos mayores; superar su límite nunca es una razón para cambiar a Pro.
Las librerías de la interfaz y el runtime fijado de Pyodide 0.26.4 viajan desde
el mismo origen. Pro empieza a preparar Python al elegirlo, reutiliza el worker
entre regresión y series, transfiere matrices numéricas sin serializar otra vez
el CSV y cancela una ejecución que supere 120 segundos. El worker se libera al
volver a Lite o después de 10 minutos sin uso.

Los artefactos Pyodide se verifican sin red con
`python scripts/vendor_pyodide.py --check`. Para reproducirlos desde las
publicaciones oficiales, ejecutar el mismo script sin `--check`; cada descarga
queda fijada por SHA-256 en el script y en el manifiesto generado.

## Secciones desenchufadas

El repo contiene dos verticales que **hoy están apagados**: Agro (rindes, clima,
márgenes agrícolas) y Mercados (panel de tickers, veredictos IA, comparador,
heatmap, comunidad de bots).

No se borraron, se desenchufaron con flags. Sus rutas devuelven 404 y sus
enlaces desaparecen del menú, pero el código, las plantillas y los tests siguen
en el repo:

- **Python** — `SECCIONES` en [`web/app.py`](web/app.py). Los valores publicados
  mantienen Agro y Mercados en `False`.
- **TypeScript** — `CHARTBAY_VERTICALS` en
  [`quantbay/src/verticals/agro/agroFeatureFlags.ts`](quantbay/src/verticals/agro/agroFeatureFlags.ts).
  Al tocarlo hay que recompilar el bundle (ver más abajo).

Los dos flags tienen que coincidir: el de Python saca la ruta, el de TypeScript
evita que la vista se inicialice. Existe
`CHARTBAY_SECCIONES=mercados=on` exclusivamente para auditar el código heredado
en local. Ese override no habilita Agro y **no constituye una reactivación de
Mercados**: faltan persistencia, credenciales, configuración de IA y QA integral.

## Estructura

```
web/          app Flask: rutas, plantillas y estáticos
quantbay/     motor econométrico en TypeScript (se compila a un bundle)
providers/    fuentes de datos macro (FRED, World Bank)
backend/      motor equivalente en Python + FastAPI — no se despliega (ver abajo)
datasets/     CSV de ejemplo para el laboratorio
```

> El paquete `backend/` es un motor FastAPI independiente que **no forma parte
> del despliegue**: `render.yaml` levanta un único servicio con
> `gunicorn web.app:app`, y la app Flask no lo invoca. Requiere Python ≥ 3.12 y
> se corre por separado.

## Correr en local

Necesitás Python 3.10+ para la app Flask y Node 22 para compilar el frontend.

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
cp .env.example .env      # FRED_API_KEY es opcional en local
python web/app.py
```

Abre <http://127.0.0.1:5000>.

Variables del `.env`:

| Variable | Para qué | ¿Obligatoria? |
|---|---|---|
| `SECRET_KEY` | firma de cookies y CSRF si se audita la autenticación heredada | Render la genera; en desarrollo hay fallback |
| `FRED_API_KEY` | descargas FRED de Datos ([clave gratuita](https://fredaccount.stlouisfed.org/apikeys)) | opcional; sin ella World Bank y el catálogo siguen disponibles |
| `APP_USERNAME` / `APP_PASSWORD` | login heredado de Mercados | fuera del despliegue 1.0 |
| `ANTHROPIC_API_KEY` | pipeline CLI y veredictos heredados de Mercados | fuera del despliegue 1.0 |
| `CHARTBAY_SECCIONES` | override local `mercados=on` para QA | no configurar en Render 1.0 |

## Compilar el motor

El bundle `web/static/js/quantbay.bundle.js` **viaja compilado en el repo**,
porque el runtime Python de Render no incluye Node. Después de tocar cualquier
`.ts` hay que recompilarlo y commitearlo, o el deploy sigue sirviendo el
JavaScript viejo:

```bash
cd quantbay && npm ci && npm run build
```

## Tests

El motor de cálculo se testea desde `quantbay/` con Vitest: **1516 tests en 87
archivos** para el alcance actual.

```bash
cd quantbay && npm ci && npm test
```

Dieciocho de esos tests —los de `statsmodelsValidation.test.ts`— no se conforman
con comparar contra valores fijos: levantan un intérprete de Python y validan
OLS y RLS contra **statsmodels y scipy** en vivo. Necesitan sus dependencias:

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements-dev.txt
PATH="$PWD/.venv/bin:$PATH" npm --prefix quantbay run test
```

La suite busca `CHARTBAY_PYTHON`, el `.venv` del repositorio y luego
`python3`/`python`, y usa el primer intérprete que pueda importar NumPy, SciPy y
statsmodels.

Controles adicionales, también ejecutados por CI:

```bash
python tests/test_providers.py
python tests/test_web.py
make -C cleaner test
make -C cleaner wasm-test
cd backend && python -m pip install -e ".[dev]" && ruff check . && pytest
```

El paquete `backend/` requiere Python 3.12 y conserva su suite independiente.
GitHub Actions se ejecuta recién al hacer push o abrir un pull request; una
validación local no equivale a afirmar que el workflow remoto pasó.

## Desplegar en Render

El repo incluye `Procfile` y `render.yaml`, así que el despliegue es casi
automático.

1. Entrá a <https://render.com> e iniciá sesión con GitHub.
2. New → **Blueprint** y elegí el repo (Render detecta el `render.yaml`).
3. Completá `FRED_API_KEY` si querés habilitar las 37 series FRED.
   `SECRET_KEY` se genera sola. No agregues credenciales de login ni Anthropic
   al servicio 1.0.
4. Deploy. En 1-2 minutos te da una URL tipo `https://chartbay.onrender.com`.

Para un dominio propio: en Render, servicio → **Settings → Custom Domains**,
añadí el dominio y creá en tu registrador los registros que te indique
(normalmente un `CNAME` para `www` y un `A`/`ALIAS` para el raíz). El
certificado HTTPS lo emite Render solo.

Gunicorn corre con **1 worker y 8 hilos**. La carga es I/O-bound (FRED y World
Bank), así que los hilos evitan que una llamada lenta bloquee toda la web;
un segundo worker duplicaría NumPy en RAM y el plan gratuito tiene 512 MB.

> **SQLite no participa de ChartBay 1.0.** Sólo lo usa la autenticación y la
> comunidad heredada de Mercados; con el vertical apagado la app ni siquiera
> abre la base. Una eventual reactivación necesitaría almacenamiento persistente
> (disco o base externa) antes de considerarse operativa.

### Comprobar qué versión está desplegada

`GET /version` (sin login) devuelve el commit que está corriendo y hace cuánto
arrancó el proceso:

```bash
curl -s https://chartbay.onrender.com/version
```

```json
{"commit":"0d1425d…","commit_short":"0d1425d","branch":"main",
 "arrancado":"2026-08-12T13:36:18","uptime_s":7}
```

El `uptime_s` es el que delata un redeploy: si vuelve a empezar de cero, la
instancia se reinició de verdad. Sirve sobre todo para los cambios que no
alteran ninguna respuesta (un arreglo de concurrencia, por ejemplo), donde de
otro modo un deploy fallido es indistinguible de uno exitoso.

### Evitar el arranque en frío (keep-alive)

El plan gratuito de Render **duerme la instancia tras ~15 minutos sin tráfico**,
y despertarla tarda 40-50 segundos. Quien entre en ese momento se come la espera
(y, si se cruza con el arranque, algún 520 esporádico de Cloudflare).

La solución es un ping periódico desde fuera. Conviene apuntar a `/version`, que
es la ruta más barata del sitio: no toca la base ni renderiza plantillas, y
responde menos de 200 bytes.

Configuración en [cron-job.org](https://cron-job.org) (gratis):

| Campo | Valor |
|---|---|
| URL | `https://chartbay.onrender.com/version` |
| Zona horaria | `America/Argentina/Buenos_Aires` |
| Programación | `*/10 9-18 * * *` (cada 10 min, de 9:00 a 19:00) |
| Timeout | el máximo que permita |
| Notificaciones | solo tras **varios** fallos seguidos |

Dos cosas que conviene saber:

- **El primer ping del día casi siempre falla**, y no significa que el sitio esté
  caído: a las 9:00 la instancia lleva toda la noche dormida y tarda más que
  cualquier timeout razonable. La petición igual dispara el arranque, así que a
  las 9:10 ya responde. Por eso las notificaciones deben exigir varios fallos
  seguidos, o vas a recibir una alerta falsa cada mañana.
- **No cubrir las 24 h es deliberado.** Render regala 750 horas de instancia al
  mes; 24/7 son ~730, es decir sin margen para ningún otro servicio gratuito.
  La franja de 10 h diarias consume ~300 h/mes y deja sitio de sobra.

No pongas credenciales ni cabeceras de autenticación en el cron: `/version` es
público a propósito, justamente para poder monitorizarlo sin secretos de por
medio.

## Pipeline de análisis técnico con IA

En la raíz del repo sobrevive el proyecto original: un pipeline en Python que
baja datos de mercado, calcula indicadores técnicos y le pide a Claude un
análisis frío y con base estadística. **Ya no se expone en la web** —la sección
Mercados está desenchufada— pero sigue funcionando desde la línea de comandos.

1. **Datos** (`data.py`) — OHLCV diario vía Yahoo Finance, sin API key.
2. **Indicadores** (`indicators.py`) — EMAs 20/50/200, RSI, MACD y cruces, ATR,
   Bollinger, soportes/resistencias y volumen relativo.
3. **IA** (`analyze.py`) — manda esa "foto" a Claude, que devuelve lectura por
   indicador, escenarios y un veredicto con niveles clave.
4. **Informe** (`main.py`) — guarda todo en un `.md` dentro de `informes/`.

```bash
python main.py                 # analiza los tickers de config.py
python main.py AAPL NVDA       # analiza solo esos
```

Los activos y el perfil de riesgo se configuran en `config.py`. Necesita
`ANTHROPIC_API_KEY` en el `.env`.

## Coste

El hosting tiene plan gratuito en Render y los datos de FRED y Yahoo Finance son
gratis. La web 1.0 no consume la API de Anthropic; esa clave sólo genera coste
si el propietario ejecuta voluntariamente el pipeline CLI heredado.

## Licencia

El código fuente de ChartBay se distribuye bajo la
[GNU Affero General Public License v3.0 únicamente](LICENSE) (`AGPL-3.0-only`).
Podés usarlo, estudiarlo, modificarlo y redistribuirlo, incluso comercialmente,
bajo las condiciones de esa licencia. Si ofrecés por red una versión
modificada, tenés que brindar a sus usuarios acceso al código fuente
correspondiente de esa versión.

La licencia del código no concede derechos sobre el nombre ni los logotipos de
ChartBay. Consultá [TRADEMARKS.md](TRADEMARKS.md) para conocer esa excepción.
Los componentes y datos de terceros conservan sus licencias respectivas.
El detalle de dependencias, recursos externos y datos incorporados está en
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Para el cierre 1.0 también están disponibles
[`docs/V1_RELEASE_SCOPE.md`](docs/V1_RELEASE_SCOPE.md),
[`docs/V1_QA_CHECKLIST.md`](docs/V1_QA_CHECKLIST.md) y
[`CHANGELOG.md`](CHANGELOG.md).

## Aviso

Herramienta educativa. **No es asesoramiento financiero.** Las decisiones de
inversión son tuyas y conllevan riesgo de pérdida.
