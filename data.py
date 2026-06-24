"""
Descarga de datos de mercado (OHLCV) via Yahoo Finance.
No requiere API key.
"""
import pandas as pd
import yfinance as yf


def descargar(ticker: str, interval: str = "1d", period: str = "1y") -> pd.DataFrame:
    """
    Baja velas OHLCV para un ticker.
    Devuelve un DataFrame con columnas: Open, High, Low, Close, Volume
    e indice de fechas.
    """
    df = yf.download(
        ticker,
        interval=interval,
        period=period,
        auto_adjust=True,
        progress=False,
    )

    if df is None or df.empty:
        raise ValueError(
            f"No se obtuvieron datos para '{ticker}'. "
            "Revisa el simbolo (formato Yahoo Finance) o tu conexion."
        )

    # yfinance a veces devuelve columnas multi-nivel; las aplanamos.
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    df = df[["Open", "High", "Low", "Close", "Volume"]].dropna()
    return df
