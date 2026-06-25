"""
Catálogo curado de 'Datos Frecuentes': los indicadores macro que el usuario
ve y descarga con un clic.

Cada entrada apunta a un proveedor + series_id de la fuente. El frontend NO
ve estos detalles (ver `catalog_public`): para el usuario, descargar datos es
tan simple como buscar una canción.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Indicator:
    id: str            # slug estable usado en URLs y caché: [a-z0-9_]
    name: str
    category: str      # id de categoría (ver CATEGORIES)
    country: str
    frequency: str     # etiqueta canónica: Diaria, Semanal, Mensual, Trimestral, Anual
    provider: str      # code del proveedor ('fred', ...)
    series_id: str     # id en la fuente
    units: str = ""


CATEGORIES = [
    {"id": "inflacion", "label": "Inflación"},
    {"id": "tasas", "label": "Tasas de interés"},
    {"id": "fx", "label": "Tipo de cambio"},
    {"id": "pbi", "label": "PBI"},
    {"id": "desempleo", "label": "Desempleo"},
    {"id": "dinero", "label": "Dinero / Base monetaria"},
    {"id": "commodities", "label": "Commodities"},
    {"id": "indices", "label": "Índices"},
]

CATALOG: list[Indicator] = [
    # ── Inflación ────────────────────────────────────────────────────────────
    Indicator("us_cpi", "IPC general (CPI)", "inflacion", "Estados Unidos", "Mensual", "fred", "CPIAUCSL", "Índice 1982-84=100"),
    Indicator("us_core_cpi", "IPC núcleo (Core CPI)", "inflacion", "Estados Unidos", "Mensual", "fred", "CPILFESL", "Índice 1982-84=100"),
    Indicator("us_pce", "Inflación PCE", "inflacion", "Estados Unidos", "Mensual", "fred", "PCEPI", "Índice 2017=100"),
    Indicator("us_breakeven_10y", "Inflación esperada 10 años", "inflacion", "Estados Unidos", "Diaria", "fred", "T10YIE", "%"),
    Indicator("ez_hicp", "IPC armonizado (HICP)", "inflacion", "Eurozona", "Mensual", "fred", "CP0000EZ19M086NEST", "Índice 2015=100"),

    # ── Tasas de interés ─────────────────────────────────────────────────────
    Indicator("us_fed_funds", "Tasa de fondos federales", "tasas", "Estados Unidos", "Mensual", "fred", "FEDFUNDS", "%"),
    Indicator("us_sofr", "SOFR", "tasas", "Estados Unidos", "Diaria", "fred", "SOFR", "%"),
    Indicator("us_2y", "Tesoro a 2 años", "tasas", "Estados Unidos", "Diaria", "fred", "DGS2", "%"),
    Indicator("us_10y", "Tesoro a 10 años", "tasas", "Estados Unidos", "Diaria", "fred", "DGS10", "%"),
    Indicator("us_3m", "Letra del Tesoro a 3 meses", "tasas", "Estados Unidos", "Diaria", "fred", "DGS3MO", "%"),
    Indicator("us_mortgage30", "Hipoteca fija a 30 años", "tasas", "Estados Unidos", "Semanal", "fred", "MORTGAGE30US", "%"),

    # ── Tipo de cambio ───────────────────────────────────────────────────────
    Indicator("usd_eur", "Dólar por Euro", "fx", "Estados Unidos", "Diaria", "fred", "DEXUSEU", "USD/EUR"),
    Indicator("jpy_usd", "Yen por Dólar", "fx", "Japón", "Diaria", "fred", "DEXJPUS", "JPY/USD"),
    Indicator("cny_usd", "Yuan por Dólar", "fx", "China", "Diaria", "fred", "DEXCHUS", "CNY/USD"),
    Indicator("mxn_usd", "Peso mexicano por Dólar", "fx", "México", "Diaria", "fred", "DEXMXUS", "MXN/USD"),
    Indicator("brl_usd", "Real por Dólar", "fx", "Brasil", "Diaria", "fred", "DEXBZUS", "BRL/USD"),
    Indicator("dxy_broad", "Índice Dólar (amplio)", "fx", "Estados Unidos", "Diaria", "fred", "DTWEXBGS", "Índice"),

    # ── PBI ──────────────────────────────────────────────────────────────────
    Indicator("us_gdp", "PBI nominal", "pbi", "Estados Unidos", "Trimestral", "fred", "GDP", "Miles de millones USD"),
    Indicator("us_real_gdp", "PBI real", "pbi", "Estados Unidos", "Trimestral", "fred", "GDPC1", "Miles de millones USD (2017)"),
    Indicator("us_gdp_growth", "Crecimiento del PBI real (anualizado)", "pbi", "Estados Unidos", "Trimestral", "fred", "A191RL1Q225SBEA", "%"),

    # ── Desempleo ────────────────────────────────────────────────────────────
    Indicator("us_unrate", "Tasa de desempleo", "desempleo", "Estados Unidos", "Mensual", "fred", "UNRATE", "%"),
    Indicator("us_payrolls", "Nóminas no agrícolas (NFP)", "desempleo", "Estados Unidos", "Mensual", "fred", "PAYEMS", "Miles de empleos"),
    Indicator("us_claims", "Pedidos iniciales de subsidio", "desempleo", "Estados Unidos", "Semanal", "fred", "ICSA", "Personas"),
    Indicator("us_participation", "Tasa de participación laboral", "desempleo", "Estados Unidos", "Mensual", "fred", "CIVPART", "%"),

    # ── Dinero / Base monetaria ──────────────────────────────────────────────
    Indicator("us_m2", "M2", "dinero", "Estados Unidos", "Mensual", "fred", "M2SL", "Miles de millones USD"),
    Indicator("us_m1", "M1", "dinero", "Estados Unidos", "Mensual", "fred", "M1SL", "Miles de millones USD"),
    Indicator("us_base", "Base monetaria", "dinero", "Estados Unidos", "Mensual", "fred", "BOGMBASE", "Miles de millones USD"),
    Indicator("fed_assets", "Balance de la Fed (activos)", "dinero", "Estados Unidos", "Semanal", "fred", "WALCL", "Millones USD"),

    # ── Commodities ──────────────────────────────────────────────────────────
    Indicator("wti", "Petróleo WTI", "commodities", "Global", "Diaria", "fred", "DCOILWTICO", "USD/barril"),
    Indicator("brent", "Petróleo Brent", "commodities", "Global", "Diaria", "fred", "DCOILBRENTEU", "USD/barril"),
    Indicator("natgas", "Gas natural (Henry Hub)", "commodities", "Global", "Diaria", "fred", "DHHNGSP", "USD/MMBtu"),
    Indicator("copper", "Cobre (precio global)", "commodities", "Global", "Mensual", "fred", "PCOPPUSDM", "USD/tonelada"),
    Indicator("wheat", "Trigo (precio global)", "commodities", "Global", "Mensual", "fred", "PWHEAMTUSDM", "USD/tonelada"),

    # ── Índices ──────────────────────────────────────────────────────────────
    Indicator("sp500", "S&P 500", "indices", "Estados Unidos", "Diaria", "fred", "SP500", "Puntos"),
    Indicator("nasdaq", "NASDAQ Composite", "indices", "Estados Unidos", "Diaria", "fred", "NASDAQCOM", "Puntos"),
    Indicator("dow", "Dow Jones Industrial", "indices", "Estados Unidos", "Diaria", "fred", "DJIA", "Puntos"),
    Indicator("vix", "VIX (volatilidad)", "indices", "Estados Unidos", "Diaria", "fred", "VIXCLS", "Puntos"),

    # ── World Bank — datos internacionales (sin API key) ─────────────────────
    # Inflación
    Indicator("ar_cpi_wb", "Inflación anual", "inflacion", "Argentina", "Anual", "worldbank", "ARG/FP.CPI.TOTL.ZG", "%"),
    Indicator("br_cpi_wb", "Inflación anual", "inflacion", "Brasil", "Anual", "worldbank", "BRA/FP.CPI.TOTL.ZG", "%"),
    Indicator("cn_cpi_wb", "Inflación anual", "inflacion", "China", "Anual", "worldbank", "CHN/FP.CPI.TOTL.ZG", "%"),
    Indicator("de_cpi_wb", "Inflación anual", "inflacion", "Alemania", "Anual", "worldbank", "DEU/FP.CPI.TOTL.ZG", "%"),
    # PBI
    Indicator("cn_gdp_wb", "PBI nominal", "pbi", "China", "Anual", "worldbank", "CHN/NY.GDP.MKTP.CD", "USD corrientes"),
    Indicator("in_gdp_wb", "PBI nominal", "pbi", "India", "Anual", "worldbank", "IND/NY.GDP.MKTP.CD", "USD corrientes"),
    Indicator("br_gdp_wb", "PBI nominal", "pbi", "Brasil", "Anual", "worldbank", "BRA/NY.GDP.MKTP.CD", "USD corrientes"),
    Indicator("de_gdp_wb", "PBI nominal", "pbi", "Alemania", "Anual", "worldbank", "DEU/NY.GDP.MKTP.CD", "USD corrientes"),
    Indicator("ar_gdp_wb", "PBI nominal", "pbi", "Argentina", "Anual", "worldbank", "ARG/NY.GDP.MKTP.CD", "USD corrientes"),
    # Desempleo
    Indicator("ar_unrate_wb", "Tasa de desempleo", "desempleo", "Argentina", "Anual", "worldbank", "ARG/SL.UEM.TOTL.ZS", "%"),
    Indicator("br_unrate_wb", "Tasa de desempleo", "desempleo", "Brasil", "Anual", "worldbank", "BRA/SL.UEM.TOTL.ZS", "%"),
    Indicator("cn_unrate_wb", "Tasa de desempleo", "desempleo", "China", "Anual", "worldbank", "CHN/SL.UEM.TOTL.ZS", "%"),
]

_BY_ID: dict[str, Indicator] = {i.id: i for i in CATALOG}


def get_indicator(indicator_id: str) -> Indicator | None:
    return _BY_ID.get(indicator_id)


def catalog_public() -> list[dict]:
    """
    Versión que ve el frontend. A propósito NO incluye `provider` ni
    `series_id`: el usuario nunca necesita saber de dónde salen los datos.
    """
    return [
        {
            "id": i.id,
            "name": i.name,
            "category": i.category,
            "country": i.country,
            "frequency": i.frequency,
            "units": i.units,
        }
        for i in CATALOG
    ]
