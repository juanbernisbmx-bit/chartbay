"""Lectura estricta del IPC con libros Excel sintéticos y originales optativos."""
import os
import unittest
from datetime import date
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import xlrd
from xlrd.xldate import xldate_from_datetime_tuple

from servicio_datos.ipc.fuente import ArchivoFuente, archivos
from servicio_datos.ipc.parser import ErrorParseo, leer_archivo


ARCHIVO = ArchivoFuente("nacional", "IPC", {"Total nacional": "ipc_ng_nacional"}, ("ejemplo.xls",))


def fecha(anio, mes, dia=1):
    return (xlrd.XL_CELL_DATE, xldate_from_datetime_tuple((anio, mes, dia, 0, 0, 0), 0))


def texto(valor):
    return (xlrd.XL_CELL_TEXT, valor)


def numero(valor):
    return (xlrd.XL_CELL_NUMBER, valor)


def libro(rows):
    class Hoja:
        nrows = len(rows)
        ncols = max(map(len, rows))

        def cell(self, row, column):
            tipo, valor = rows[row][column] if column < len(rows[row]) else (xlrd.XL_CELL_EMPTY, "")
            return SimpleNamespace(ctype=tipo, value=valor)

        def cell_value(self, row, column):
            return self.cell(row, column).value

    class Libro:
        datemode = 0

        def sheet_by_name(self, name):
            if name != ARCHIVO.hoja:
                raise xlrd.XLRDError("Hoja no encontrada")
            return Hoja()

    return Libro()


def filas(periodos=None, valores=None):
    periodos = periodos or [fecha(2016, 12), fecha(2017, 1), fecha(2017, 2)]
    valores = valores or [100, 101.5859, 103.7]
    return [
        [texto("Total nacional"), *periodos],
        [texto("Divisiones")],
        [texto("Nivel general"), *(numero(valor) for valor in valores)],
    ]


class ParserTests(unittest.TestCase):
    def leer(self, rows, archivo=ARCHIVO):
        with patch("servicio_datos.ipc.parser.xlrd.open_workbook", return_value=libro(rows)):
            return leer_archivo(Path("ejemplo.xls"), archivo)

    def test_extrae_periodos_decimales_y_fila_de_origen(self):
        leida = self.leer(filas())["ipc_ng_nacional"]
        self.assertEqual(leida.fila_origen, 3)
        self.assertEqual(leida.observaciones, (
            (date(2016, 12, 1), Decimal("100.0")),
            (date(2017, 1, 1), Decimal("101.5859")),
            (date(2017, 2, 1), Decimal("103.7")),
        ))

    def test_dia_distinto_del_primero_se_normaliza_con_nota(self):
        rows = filas([fecha(2016, 12), fecha(2017, 1, 26), fecha(2017, 2)])
        leida = self.leer(rows)["ipc_ng_nacional"]
        self.assertEqual(leida.observaciones[1][0], date(2017, 1, 1))
        self.assertIn("2017-01-26", leida.notas[0])

    def test_rechaza_estructura_ambigua_o_incompleta(self):
        casos = [
            (filas() + [[texto("")]] * 8 + filas(), "repetido"),
            (filas()[:2], "Nivel general"),
            ([filas()[0], filas()[2], filas()[2]], "encontradas: 2"),
            ([filas()[0][:1] + [texto("enero")], filas()[2]], "Encabezado"),
            ([filas()[0], [texto("Nivel regional")]], "Nivel general"),
        ]
        for rows, mensaje in casos:
            with self.subTest(mensaje=mensaje), self.assertRaisesRegex(ErrorParseo, mensaje):
                self.leer(rows)

    def test_rechaza_valores_invalidos(self):
        for invalido in [0, -1, float("nan"), float("inf")]:
            with self.subTest(valor=invalido), self.assertRaisesRegex(ErrorParseo, "no positivo"):
                self.leer(filas(valores=[100, invalido, 103]))
        rows = filas()
        rows[2][2] = texto("sin dato")
        with self.assertRaisesRegex(ErrorParseo, "no numérico"):
            self.leer(rows)

    def test_rechaza_base_y_periodos_inconsistentes(self):
        for periodos, valores, mensaje in [
            ([fecha(2017, 1), fecha(2017, 2)], [100, 101], "base de referencia"),
            ([fecha(2016, 12), fecha(2017, 2)], [100, 101], "Períodos"),
            ([fecha(2016, 12), fecha(2016, 12)], [100, 101], "Períodos"),
            ([fecha(2016, 12), fecha(2017, 1)], [99, 101], "base de referencia"),
        ]:
            with self.subTest(mensaje=mensaje), self.assertRaisesRegex(ErrorParseo, mensaje):
                self.leer(filas(periodos, valores))

    def test_rechaza_hoja_ausente_y_archivo_invalido(self):
        with patch("servicio_datos.ipc.parser.xlrd.open_workbook", side_effect=xlrd.XLRDError("formato")):
            with self.assertRaisesRegex(ErrorParseo, "No se pudo abrir"):
                leer_archivo(Path("archivo.xls"), ARCHIVO)

    @unittest.skipUnless(os.environ.get("DATOS_IPC_ORIGINALES_DIR"), "No hay XLS originales configurados")
    def test_con_archivos_originales(self):
        carpeta = Path(os.environ["DATOS_IPC_ORIGINALES_DIR"])
        configuracion = archivos(date(2026, 10, 6))
        nacional = leer_archivo(carpeta / "sh_ipc_09_26.xls", configuracion[0])
        regiones = leer_archivo(carpeta / "sh_ipc_aperturas.xls", configuracion[1])
        self.assertEqual(len(nacional), 1)
        self.assertEqual(len(regiones), 6)
        self.assertEqual(sum(len(s.observaciones) for s in (nacional | regiones).values()), 819)
        self.assertTrue(all(s.observaciones[-1][0] == date(2026, 8, 1)
                            for s in (nacional | regiones).values()))


if __name__ == "__main__":
    unittest.main()
