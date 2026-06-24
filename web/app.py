"""
ChartBay — aplicación web: herramienta de análisis + comunidad de bots.
Reutiliza los módulos del pipeline (data, indicators, analyze) del proyecto.

Arrancar en local:
    pip install -r requirements.txt
    python web/app.py
    -> abre http://127.0.0.1:5000
"""
import json
import os
import re
import sqlite3
import sys
from datetime import date, datetime
from functools import wraps
from pathlib import Path

from dotenv import load_dotenv
from flask import (
    Flask, jsonify, redirect, render_template, request, session, url_for, abort
)
from werkzeug.security import generate_password_hash, check_password_hash

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))  # permite 'import db' bajo gunicorn (web/ en el path)
load_dotenv(ROOT / ".env")

import config           # noqa: E402
import data             # noqa: E402
import indicators       # noqa: E402
import db               # noqa: E402

CACHE_DIR = Path(__file__).resolve().parent / "cache"
CACHE_DIR.mkdir(exist_ok=True)
REPORTS_DIR = ROOT / config.OUTPUT_DIR

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-inseguro-cambiar")

APP_USERNAME = os.environ.get("APP_USERNAME", "juan")
APP_PASSWORD = os.environ.get("APP_PASSWORD", "cambia-esta-clave")

REGISTRATION_OPEN = False  # cambiar a True para reabrir el registro


# ----------------------------- arranque BD -----------------------------

BOTS_BASE = [
    {
        "name": "AlgoBot v4.31 — BTC Tendencia",
        "market": "Cripto (BTC/USD)",
        "timeframe": "H4 (swing)",
        "description": "Bot de tendencia multiestrategia para Bitcoin en 4 horas. Modo AUTO que elige estrategia segun el regimen de mercado (ADX): sigue tendencia con EMA o opera rangos con RSI. Sin grid ni martingala; siempre con stop real.",
        "rules": "Estrategias: AUTO / EMA crossover / RSI mean-reversion / MACD / Donchian / UT Bot. Regimen por ADX (alto=tendencia, bajo=rango). SL/TP fijo o por multiplos de ATR. Riesgo 1% por trade, breakeven, maxima perdida diaria 5%, filtro de spread.",
        "backtest": "Defaults validados en backtest 2022-2026 y simulacion out-of-sample 2017-2021. Aun asi: modelo base, testealo en demo."
    },
    {
        "name": "AlgoBot Scalper M5 — Breakout/ORB",
        "market": "Indices (NAS100)",
        "timeframe": "M5 (intradia)",
        "description": "Scalper experimental de ruptura intradia para Nasdaq. Detecta consolidaciones estrechas y entra en la ruptura, o usa Opening Range Breakout (rango de apertura de sesion). Muy sensible a costos.",
        "rules": "Ruptura de rango (o ORB) + filtro de tendencia EMA50, filtro de regimen por exponente de Hurst (solo opera si H>0.55, mercado tendencial), horario de sesion USA y spread maximo. SL 1.5xATR, TP 2xATR, breakeven, salida por tiempo, corte de perdida diaria 3%.",
        "backtest": "Sin validar — proyecto de aprendizaje. El backtest DEBE correrse con spread y comision reales o no vale."
    },
    {
        "name": "Aggressive Grid Scalper — Cripto/Forex",
        "market": "Cripto / Forex",
        "timeframe": "M1 (scalping)",
        "description": "Grid agresivo + scalping de alta frecuencia. Abre niveles en grilla con filtro de direccion por EMA y RSI, y regimen por ADX. ALTO RIESGO: un grid sin stop se rompe en tendencias fuertes.",
        "rules": "Grid con espaciado por ATR (paso = ATRx0.5), TP por nivel, filtro EMA9/EMA21 + RSI7 (sobrecompra 70 / sobreventa 30), regimen ADX (umbral 25). Sin martingala (multiplicador 1.0), max 20 posiciones, corte por equity y perdida diaria. Pensado para cuenta DEMO.",
        "backtest": "Sin testear — modelo base de alto riesgo. Solo demo + Strategy Tester."
    },
    {
        "name": "Aggressive Grid Scalper — Nasdaq",
        "market": "Indices (NAS100)",
        "timeframe": "M1 (scalping)",
        "description": "Variante del grid scalper agresivo afinada para Nasdaq, con gestion de riesgo extra (stop por equity, perdida diaria, trailing opcional). Mismo motor de grilla + scalping. ALTO RIESGO.",
        "rules": "Grid por ATR + filtro EMA9/21 y RSI7, regimen ADX. Lote fijo o por % de riesgo. Cierra todo si la perdida flotante supera 20% del balance; limite de perdida diaria 10%; trailing opcional. Sin martingala. Pensado para DEMO.",
        "backtest": "Sin testear — modelo base de alto riesgo. Solo demo + Strategy Tester."
    },
]


