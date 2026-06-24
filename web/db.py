"""
Base de datos SQLite de la comunidad ChartBay.
Tablas: users, bots (fichas de estrategia), reviews (estrellas + comentario).
Sin dependencias externas (sqlite3 es de la librería estándar).
"""
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "chartbay.db"


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_conn()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users(
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at    TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bots(
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL,
            name        TEXT NOT NULL,
            market      TEXT,
            timeframe   TEXT,
            description TEXT,
            rules       TEXT,
            backtest    TEXT,
            created_at  TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS reviews(
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id     INTEGER NOT NULL,
            user_id    INTEGER NOT NULL,
            stars      INTEGER NOT NULL,
            comment    TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(bot_id)  REFERENCES bots(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        """
    )
    conn.commit()
    conn.close()
