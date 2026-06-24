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
sys.path.insert(0, str(ROOT))
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


# ----------------------------- arranque BD -----------------------------

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

db.init_db()
seed_owner()


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
@login_required
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
@login_required
def reports():
    files = []
    if REPORTS_DIR.exists():
        files = sorted([p.name for p in REPORTS_DIR.glob("*.md")], reverse=True)
    return render_template("reports.html", files=files)


@app.route("/reports/<path:name>")
@login_required
def report_view(name):
    if not name.endswith(".md") or "/" in name or "\\" in name:
        abort(404)
    fp = REPORTS_DIR / name
    if not fp.exists():
        abort(404)
    return render_template("report.html", name=name, content=fp.read_text(encoding="utf-8"))


# --------------------------- comunidad ---------------------------

@app.route("/community")
@login_required
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
@login_required
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
@login_required
def api_snapshot():
    t = request.args.get("ticker", "").strip()
    if t not in config.TICKERS:
        return jsonify({"ok": False, "error": "ticker no permitido"}), 400
    return _snapshot_response(t)


@app.route("/api/lookup")
@login_required
def api_lookup():
    t = sanitize_ticker(request.args.get("ticker", ""))
    if not t:
        return jsonify({"ok": False, "error": "símbolo inválido"}), 400
    return _snapshot_response(t)


def _snapshot_response(t: str):
    try:
        df = data.descargar(t, config.INTERVAL, config.PERIOD)
        snap = indicators.construir_snapshot(df)
        nombre = getattr(config, "NOMBRES", {}).get(t, t)
        return jsonify({"ok": True, "ticker": t, "nombre": nombre,
                        "tv": to_tradingview(t), "snapshot": snap})
    except Exception as e:
        return jsonify({"ok": False, "ticker": t, "error": str(e)})


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
@login_required
def api_verdict_get():
    today = date.today().isoformat()
    cache_fp = CACHE_DIR / f"verdict_{today}.json"
    if cache_fp.exists():
        return jsonify(json.loads(cache_fp.read_text(encoding="utf-8")))
    return jsonify({"veredictos": {}, "fecha": today})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