def seed_owner():
    conn = db.get_conn()
    row = conn.execute("SELECT id FROM users WHERE username=?", (APP_USERNAME,)).fetchone()
    if not row:
        conn.execute(
            "INSERT INTO users(username, password_hash, created_at) VALUES(?,?,?)",
            (APP_USERNAME, generate_password_hash(APP_PASSWORD), datetime.now().isoformat()),
        )
        conn.commit()
    conn.close()


def seed_starter_bots():
    conn = db.get_conn()
    owner = conn.execute("SELECT id FROM users WHERE username=?", (APP_USERNAME,)).fetchone()
    if not owner:
        conn.close()
        return
    uid = owner["id"]
    for bot in BOTS_BASE:
        # elimina duplicados conservando el id más bajo
        conn.execute(
            """DELETE FROM bots WHERE user_id=? AND name=? AND id NOT IN (
                   SELECT MIN(id) FROM bots WHERE user_id=? AND name=?)""",
            (uid, bot["name"], uid, bot["name"])
        )
        exists = conn.execute(
            "SELECT 1 FROM bots WHERE name=? AND user_id=?", (bot["name"], uid)
        ).fetchone()
        if not exists:
            conn.execute(
                """INSERT INTO bots(user_id,name,market,timeframe,description,rules,backtest,created_at)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (uid, bot["name"], bot["market"], bot["timeframe"],
                 bot["description"], bot["rules"], bot.get("backtest", ""),
                 datetime.now().isoformat()),
            )
    conn.commit()
    conn.close()


db.init_db()
seed_owner()
seed_starter_bots()


@app.context_processor
def inject_globals():
    return {"registration_open": REGISTRATION_OPEN}


# ----------------------------- helpers -----------------------------

def sanitize_ticker(raw: str) -> str:
    t = (raw or "").strip().upper()
    if not re.fullmatch(r"[A-Z0-9.\^\-=]{1,15}", t):
        return ""
    return t


def to_tradingview(ticker: str) -> str:
    tv = getattr(config, "TRADINGVIEW", {})
    if ticker in tv:
        return tv[ticker]
    if ticker.endswith("-USD"):
        return ticker.replace("-USD", "USD")
    if ticker.startswith("^"):
        return ticker[1:]
    return ticker


def _safe_name(ticker: str) -> str:
    return re.sub(r"[^A-Z0-9]", "_", ticker.upper())


# interval -> (yf_interval, yf_period, tv_interval)
ALLOWED_INTERVALS = {
    "1d":  ("1d",  "1y",  "D"),
    "1wk": ("1wk", "5y",  "W"),
    "1h":  ("1h",  "60d", "60"),
}


def bump_visits() -> int:
    fp = CACHE_DIR / "visits.txt"
    try:
        n = int(fp.read_text().strip())
    except Exception:
        n = 0
    n += 1
    try:
        fp.write_text(str(n))
    except Exception:
        pass
    return n


# ----------------------------- auth -----------------------------

def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("user"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "Sesión requerida", "login": True}), 401
            return redirect(url_for("login", next=request.path))
        return f(*args, **kwargs)
    return wrapper


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        u = request.form.get("username", "").strip()
        p = request.form.get("password", "")
        conn = db.get_conn()
        row = conn.execute("SELECT * FROM users WHERE username=?", (u,)).fetchone()
        conn.close()
        if row and check_password_hash(row["password_hash"], p):
            session["user"] = row["username"]
            session["uid"] = row["id"]
            return redirect(request.args.get("next") or url_for("dashboard"))
        error = "Usuario o contraseña incorrectos."
    return render_template("login.html", error=error)


@app.route("/register", methods=["GET", "POST"])
def register():
    if not REGISTRATION_OPEN:
        return render_template("register.html", error=None)
    error = None
    if request.method == "POST":
        u = request.form.get("username", "").strip()
        p = request.form.get("password", "")
        if not re.fullmatch(r"[A-Za-z0-9_]{3,20}", u):
            error = "Usuario: 3-20 caracteres (letras, números o _)."
        elif len(p) < 6:
            error = "La contraseña debe tener al menos 6 caracteres."
        else:
            conn = db.get_conn()
            try:
                conn.execute(
                    "INSERT INTO users(username, password_hash, created_at) VALUES(?,?,?)",
                    (u, generate_password_hash(p), datetime.now().isoformat()),
                )
                conn.commit()
                row = conn.execute("SELECT * FROM users WHERE username=?", (u,)).fetchone()
                session["user"] = row["username"]
                session["uid"] = row["id"]
                conn.close()
                return redirect(url_for("community"))
            except sqlite3.IntegrityError:
                error = "Ese nombre de capitán ya está tomado."
                conn.close()
    return render_template("register.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# --------------------------- herramienta ---------------------------

@app.route("/")
def dashboard():
    return render_template(
        "dashboard.html",
        tickers=config.TICKERS,
        tradingview=getattr(config, "TRADINGVIEW", {}),
        nombres=getattr(config, "NOMBRES", {}),
        perfil=config.PERFIL_RIESGO,
        hoy=date.today().isoformat(),
        visits=bump_visits(),
    )


@app.route("/reports")
def reports():
    files = []
    if REPORTS_DIR.exists():
        files = sorted([p.name for p in REPORTS_DIR.glob("*.md")], reverse=True)
    return render_template("reports.html", files=files)


@app.route("/reports/<path:name>")
def report_view(name):
    if not name.endswith(".md") or "/" in name or "\\" in name:
        abort(404)
    fp = REPORTS_DIR / name
    if not fp.exists():
        abort(404)
    return render_template("report.html", name=name, content=fp.read_text(encoding="utf-8"))


# --------------------------- comunidad ---------------------------

@app.route("/community")
def community():
    q = request.args.get("q", "").strip()
    market = request.args.get("market", "").strip()
    timeframe = request.args.get("timeframe", "").strip()
    sort = request.args.get("sort", "recientes")
    filtering = bool(q or market or timeframe or request.args.get("sort"))

    conn = db.get_conn()
    markets = [r[0] for r in conn.execute(
        "SELECT DISTINCT market FROM bots WHERE market IS NOT NULL AND market<>'' ORDER BY market")]
    timeframes = [r[0] for r in conn.execute(
        "SELECT DISTINCT timeframe FROM bots WHERE timeframe IS NOT NULL AND timeframe<>'' ORDER BY timeframe")]

    sel = ("SELECT b.*, u.username AS author, "
           "(SELECT ROUND(AVG(stars),1) FROM reviews r WHERE r.bot_id=b.id) AS avg_stars, "
           "(SELECT COUNT(*) FROM reviews r WHERE r.bot_id=b.id) AS n_reviews "
           "FROM bots b JOIN users u ON u.id=b.user_id WHERE 1=1 ")
    params = []
    if q:
        sel += " AND (b.name LIKE ? OR b.description LIKE ? OR b.rules LIKE ?)"
        like = f"%{q}%"; params += [like, like, like]
    if market:
        sel += " AND b.market=?"; params.append(market)
    if timeframe:
        sel += " AND b.timeframe=?"; params.append(timeframe)
    order = (" ORDER BY COALESCE(avg_stars,0) DESC, n_reviews DESC, b.id DESC"
             if sort == "estrellas" else " ORDER BY b.id DESC")

    results, featured, recent = [], [], []
    if filtering:
        results = conn.execute(sel + order, params).fetchall()
    else:
        featured = conn.execute(
            sel + " AND (SELECT COUNT(*) FROM reviews r WHERE r.bot_id=b.id)>0"
                  " ORDER BY COALESCE(avg_stars,0) DESC, n_reviews DESC, b.id DESC LIMIT 6", params).fetchall()
        recent = conn.execute(sel + " ORDER BY b.id DESC LIMIT 6", params).fetchall()
    conn.close()
    return render_template("community.html", filtering=filtering, results=results,
                           featured=featured, recent=recent, markets=markets, timeframes=timeframes,
                           q=q, market=market, timeframe=timeframe, sort=sort)


@app.route("/community/new", methods=["GET", "POST"])
@login_required
def bot_new():
    error = None
    if request.method == "POST":
        f = request.form
        name = f.get("name", "").strip()
        if not name:
            error = "Ponle un nombre al bot."
        else:
            conn = db.get_conn()
            conn.execute(
                """INSERT INTO bots(user_id,name,market,timeframe,description,rules,backtest,created_at)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (session["uid"], name[:80], f.get("market", "")[:60], f.get("timeframe", "")[:40],
                 f.get("description", "")[:2000], f.get("rules", "")[:2000], f.get("backtest", "")[:1000],
                 datetime.now().isoformat()),
            )
            conn.commit()
            bid = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            conn.close()
            return redirect(url_for("bot_detail", bot_id=bid))
    return render_template("bot_new.html", error=error)


