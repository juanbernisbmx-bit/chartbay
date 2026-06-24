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


def stochastic(df: pd.DataFrame, k: int = 14, d: int = 3):
    """Oscilador Estocástico %K y %D."""
    low_min = df["Low"].rolling(k).min()
    high_max = df["High"].rolling(k).max()
    rng = high_max - low_min
    pct_k = 100 * (df["Close"] - low_min) / rng.replace(0, np.nan)
    pct_d = pct_k.rolling(d).mean()
    return pct_k, pct_d


def calc_obv(df: pd.DataFrame) -> pd.Series:
    """On-Balance Volume."""
    direction = np.sign(df["Close"].diff()).fillna(0)
    return (direction * df["Volume"]).cumsum()


def ichimoku_snapshot(df: pd.DataFrame):
    """
    Tenkan y Kijun actuales; Span A y B de la nube presente
    (calculados hace 26 barras = nube en la fecha actual).
    """
    high, low = df["High"], df["Low"]
    tenkan = (high.rolling(9).max() + low.rolling(9).min()) / 2
    kijun  = (high.rolling(26).max() + low.rolling(26).min()) / 2

    if len(df) < 27:
        return float(tenkan.iloc[-1]), float(kijun.iloc[-1]), np.nan, np.nan

    span_a_now = float((tenkan.iloc[-27] + kijun.iloc[-27]) / 2)

    if len(df) >= 79:
        span_b_now = float(
            (high.rolling(52).max().iloc[-27] + low.rolling(52).min().iloc[-27]) / 2
        )
    else:
        span_b_now = np.nan

    return float(tenkan.iloc[-1]), float(kijun.iloc[-1]), span_a_now, span_b_now


def fibonacci_levels(df: pd.DataFrame, lookback: int = 100) -> dict:
    """Retroceso de Fibonacci sobre el swing alto/bajo reciente."""
    recent = df.tail(min(lookback, len(df)))
    swing_high = float(recent["High"].max())
    swing_low  = float(recent["Low"].min())
    diff = swing_high - swing_low
    levels = {
        str(r): round(swing_high - diff * r, 4)
        for r in [0.236, 0.382, 0.5, 0.618, 0.786]
    }
    return {
        "swing_high": round(swing_high, 4),
        "swing_low":  round(swing_low, 4),
        "levels": levels,
    }


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
    df["EMA20"]  = ema(close, 20)
    df["EMA50"]  = ema(close, 50)
    df["EMA200"] = ema(close, 200)
    df["RSI14"]  = rsi(close, 14)
    macd_line, signal_line, hist = macd(close)
    df["MACD"], df["MACD_signal"], df["MACD_hist"] = macd_line, signal_line, hist
    df["ATR14"] = atr(df, 14)
    bb_up, bb_mid, bb_low = bollinger(close, 20, 2.0)
    df["BB_up"], df["BB_mid"], df["BB_low"] = bb_up, bb_mid, bb_low

    pct_k, pct_d = stochastic(df, 14, 3)
    df["STOCH_K"] = pct_k
    df["STOCH_D"] = pct_d
    df["OBV"] = calc_obv(df)

    last = df.iloc[-1]
    prev = df.iloc[-2]
    c = float(last["Close"])

    soporte, resistencia = soporte_resistencia(df, 20)
    atr_val = float(last["ATR14"])

    bb_pos = (c - last["BB_low"]) / (last["BB_up"] - last["BB_low"]) \
        if (last["BB_up"] - last["BB_low"]) else np.nan

    chg_1d  = (c / float(prev["Close"]) - 1) * 100
    chg_5d  = (c / float(df["Close"].iloc[-6])  - 1) * 100 if len(df) > 6  else np.nan
    chg_20d = (c / float(df["Close"].iloc[-21]) - 1) * 100 if len(df) > 21 else np.nan

    vol_med20 = float(df["Volume"].rolling(20).mean().iloc[-1])
    vol_rel   = float(last["Volume"]) / vol_med20 if vol_med20 else np.nan

    # OBV tendencia vs 10 barras atrás
    obv_now   = float(df["OBV"].iloc[-1])
    obv_10    = float(df["OBV"].iloc[-11]) if len(df) > 11 else np.nan
    obv_trend = "subiendo" if (pd.notna(obv_10) and obv_now > obv_10) else "bajando"

    # Ichimoku
    tenkan, kijun, span_a, span_b = ichimoku_snapshot(df)
    if pd.notna(span_a) and pd.notna(span_b):
        nube_sup = max(span_a, span_b)
        nube_inf = min(span_a, span_b)
        if c > nube_sup:
            precio_vs_nube = "sobre la nube"
        elif c < nube_inf:
            precio_vs_nube = "bajo la nube"
        else:
            precio_vs_nube = "dentro de la nube"
    elif pd.notna(span_a):
        precio_vs_nube = "sobre la nube" if c > span_a else "bajo la nube"
    else:
        precio_vs_nube = "datos insuficientes"

    fib = fibonacci_levels(df, lookback=100)

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
            "precio_vs_EMA50_pct":  r((c / float(last["EMA50"])  - 1) * 100),
            "precio_vs_EMA200_pct": r((c / float(last["EMA200"]) - 1) * 100),
        },
        "RSI14": r(last["RSI14"]),
        "MACD": {
            "macd":           r(last["MACD"], 4),
            "signal":         r(last["MACD_signal"], 4),
            "histograma":     r(last["MACD_hist"], 4),
            "cruce_reciente": _cruce_macd(df),
        },
        "ATR14":            r(atr_val),
        "ATR_pct_precio":   r(atr_val / c * 100),
        "bollinger": {
            "superior":      r(last["BB_up"]),
            "media":         r(last["BB_mid"]),
            "inferior":      r(last["BB_low"]),
            "posicion_0a1":  r(bb_pos),
        },
        "soporte_20":               r(soporte),
        "resistencia_20":           r(resistencia),
        "dist_soporte_pct":         r((c / soporte - 1) * 100),
        "dist_resistencia_pct":     r((resistencia / c - 1) * 100),
        "volumen_relativo_vs_media20": r(vol_rel),
        "estocastico": {
            "K": r(last["STOCH_K"]),
            "D": r(last["STOCH_D"]),
        },
        "OBV_tendencia": obv_trend,
        "ichimoku": {
            "tenkan":         r(tenkan),
            "kijun":          r(kijun),
            "span_a_actual":  r(span_a),
            "span_b_actual":  r(span_b),
            "precio_vs_nube": precio_vs_nube,
        },
        "fibonacci": fib,
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
