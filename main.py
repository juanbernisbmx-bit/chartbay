"""
Pipeline de analisis tecnico con IA para swing trading (acciones / indices).

Flujo:
  1. Baja datos OHLCV de cada ticker (Yahoo Finance).
  2. Calcula la foto tecnica (indicadores).
  3. La IA (Claude) hace el analisis frio y el veredicto.
  4. Guarda un informe Markdown por ejecucion.

Uso:
    python main.py                 # usa los tickers de config.py
    python main.py AAPL NVDA       # analiza solo esos tickers
"""
import sys
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

import config
import data
import indicators
import analyze

load_dotenv()


def analizar_ticker(ticker: str) -> str:
    df = data.descargar(ticker, config.INTERVAL, config.PERIOD)
    snapshot = indicators.construir_snapshot(df)
    analisis = analyze.analizar(ticker, snapshot, config.PERFIL_RIESGO, config.AI_MODEL)

    cabecera = (
        f"# {ticker} — Analisis tecnico (swing)\n"
        f"_Precio: {snapshot['precio']} | Fecha dato: {snapshot['fecha']} | "
        f"Tendencia: {snapshot['tendencia']}_\n\n"
    )
    return cabecera + analisis + "\n\n---\n"


def main():
    tickers = sys.argv[1:] or config.TICKERS

    out_dir = Path(config.OUTPUT_DIR)
    out_dir.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d_%H%M")
    out_file = out_dir / f"analisis_{stamp}.md"

    secciones = [f"# Informe tecnico IA — {stamp}\n"]

    for t in tickers:
        print(f"Analizando {t}...")
        try:
            secciones.append(analizar_ticker(t))
        except Exception as e:
            print(f"  ! Error con {t}: {e}")
            secciones.append(f"# {t}\n\n**Error:** {e}\n\n---\n")

    out_file.write_text("\n".join(secciones), encoding="utf-8")
    print(f"\nInforme guardado en: {out_file.resolve()}")


if __name__ == "__main__":
    main()