@app.route("/community/bot/<int:bot_id>")
def bot_detail(bot_id):
    conn = db.get_conn()
    bot = conn.execute(
        "SELECT b.*, u.username AS author FROM bots b JOIN users u ON u.id=b.user_id WHERE b.id=?",
        (bot_id,),
    ).fetchone()
    if not bot:
        conn.close()
        abort(404)
    reviews = conn.execute(
        "SELECT r.*, u.username AS author FROM reviews r JOIN users u ON u.id=r.user_id "
        "WHERE r.bot_id=? ORDER BY r.id DESC", (bot_id,),
    ).fetchall()
    agg = conn.execute(
        "SELECT ROUND(AVG(stars),1) AS avg, COUNT(*) AS n FROM reviews WHERE bot_id=?", (bot_id,),
    ).fetchone()
    conn.close()
    return render_template("bot_detail.html", bot=bot, reviews=reviews,
                           avg=agg["avg"], n=agg["n"])


@app.route("/community/bot/<int:bot_id>/review", methods=["POST"])
@login_required
def bot_review(bot_id):
    try:
        stars = int(request.form.get("stars", "0"))
    except ValueError:
        stars = 0
    stars = max(1, min(5, stars))
    comment = request.form.get("comment", "")[:1000]
    conn = db.get_conn()
    if conn.execute("SELECT 1 FROM bots WHERE id=?", (bot_id,)).fetchone():
        conn.execute(
            "INSERT INTO reviews(bot_id,user_id,stars,comment,created_at) VALUES(?,?,?,?,?)",
            (bot_id, session["uid"], stars, comment, datetime.now().isoformat()),
        )
        conn.commit()
    conn.close()
    return redirect(url_for("bot_detail", bot_id=bot_id))


