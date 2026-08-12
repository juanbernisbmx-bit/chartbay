# The Chart Bay — Análisis Técnico con IA (swing / acciones e índices)

Pipeline en Python que baja datos de mercado, calcula indicadores técnicos y le
pide a la IA (Claude) un análisis técnico **frío, objetivo y con base
estadística** — sin emociones. Pensado para swing trading en acciones e índices.

## Por qué fuera de TradingView

TradingView usa Pine Script, que corre en sus servidores y **no puede llamar a
una IA ni a internet**. Por eso el análisis con IA vive en este pipeline externo:
TradingView se usa para ver el gráfico, y este programa para el veredicto de la IA.

## Qué hace

1. **Datos** (`data.py`) — baja OHLCV diario vía Yahoo Finance (sin API key).
2. **Indicadores** (`indicators.py`) — calcula tendencia (EMAs 20/50/200), RSI,
   MACD + cruces, ATR, Bollinger, soportes/resistencias y volumen relativo.
3. **IA** (`analyze.py`) — manda esa "foto" a Claude, que devuelve lectura por
   indicador, escenarios alcista/bajista y un veredicto con niveles clave.
4. **Informe** (`main.py`) — guarda todo en un `.md` dentro de `informes/`.

## Instalación

Necesitas Python 3.10+.

```bash
pip install -r requirements.txt
```

## Configuración

1. **Clave de IA:** copia `.env.example` a `.env` y pega tu clave de Anthropic
   (se consigue en https://console.anthropic.com/):

   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```

2. **Activos y ajustes:** edita `config.py`
   - `TICKERS`: símbolos de Yahoo Finance (`AAPL`, `MSFT`, `SPY`, `^GSPC`...)
   - `INTERVAL` / `PERIOD`: temporalidad e histórico (por defecto diario, 1 año)
   - `PERFIL_RIESGO`: `conservador` | `moderado` | `agresivo`

## Uso

```bash
python main.py                 # analiza los tickers de config.py
python main.py AAPL NVDA       # analiza solo esos
```

El informe queda en `informes/analisis_<fecha>.md`.

## Diario financiero web (con login)

La carpeta `web/` contiene una aplicación web privada (Flask) que muestra un
"diario financiero": tarjetas por activo (precio, tendencia, RSI/MACD/ATR,
soportes), mini-gráficos de precio, el veredicto IA del día y el historial de
informes. Tiene **login de un solo usuario**.

### Probarla en local

```bash
pip install -r requirements.txt
# rellena el .env (ANTHROPIC_API_KEY, APP_USERNAME, APP_PASSWORD, SECRET_KEY)
python web/app.py
```

Abre http://127.0.0.1:5000 y entra con el usuario/clave del `.env`.
Las tarjetas y gráficos cargan solos (datos gratuitos de Yahoo). El veredicto IA
se genera al pulsar el botón "🤖 Generar veredicto IA del día" (se cachea por día
para no repetir coste). El historial lee los `.md` de la carpeta `informes/`.

### Publicarla en internet (Render) + dominio propio

El proyecto ya incluye `Procfile` y `render.yaml`, así que el despliegue es casi
automático.

**A. Subir el código a GitHub**

1. Crea un repositorio (privado recomendado) en https://github.com.
2. Sube esta carpeta. El `.gitignore` ya evita subir `.env` y la base de datos.

**B. Publicar en Render (plan gratuito)**

1. Entra a https://render.com e inicia sesión con GitHub.
2. New → **Blueprint** y elige tu repo (Render detecta el `render.yaml`).
3. Te pedirá rellenar las variables marcadas: `APP_USERNAME`, `APP_PASSWORD` y,
   si quieres el oráculo IA, `ANTHROPIC_API_KEY`. (`SECRET_KEY` se genera sola.)
4. Deploy. En 1-2 minutos te da una URL tipo `https://chartbay.onrender.com`.

**C. Conectar tu dominio**

1. En tu registrador (donde compraste el dominio) abre la zona DNS.
2. En Render, en tu servicio → **Settings → Custom Domains** → añade tu dominio.
   Render te dirá qué registro crear: normalmente un `CNAME` (para `www`) y/o un
   `A`/`ALIAS` para el dominio raíz, apuntando al destino que te indica Render.
3. Crea esos registros en tu registrador y espera la propagación (minutos a horas).
   Render emite el certificado HTTPS automáticamente.

Recomendaciones de seguridad: usa una contraseña larga y un `SECRET_KEY` aleatorio,
y mantén el repositorio privado.

> ⚠️ **Persistencia de datos.** El plan gratuito de Render usa un disco efímero:
> la base de datos SQLite (`web/chartbay.db` con usuarios, bots y reseñas) **se
> reinicia en cada redeploy**. Para conservar los datos en producción hay que
> añadir un *Disk* de Render (plan de pago) montado en `web/`, o migrar a una base
> de datos gestionada (PostgreSQL). Para pruebas o uso personal, el disco efímero
> alcanza.

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

## Coste

Solo pagas la API de Anthropic por cada análisis (céntimos por ticker). Los datos
de Yahoo Finance son gratuitos. El hosting tiene plan gratuito en varios servicios.

## Aviso

Herramienta educativa de análisis técnico para uso personal. **No es
asesoramiento financiero.** Las decisiones de inversión son tuyas y conllevan
riesgo de pérdida.
