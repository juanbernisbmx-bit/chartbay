"""
Tests de la lógica pura del paquete `providers` (sin red).

Se puede correr de dos formas:
    python tests/test_providers.py        # runner propio, sin dependencias
    pytest tests/test_providers.py        # si tenés pytest instalado
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import providers  # noqa: E402
from providers import fred as fred_mod  # noqa: E402
from providers import worldbank as wb_mod  # noqa: E402
from providers.base import Observation, Series  # noqa: E402
from providers.exporters import to_csv, to_json  # noqa: E402
from providers.normalize import normalize_observations, to_float, to_iso_date  # noqa: E402


# ── normalización ────────────────────────────────────────────────────────────

def test_iso_dates():
    assert to_iso_date("2020-01-01") == "2020-01-01"
    assert to_iso_date("01/02/2020") == "2020-02-01"  # d/m/Y
    assert to_iso_date("2020-03") == "2020-03-01"
    assert to_iso_date("basura") is None
    assert to_iso_date("") is None


def test_floats_and_missing():
    assert to_float("1.5") == 1.5
    assert to_float("1,234.5") == 1234.5
    assert to_float(".") is None
    assert to_float("NA") is None
    assert to_float("") is None


def test_normalize_drops_missing_and_sorts():
    rows = [
        {"date": "2020-03-01", "value": "."},      # faltante -> se descarta
        {"date": "2020-01-01", "value": "1.5"},
        {"date": "2020-02-01", "value": "2"},
        {"date": "fecha-mala", "value": "9"},       # fecha inválida -> se descarta
    ]
    obs = normalize_observations(rows)
    assert [o.date for o in obs] == ["2020-01-01", "2020-02-01"]
    assert obs[0].value == 1.5


# ── exportadores ─────────────────────────────────────────────────────────────

def _sample_series():
    return Series(
        name="IPC", country="Estados Unidos", frequency="Mensual",
        observations=[Observation("2020-01-01", 1.5), Observation("2020-02-01", 2.0)],
        source="FRED", series_id="CPIAUCSL", units="Índice",
    )


def test_csv_is_clean():
    csv = to_csv(_sample_series())
    rows = csv.split("\n")
    assert rows[0] == "date,value"             # encabezado limpio
    assert rows[1] == "2020-01-01,1.5"          # fecha ISO
    assert rows[2] == "2020-02-01,2"            # entero sin '.0'
    assert rows[-1] == ""                        # único salto final
    assert "" not in rows[:-1]                   # sin filas vacías intermedias


def test_json_shape():
    d = to_json(_sample_series())
    assert {"name", "country", "frequency", "observations"} <= set(d)
    assert d["last_updated"] == "2020-02-01"
    assert d["observations"][0] == {"date": "2020-01-01", "value": 1.5}


# ── catálogo y registro ──────────────────────────────────────────────────────

def test_catalog_integrity():
    import re
    ids = [i.id for i in providers.CATALOG]
    assert len(ids) == len(set(ids)), "hay ids duplicados en el catálogo"
    valid_cats = {c["id"] for c in providers.CATEGORIES}
    for i in providers.CATALOG:
        assert re.fullmatch(r"[a-z0-9_]+", i.id), f"id inválido: {i.id}"
        assert i.category in valid_cats, f"categoría desconocida: {i.category}"
        assert providers.get_provider(i.provider) is not None, f"proveedor sin registrar: {i.provider}"
        assert i.name and i.country and i.frequency


def test_provider_status():
    st = {s["code"]: s for s in providers.provider_status()}
    assert set(st) == {"fred", "bcra", "worldbank", "oecd", "imf"}
    assert st["bcra"]["implemented"] is False
    assert st["worldbank"]["implemented"] is True
    assert st["worldbank"]["requires_key"] is False
    assert st["fred"]["requires_key"] is True


# ── FRED con HTTP simulado (sin red real) ────────────────────────────────────

def _fake_get_json(url, params=None, timeout=20):
    if url.endswith("/series"):
        return {"seriess": [{
            "title": "Consumer Price Index", "frequency_short": "M",
            "frequency": "Monthly", "units": "Index 1982-84=100",
        }]}
    if url.endswith("/series/observations"):
        if params and params.get("limit") == 1:
            return {"observations": [{"date": "2024-05-01", "value": "311.0"}]}
        return {"observations": [
            {"date": "2024-01-01", "value": "300"},
            {"date": "2024-02-01", "value": "."},      # faltante
            {"date": "2024-03-01", "value": "305.5"},
        ]}
    raise AssertionError(f"URL inesperada en el test: {url}")


def test_fred_fetch_and_latest():
    prov = fred_mod.FredProvider(api_key="DUMMY")  # api_key explícita => available()
    orig = fred_mod.get_json
    fred_mod.get_json = _fake_get_json
    try:
        s = prov.fetch("CPIAUCSL", country="Estados Unidos", name="IPC general")
        assert s.name == "IPC general"
        assert s.country == "Estados Unidos"
        assert s.frequency == "Mensual"           # M -> Mensual
        assert s.source == "FRED"
        # el faltante ('.') quedó descartado y queda ordenado:
        assert [o.date for o in s.observations] == ["2024-01-01", "2024-03-01"]

        last = prov.latest("CPIAUCSL")
        assert last is not None and last.date == "2024-05-01" and last.value == 311.0
    finally:
        fred_mod.get_json = orig


# ── World Bank con HTTP simulado (sin red real) ──────────────────────────────

def _fake_wb_get_json(url, params=None, timeout=20):
    mrv = (params or {}).get("mrv")
    if mrv == "1":
        return [
            {"page": 1, "pages": 1, "per_page": 1, "total": 60, "lastupdated": "2024-12-01"},
            [{"indicator": {"id": "FP.CPI.TOTL.ZG"}, "date": "2023", "value": 211.4}],
        ]
    return [
        {"page": 1, "pages": 1, "per_page": 20000, "total": 3, "lastupdated": "2024-12-01"},
        [
            {"indicator": {"id": "FP.CPI.TOTL.ZG"}, "date": "2023", "value": 211.4},
            {"indicator": {"id": "FP.CPI.TOTL.ZG"}, "date": "2022", "value": 72.43},
            {"indicator": {"id": "FP.CPI.TOTL.ZG"}, "date": "2021", "value": None},   # faltante
        ],
    ]


def test_wb_date_conversion():
    assert wb_mod._wb_date_to_iso("2023") == "2023-01-01"
    assert wb_mod._wb_date_to_iso("2023Q1") == "2023-01-01"
    assert wb_mod._wb_date_to_iso("2023Q2") == "2023-04-01"
    assert wb_mod._wb_date_to_iso("2023Q3") == "2023-07-01"
    assert wb_mod._wb_date_to_iso("2023Q4") == "2023-10-01"
    assert wb_mod._wb_date_to_iso("2023M06") == "2023-06-01"


def test_wb_fetch_and_latest():
    prov = wb_mod.WorldBankProvider()
    orig = wb_mod.get_json
    wb_mod.get_json = _fake_wb_get_json
    try:
        s = prov.fetch("ARG/FP.CPI.TOTL.ZG", country="Argentina", name="Inflación anual")
        assert s.name == "Inflación anual"
        assert s.country == "Argentina"
        assert s.source == "World Bank"
        assert s.frequency == "Anual"
        # None (faltante) debe quedar descartado; resultado ordenado ascendente
        assert [o.date for o in s.observations] == ["2022-01-01", "2023-01-01"]
        assert s.observations[1].value == 211.4

        last = prov.latest("ARG/FP.CPI.TOTL.ZG")
        assert last is not None and last.date == "2023-01-01" and last.value == 211.4
    finally:
        wb_mod.get_json = orig


def test_wb_available_without_key():
    prov = wb_mod.WorldBankProvider()
    assert prov.available() is True   # no requiere key


def test_fred_without_key_raises():
    prov = fred_mod.FredProvider(api_key="")
    assert prov.available() is False
    try:
        prov.fetch("CPIAUCSL")
        raise AssertionError("debía fallar sin API key")
    except providers.ProviderError:
        pass


# ── runner propio (no requiere pytest) ───────────────────────────────────────

def _run():
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  FAIL  {t.__name__}: {e}")
    total = len(tests)
    print(f"\n{total - failed}/{total} tests OK")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    _run()