# --------------------------- API análisis ---------------------------

@app.route("/api/snapshot")
def api_snapshot():
    t = request.args.get("ticker", "").strip()
    if t not in config.TICKERS:
        return jsonify({"ok": False, "error": "ticker no permitido"}), 400
    return _snapshot_response(t)


@app.route("/api/lookup")
def api_lookup():
    t = sanitize_ticker(request.args.get("ticker", ""))
    if not t:
        return jsonify({"ok": False, "error": "símbolo inválido"}), 400
    iv_key = request.args.get("interval", "1d")
    if iv_key not in ALLOWED_INTERVALS:
        iv_key = "1d"
    interval, period, tv_interval = ALLOWED_INTERVALS[iv_key]
    return _snapshot_response(t, interval, period, tv_interval)


def _snapshot_response(t: str, interval: str = "1d", period: str = "1y", tv_interval: str = "D"):
    try:
        df = data.descargar(t, interval, period)
        snap = indicators.construir_snapshot(df)
        nombre = getattr(config, "NOMBRES", {}).get(t, t)
        return jsonify({"ok": True, "ticker": t, "nombre": nombre,
                        "tv": to_tradingview(t), "tv_interval": tv_interval, "snapshot": snap})
    except Exception as e:
        return jsonify({"ok": False, "ticker": t, "error": str(e)})


