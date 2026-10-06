"""Almacén del crudo: contenido direccionado por hash, sin pisar nada."""
import hashlib
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from servicio_datos.crudo import AlmacenCrudo, ErrorCrudo


class AlmacenCrudoTests(unittest.TestCase):
    def setUp(self):
        self.carpeta = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.carpeta, ignore_errors=True)
        self.almacen = AlmacenCrudo(self.carpeta)

    def test_guarda_con_el_hash_como_nombre(self):
        sha256, relativa = self.almacen.guardar(b"hola")
        self.assertEqual(sha256, hashlib.sha256(b"hola").hexdigest())
        self.assertEqual(relativa, f"{sha256[:2]}/{sha256}.xls")
        self.assertEqual(self.almacen.ruta(relativa).read_bytes(), b"hola")

    def test_guardar_dos_veces_no_duplica(self):
        primero = self.almacen.guardar(b"mismo")
        segundo = self.almacen.guardar(b"mismo")
        self.assertEqual(primero, segundo)
        self.assertEqual(len([p for p in self.carpeta.rglob("*") if p.is_file()]), 1)

    def test_el_archivo_queda_de_solo_lectura_y_sin_temporales(self):
        _, relativa = self.almacen.guardar(b"datos")
        self.assertEqual(os.stat(self.almacen.ruta(relativa)).st_mode & 0o222, 0)
        self.assertEqual(list(self.carpeta.rglob("*.tmp")), [])

    def test_un_crudo_danado_no_se_acepta_en_silencio(self):
        _, relativa = self.almacen.guardar(b"original")
        destino = self.almacen.ruta(relativa)
        os.chmod(destino, 0o644)
        destino.write_bytes(b"adulterado")
        with self.assertRaises(ErrorCrudo):
            self.almacen.guardar(b"original")

    def test_no_sale_de_la_carpeta(self):
        for ruta in ("../fuera.xls", "/etc/passwd", "ab/../../fuera"):
            with self.assertRaises(ErrorCrudo):
                self.almacen.ruta(ruta)

    def test_ruta_de_algo_que_no_existe(self):
        with self.assertRaises(ErrorCrudo):
            self.almacen.ruta("ab/" + "0" * 64 + ".xls")

    def test_extension_invalida(self):
        for extension in ("xls", ".XLS", "/../x", ".muylarga"):
            with self.assertRaises(ErrorCrudo):
                self.almacen.guardar(b"x", extension)


if __name__ == "__main__":
    unittest.main()
