"""Comprueba que el esquema admite el catálogo y el IPC del piloto local.

El test simula una publicación dentro de un schema descartable. No implementa
la aprobación ni el publicador, que siguen pendientes en el servicio de datos.
"""
import hashlib
import json
import os
import unittest
import uuid
from decimal import Decimal
from pathlib import Path

import psycopg

from servicio_datos import migrar


ROOT = Path(__file__).resolve().parents[2]
SNAPSHOT = ROOT / "datasets" / "economia" / "catalogo.json"
URL = os.environ.get("DATOS_TEST_DATABASE_URL")


@unittest.skipUnless(URL and SNAPSHOT.is_file(), "Falta DATOS_TEST_DATABASE_URL o el catálogo local")
class ContratoPilotoTests(unittest.TestCase):
    def test_catalogo_y_observaciones_caben_sin_perder_precision(self):
        payload = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
        self.assertEqual(len(payload["series"]), 100)
        self.assertEqual(sum(s["count"] for s in payload["series"]), 819)

        schema = "t_piloto_" + uuid.uuid4().hex[:12]
        with psycopg.connect(URL, autocommit=True) as conn:
            conn.execute(f"CREATE SCHEMA {schema}")
            try:
                conn.execute(f"SET search_path TO {schema}, public")
                migrar.aplicar(conn)

                sources = {series["source_id"]: series["source"] for series in payload["series"]}
                for source_id, name in sources.items():
                    conn.execute("INSERT INTO fuente (id, nombre) VALUES (%s, %s)", (source_id, name))

                for series in payload["series"]:
                    conn.execute(
                        "INSERT INTO serie (id, fuente_id, nombre, tema, nivel, territorio, "
                        "clasificacion, frecuencia, unidad, base, hoja_origen, fila_origen) "
                        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                        (series["id"], series["source_id"], series["name"], series["topic"],
                         series["level"], series["territory"], series["classification"],
                         series["frequency"], series["unit"], series["basis"],
                         series["sheet"], series["source_row"]),
                    )

                corrida = conn.execute(
                    "INSERT INTO corrida (fuente_id, estado, terminada_en) "
                    "VALUES ('INDEC_IPC', 'con_candidato', now()) RETURNING id"
                ).fetchone()[0]
                candidato = conn.execute(
                    "INSERT INTO candidato (corrida_id) VALUES (%s) RETURNING id", (corrida,)
                ).fetchone()[0]
                points = [(candidato, series["id"], point["date"], Decimal(str(point["value"])))
                          for series in payload["series"] for point in series["observations"]]
                with conn.cursor() as cursor:
                    cursor.executemany(
                        "INSERT INTO observacion_candidata (candidato_id, serie_id, periodo, valor) "
                        "VALUES (%s, %s, %s, %s)", points,
                    )
                self.assertEqual(conn.execute("SELECT count(*) FROM serie").fetchone()[0], 100)
                self.assertEqual(conn.execute("SELECT count(*) FROM observacion_candidata").fetchone()[0], 819)

                conn.execute(
                    "UPDATE candidato SET estado = 'publicado', decidido_en = now(), "
                    "decidido_por = 'test' WHERE id = %s", (candidato,),
                )
                release = conn.execute(
                    "INSERT INTO release (release_id, candidato_id, aprobado_por, hash_contenido) "
                    "VALUES (%s, %s, 'test', %s) RETURNING numero",
                    (payload["release_id"], candidato, hashlib.sha256(SNAPSHOT.read_bytes()).hexdigest()),
                ).fetchone()[0]
                conn.execute(
                    "INSERT INTO observacion (serie_id, periodo, valor, release_desde) "
                    "SELECT serie_id, periodo, valor, %s FROM observacion_candidata WHERE candidato_id = %s",
                    (release, candidato),
                )
                self.assertEqual(conn.execute("SELECT count(*) FROM observacion_vigente").fetchone()[0], 819)

                national = next(series for series in payload["series"] if series["id"] == "ipc_ng_nacional")
                last = national["observations"][-1]
                stored = conn.execute(
                    "SELECT valor FROM observacion_vigente WHERE serie_id = %s AND periodo = %s",
                    (national["id"], last["date"]),
                ).fetchone()[0]
                self.assertEqual(stored, Decimal(str(last["value"])))
            finally:
                conn.execute(f"DROP SCHEMA {schema} CASCADE")


if __name__ == "__main__":
    unittest.main()
