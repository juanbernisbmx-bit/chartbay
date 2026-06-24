"""
Calculo de indicadores tecnicos para swing trading.
Implementado solo con pandas/numpy (sin librerias TA externas) para
maxima compatibilidad. Devuelve una "foto" estadistica del activo.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


# ----------------------- indicadores base -----------------------

def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / n, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / n, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9):
    macd_line = ema(close, fast) - ema(close, slow)
    signal_line = ema(macd_line, signal)
    hist = macd_line - signal_line
    return macd_line, signal_line, hist


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    high, low, close = df["High"], df["Low"], df["Close"]
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()


def bollinger(close: pd.Series, n: int = 20, k: float = 2.0):
    mid = sma(close, n)
    sd = close.rolling(n).std()
    upper = mid + k * sd
    lower = mid - k * sd
    return upper, mid, lower


def soporte_resistencia(df: pd.DataFrame, ventana: int = 20):
    """Pivotes simples: minimo y maximo recientes."""
    soporte = df["Low"].rolling(ventana).min().iloc[-1]
    resistencia = df["High"].rolling(ventana).max().iloc[-1]
    return float(soporte), float(resistencia)


# ----------------------- snapshot del mercado -----------------------

def _tendencia(c, e50, e200) -> str:
    if e50 > e200 and c > e50:
        return "alcista"
    if e50 < e200 and c < e50:
        return "bajista"
    return "lateral / indefinida"


def construir_snapshot(df: pd.DataFrame) -> dict:
    """
    Calcula todos los indicadores y devuelve un diccionario con la
    fotografia tecnica actual del activo (valores ya redondeados).
    """
    close = df["Close"]

    df = df.copy()
    df["EMA20"] = ema(close, 20)
    df["EMA50"] = ema(close, 50)
    df["EMA200"] = ema(close, 200)
    df["RSI14"] = rsi(close, 14)
    macd_line, signal_line, hist = macd(close)
    df["MACD"], df["MACD_signal"], df["MACD_hist"] = macd_line, signal_line, hist
    df["ATR14"] = atr(df, 14)
    bb_up, bb_mid, bb_low = bollinger(close, 20, 2.0)
    df["BB_up"], df["BB_mid"], df["BB_low"] = bb_up, bb_mid, bb_low

    last = df.iloc[-1]
    prev = df.iloc[-2]
    c = float(last["Close"])

    soporte, resistencia = soporte_resistencia(df, 20)
    atr_val = float(last["ATR14"])

    # Posicion dentro de las bandas de Bollinger (0 = banda baja, 1 = banda alta)
    bb_pos = (c - last["BB_low"]) / (last["BB_up"] - last["BB_low"]) \
        if (last["BB_up"] - last["BB_low"]) else np.nan

    # Variaciones
    chg_1d = (c / float(prev["Close"]) - 1) * 100
    chg_5d = (c / float(df["Close"].iloc[-6]) - 1) * 100 if len(df) > 6 else np.nan
    chg_20d = (c / float(df["Close"].iloc[-21]) - 1) * 100 if len(df) > 21 else np.nan

    # Volumen relativo
    vol_med20 = float(df["Volume"].rolling(20).mean().iloc[-1])
    vol_rel = float(last["Volume"]) / vol_med20 if vol_med20 else np.nan

    def r(x, d=2):
        return round(float(x), d) if pd.notna(x) else None

    return {
        "precio": r(c),
        "fecha": str(df.index[-1].date()),
        "tendencia": _tendencia(c, float(last["EMA50"]), float(last["EMA200"])),
        "variacion_pct": {"1d": r(chg_1d), "5d": r(chg_5d), "20d": r(chg_20d)},
        "medias": {
            "EMA20": r(last["EMA20"]),
            "EMA50": r(last["EMA50"]),
            "EMA200": r(last["EMA200"]),
            "precio_vs_EMA50_pct": r((c / float(last["EMA50"]) - 1) * 100),
            "precio_vs_EMA200_pct": r((c / float(last["EMA200"]) - 1) * 100),
        },
        "RSI14": r(last["RSI14"]),
        "MACD": {
            "macd": r(last["MACD"], 4),
            "signal": r(last["MACD_signal"], 4),
            "histograma": r(last["MACD_hist"], 4),
            "cruce_reciente": _cruce_macd(df),
        },
        "ATR14": r(atr_val),
        "ATR_pct_precio": r(atr_val / c * 100),
        "bollinger": {
            "superior": r(last["BB_up"]),
            "media": r(last["BB_mid"]),
            "inferior": r(last["BB_low"]),
            "posicion_0a1": r(bb_pos),
        },
        "soporte_20": r(soporte),
        "resistencia_20": r(resistencia),
        "dist_soporte_pct": r((c / soporte - 1) * 100),
        "dist_resistencia_pct": r((resistencia / c - 1) * 100),
        "volumen_relativo_vs_media20": r(vol_rel),
    }


def _cruce_macd(df: pd.DataFrame, lookback: int = 3) -> str:
    """Detecta cruce alcista/bajista del MACD en las ultimas velas."""
    h = df["MACD_hist"].tail(lookback + 1).values
    if len(h) < 2:
        return "ninguno"
    if h[-2] < 0 <= h[-1]:
        return "alcista (cruce arriba)"
    if h[-2] > 0 >= h[-1]:
        return "bajista (cruce abajo)"
    return "ninguno"
