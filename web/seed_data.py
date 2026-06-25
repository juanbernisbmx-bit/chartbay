"""
Datos semilla de bots de la comunidad ChartBay.
Se insertan al arrancar la app si no existen (idempotente).
"""

BOTS_BASE = [
    {
        "name": "AlgoBot v4.31 — BTC Tendencia",
        "market": "Cripto (BTC/USD)",
        "timeframe": "H4 (swing)",
        "description": (
            "Bot de tendencia multiestrategia para Bitcoin en 4 horas. "
            "Modo AUTO que elige estrategia segun el regimen de mercado (ADX): "
            "sigue tendencia con EMA o opera rangos con RSI. "
            "Sin grid ni martingala; siempre con stop real."
        ),
        "rules": (
            "Estrategias: AUTO / EMA crossover / RSI mean-reversion / MACD / Donchian / UT Bot. "
            "Regimen por ADX (alto=tendencia, bajo=rango). SL/TP fijo o por multiplos de ATR. "
            "Riesgo 1% por trade, breakeven, maxima perdida diaria 5%, filtro de spread."
        ),
        "backtest": (
            "Defaults validados en backtest 2022-2026 y simulacion out-of-sample 2017-2021. "
            "Aun asi: modelo base, testealo en demo."
        ),
    },
    {
        "name": "AlgoBot Scalper M5 — Breakout/ORB",
        "market": "Indices (NAS100)",
        "timeframe": "M5 (intradia)",
        "description": (
            "Scalper experimental de ruptura intradia para Nasdaq. "
            "Detecta consolidaciones estrechas y entra en la ruptura, "
            "o usa Opening Range Breakout (rango de apertura de sesion). "
            "Muy sensible a costos."
        ),
        "rules": (
            "Ruptura de rango (o ORB) + filtro de tendencia EMA50, "
            "filtro de regimen por exponente de Hurst (solo opera si H>0.55, mercado tendencial), "
            "horario de sesion USA y spread maximo. "
            "SL 1.5xATR, TP 2xATR, breakeven, salida por tiempo, corte de perdida diaria 3%."
        ),
        "backtest": (
            "Sin validar — proyecto de aprendizaje. "
            "El backtest DEBE correrse con spread y comision reales o no vale."
        ),
    },
    {
        "name": "Aggressive Grid Scalper — Cripto/Forex",
        "market": "Cripto / Forex",
        "timeframe": "M1 (scalping)",
        "description": (
            "Grid agresivo + scalping de alta frecuencia. "
            "Abre niveles en grilla con filtro de direccion por EMA y RSI, y regimen por ADX. "
            "ALTO RIESGO: un grid sin stop se rompe en tendencias fuertes."
        ),
        "rules": (
            "Grid con espaciado por ATR (paso = ATRx0.5), TP por nivel, "
            "filtro EMA9/EMA21 + RSI7 (sobrecompra 70 / sobreventa 30), regimen ADX (umbral 25). "
            "Sin martingala (multiplicador 1.0), max 20 posiciones, "
            "corte por equity y perdida diaria. Pensado para cuenta DEMO."
        ),
        "backtest": "Sin testear — modelo base de alto riesgo. Solo demo + Strategy Tester.",
    },
    {
        "name": "Aggressive Grid Scalper — Nasdaq",
        "market": "Indices (NAS100)",
        "timeframe": "M1 (scalping)",
        "description": (
            "Variante del grid scalper agresivo afinada para Nasdaq, "
            "con gestion de riesgo extra (stop por equity, perdida diaria, trailing opcional). "
            "Mismo motor de grilla + scalping. ALTO RIESGO."
        ),
        "rules": (
            "Grid por ATR + filtro EMA9/21 y RSI7, regimen ADX. "
            "Lote fijo o por % de riesgo. "
            "Cierra todo si la perdida flotante supera 20% del balance; "
            "limite de perdida diaria 10%; trailing opcional. Sin martingala. Pensado para DEMO."
        ),
        "backtest": "Sin testear — modelo base de alto riesgo. Solo demo + Strategy Tester.",
    },
]