@app.route("/api/news")
def api_news():
    t = sanitize_ticker(request.args.get("ticker", ""))
    if not t:
        return jsonify({"ok": False, "error": "símbolo inválido"}), 400
    try:
        import yfinance as yf
        raw = yf.Ticker(t).news or []
        articles = []
        for item in raw[:5]:
            ct = item.get("content", {})
            if ct:
                title = ct.get("title", "")
                publisher = ct.get("provider", {}).get("displayName", "")
                url = ct.get("canonicalUrl", {}).get("url", "")
                pub_date = ct.get("pubDate", "")
            else:
                title = item.get("title", "")
                publisher = item.get("publisher", "")
                url = item.get("link", "")
                pub_date = item.get("providerPublishTime", "")
            if title and url:
                articles.append({"title": title, "publisher": publisher,
                                  "url": url, "date": pub_date})
        return jsonify({"ok": True, "ticker": t, "news": articles})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/verdict_one", methods=["POST"])
@login_required
def api_verdict_one():
    t = sanitize_ticker(request.args.get("ticker", ""))
    if not t:
        return jsonify({"error": "símbolo inválido"}), 400
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return jsonify({"error": "Falta ANTHROPIC_API_KEY en el .env"}), 400

    today = date.today().isoformat()
    cache_fp = CACHE_DIR / f"one_{_safe_name(t)}_{today}.json"
    if cache_fp.exists():
        return jsonify(json.loads(cache_fp.read_text(encoding="utf-8")))

    import analyze
    try:
        df = data.descargar(t, config.INTERVAL, config.PERIOD)
        snap = indicators.construir_snapshot(df)
        texto = analyze.analizar(t, snap, config.PERFIL_RIESGO, config.AI_MODEL)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    payload = {"ticker": t, "generado": datetime.now().isoformat(timespec="seconds"),
               "veredicto": texto}
    cache_fp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return jsonify(payload)


@app.route("/api/verdict", methods=["POST"])
@login_required
def api_verdict():
    today = date.today().isoformat()
    cache_fp = CACHE_DIR / f"verdict_{today}.json"
    if cache_fp.exists():
        return jsonify(json.loads(cache_fp.read_text(encoding="utf-8")))
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return jsonify({"error": "Falta ANTHROPIC_API_KEY en el .env"}), 400

    import analyze
    result = {}
    for t in config.TICKERS:
        try:
            df = data.descargar(t, config.INTERVAL, config.PERIOD)
            snap = indicators.construir_snapshot(df)
            result[t] = analyze.analizar(t, snap, config.PERFIL_RIESGO, config.AI_MODEL)
        except Exception as e:
            result[t] = f"**Error:** {e}"

    payload = {"fecha": today, "generado": datetime.now().isoformat(timespec="seconds"),
               "veredictos": result}
    cache_fp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return jsonify(payload)


@app.route("/api/verdict", methods=["GET"])
def api_verdict_get():
    today = date.today().isoformat()
    cache_fp = CACHE_DIR / f"verdict_{today}.json"
    if cache_fp.exists():
        return jsonify(json.loads(cache_fp.read_text(encoding="utf-8")))
    return jsonify({"veredictos": {}, "fecha": today})


@app.route("/compare")
def compare_view():
    a = sanitize_ticker(request.args.get("a", ""))
    b = sanitize_ticker(request.args.get("b", ""))
    return render_template("compare.html", a=a, b=b)


@app.route("/heatmap")
def heatmap():
    return render_template("heatmap.html",
                           tickers=config.TICKERS,
                           nombres=getattr(config, "NOMBRES", {}))


@app.route("/guia")
def guia():
    return render_template("guia.html")


@app.route("/quantbay")
def quantbay():
    return render_template("quantbay.html")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
