"""
Configuracion de The Chart Bay.
Edita esta seccion segun tus necesidades.
"""

# ------------------------------------------------------------------
# Activos a analizar. Usa simbolos de Yahoo Finance.
#   Acciones: "AAPL", "MSFT", "NVDA"...
#   Indices:  "^GSPC" (S&P500), "^IXIC" (Nasdaq), "^DJI" (Dow), "^RUT" (Russell)
#   ETFs:     "SPY", "QQQ", "DIA", "IWM"
#   Cripto:   "BTC-USD", "ETH-USD", "SOL-USD"
# Para AGREGAR un activo: anade su simbolo Yahoo aqui y, si quieres su grafico
# de TradingView, anade el equivalente en TRADINGVIEW (mas abajo).
# ------------------------------------------------------------------
TICKERS = [
    # Acciones grandes EEUU
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA",
    # Indices principales
    "^GSPC", "^IXIC", "^DJI",
    # ETFs populares
    "SPY", "QQQ", "DIA", "IWM",
    # Cripto
    "BTC-USD", "ETH-USD", "SOL-USD",
]

# Mapa: simbolo Yahoo -> simbolo en formato TradingView (para el widget visual).
# Formato TradingView: "BOLSA:SIMBOLO". Si un activo no esta aqui, su tarjeta
# mostrara igual los indicadores, solo que sin el grafico embebido.
TRADINGVIEW = {
    "AAPL": "NASDAQ:AAPL",
    "MSFT": "NASDAQ:MSFT",
    "NVDA": "NASDAQ:NVDA",
    "AMZN": "NASDAQ:AMZN",
    "GOOGL": "NASDAQ:GOOGL",
    "META": "NASDAQ:META",
    "TSLA": "NASDAQ:TSLA",
    "^GSPC": "TVC:SPX",
    "^IXIC": "TVC:IXIC",
    "^DJI": "TVC:DJI",
    "^RUT": "TVC:RUT",
    "SPY": "AMEX:SPY",
    "QQQ": "NASDAQ:QQQ",
    "DIA": "AMEX:DIA",
    "IWM": "AMEX:IWM",
    "BTC-USD": "COINBASE:BTCUSD",
    "ETH-USD": "COINBASE:ETHUSD",
    "SOL-USD": "COINBASE:SOLUSD",
    "GC=F": "TVC:GOLD",
    "EURUSD=X": "FX:EURUSD",
}

# Nombres "bonitos" opcionales para mostrar en las tarjetas.
NOMBRES = {
    "^GSPC": "S&P 500",
    "^IXIC": "Nasdaq Composite",
    "^DJI": "Dow Jones",
    "^RUT": "Russell 2000",
    "BTC-USD": "Bitcoin",
    "ETH-USD": "Ethereum",
    "SOL-USD": "Solana",
    "GC=F": "Oro",
    "EURUSD=X": "Euro / Dólar",
    "^IXIC": "Nasdaq",
}

# Temporalidad e historico (swing en diario por defecto).
INTERVAL = "1d"
PERIOD = "1y"

# Modelo de Claude para el veredicto IA.
AI_MODEL = "claude-opus-4-8"

# Carpeta de informes.
OUTPUT_DIR = "informes"

# Perfil de riesgo: "conservador" | "moderado" | "agresivo"
PERFIL_RIESGO = "moderado"
