"""La lista de puesta en marcha (`docs/puesta-en-marcha-datos.md`) nombra todo lo que hay que configurar: si el código empieza a leer
una variable nueva y la lista no la nombra, esta prueba falla."""
import re
import unittest
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
LISTA = RAIZ / "docs" / "puesta-en-marcha-datos.md"


class PuestaEnMarchaTests(unittest.TestCase):
    def setUp(self):
        self.lista = LISTA.read_text(encoding="utf-8")

    def test_nombra_cada_variable_que_leen_las_edge_functions(self):
        leidas = set()
        for ruta in (RAIZ / "supabase" / "functions").rglob("*.ts"):
            if "_vendor" in ruta.parts or ruta.name.endswith("_test.ts"):
                continue
            texto = ruta.read_text(encoding="utf-8")
            leidas |= set(re.findall(r'Deno\.env\.get\("([A-Z0-9_]+)"\)', texto)) | set(re.findall(r"\benv\.([A-Z][A-Z0-9_]+)\b", texto))
        self.assertGreaterEqual(leidas, {"DATOS_CLAVE_CRON", "DATOS_DATABASE_URL", "DATOS_AVISOS_DISCORD_URL", "ANTHROPIC_API_KEY"})
        self.assertEqual(sorted(v for v in leidas if f"`{v}`" not in self.lista), [])

    def test_nombra_cada_secreto_y_variable_de_los_flujos_de_github(self):
        usadas = set()
        for flujo in ("respaldo-datos.yml", "exportar-datos.yml"):
            usadas |= set(re.findall(r"\$\{\{ (?:secrets|vars)\.([A-Z0-9_]+) \}\}", (RAIZ / ".github" / "workflows" / flujo).read_text(encoding="utf-8")))
        self.assertEqual(sorted(v for v in usadas if f"`{v}`" not in self.lista), [])

    def test_las_migraciones_que_pide_aplicar_son_las_que_hay(self):
        ultima = max(p.name[:4] for p in (RAIZ / "servicio_datos" / "migraciones").glob("*.sql"))
        self.assertIn(f"llega a `{ultima}`", self.lista)
