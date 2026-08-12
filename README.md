# ChartBay Engine — laboratorio de econometría

Aplicación web para estimar modelos econométricos desde el navegador: cargás un
CSV, corrés una regresión, validás supuestos y exportás resultados. El cálculo
ocurre **en el navegador** (motor en TypeScript), así que no hay datos que suban
a ningún servidor.

En producción: <https://chartbay.onrender.com>

## Qué incluye

| Sección | Ruta | Qué hace |
|---|---|---|
| Econometría | `/econometria` | OLS por descomposición QR, RLS con test de Wald, inferencia t/F, intervalos al 95%, diagnósticos de residuos y colinealidad (VIF), series de tiempo (ADF, ACF, PACF, Ljung-Box) |
| Datos | `/data` | 49 indicadores macro (37 de FRED, 12 de World Bank), con caché diaria y descarga en CSV o JSON |
| Documentación | `/guia` | Conceptos, ejemplos guiados y un curso de econometría |

## Secciones desenchufadas

El repo contiene dos verticales que **hoy están apagados**: Agro (rindes, clima,
márgenes agrícolas) y Mercados (panel de tickers, veredictos IA, comparador,
heatmap, comunidad de bots).

No se borraron, se desenchufaron con flags. Sus rutas devuelven 404 y sus
enlaces desaparecen del menú, pero el código, las plantillas y los tests siguen
en el repo:

- **Python** — `SECCIONES` en [`web/app.py`](web/app.py). Poner una clave en
  `True` reactiva sus rutas y sus enlaces.
- **TypeScript** — `CHARTBAY_VERTICALS` en
  [`quantbay/src/verticals/agro/agroFeatureFlags.ts`](quantbay/src/verticals/agro/agroFeatureFlags.ts).
  Al tocarlo hay que recompilar el bundle (ver más abajo).

Los dos flags tienen que coincidir: el de Python saca la ruta, el de TypeScript
evita que la vista se inicialice.

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

Necesitás Python 3.10+.

```bash
pip install -r requirements.txt
cp .env.example .env      # y completá los valores
python web/app.py
```

Abre <http://127.0.0.1:5000>.

Variables del `.env`:

| Variable | Para qué | ¿Obligatoria? |
|---|---|---|
| `SECRET_KEY` | firma de sesiones | sí en producción; en dev hay fallback |
| `APP_USERNAME` / `APP_PASSWORD` | login de un solo usuario | sí en producción |
| `FRED_API_KEY` | descargas de la sección Datos ([clave gratuita](https://fredaccount.stlouisfed.org/apikeys)) | sin ella la sección se ve pero no descarga |
| `ANTHROPIC_API_KEY` | solo el pipeline de análisis técnico (ver el final) | no, para la web |

## Compilar el motor

El bundle `web/static/js/quantbay.bundle.js` **viaja compilado en el repo**,
porque el runtime Python de Render no incluye Node. Después de tocar cualquier
`.ts` hay que recompilarlo y commitearlo, o el deploy sigue sirviendo el
JavaScript viejo:

```bash
cd quantbay && npm install && npm run build
```

## Tests

El motor de cálculo se testea desde `quantbay/` con vitest (1108 tests):

```bash
cd quantbay && npm install && npm run test
```

Dieciocho de esos tests —los de `statsmodelsValidation.test.ts`— no se conforman
con comparar contra valores fijos: levantan un intérprete de Python y validan
OLS y RLS contra **statsmodels y scipy** en vivo. Necesitan sus dependencias:

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements-dev.txt
PATH="$PWD/.venv/bin:$PATH" npm --prefix quantbay run test
```

El `PATH` no es opcional: el test invoca el binario **`python`**, y macOS solo
trae `python3`. El venv resuelve ambas cosas, porque instala los paquetes y
expone `python` en su `bin/`. Sin eso, esos 18 fallan con `spawnSync python
ENOENT` — un fallo de entorno, no del código.

El paquete `backend/` tiene su propia suite de pytest, que requiere Python 3.12.

## Desplegar en Render

El repo incluye `Procfile` y `render.yaml`, así que el despliegue es casi
automático.

1. Entrá a <https://render.com> e iniciá sesión con GitHub.
2. New → **Blueprint** y elegí el repo (Render detecta el `render.yaml`).
3. Completá las variables marcadas: `APP_USERNAME`, `APP_PASSWORD` y, si vas a
   usar el pipeline de IA, `ANTHROPIC_API_KEY`. (`SECRET_KEY` se genera sola.)
4. Deploy. En 1-2 minutos te da una URL tipo `https://chartbay.onrender.com`.

Para un dominio propio: en Render, servicio → **Settings → Custom Domains**,
añadí el dominio y creá en tu registrador los registros que te indique
(normalmente un `CNAME` para `www` y un `A`/`ALIAS` para el raíz). El
certificado HTTPS lo emite Render solo.

Gunicorn corre con **1 worker y 8 hilos**. La carga es I/O-bound (FRED,
Anthropic), así que los hilos evitan que una llamada lenta bloquee toda la web;
un segundo worker duplicaría NumPy en RAM y el plan gratuito tiene 512 MB.

> ⚠️ **Persistencia de datos.** El plan gratuito de Render usa un disco efímero:
> la base de datos SQLite (`web/chartbay.db` con usuarios, bots y reseñas) **se
> reinicia en cada redeploy**. Para conservarla hay que añadir un *Disk* de
> Render (plan de pago) montado en `web/`, o migrar a PostgreSQL. Para uso
> personal, el disco efímero alcanza.

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
gratis. Lo único que se paga es la API de Anthropic, y solo si usás el pipeline
de análisis técnico (céntimos por ticker).

## Aviso

Herramienta educativa. **No es asesoramiento financiero.** Las decisiones de
inversión son tuyas y conllevan riesgo de pérdida.
