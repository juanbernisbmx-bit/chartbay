"""Alertas del IPC: nunca modifican las observaciones que entraron."""
import os
import unittest
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

from servicio_datos.ipc import fuente
from servicio_datos.ipc.modelos import DescargaRegistrada, SerieLeida
from servicio_datos.ipc.parser import leer_archivo
from servicio_datos.ipc.validacion import validar


BASE = date(2016, 12, 1)
ENERO = date(2017, 1, 1)
FEBRERO = date(2017, 2, 1)
HOY = date(2017, 3, 6)


def serie(serie_id, *observaciones, notas=()):
    archivo = "nacional" if serie_id == "ipc_ng_nacional" else "aperturas"
    return SerieLeida(serie_id, archivo, "IPC", 3, tuple(observaciones), tuple(notas))


def conjunto():
    datos = {"ipc_ng_nacional": serie("ipc_ng_nacional", (BASE, Decimal(100)),
                                         (ENERO, Decimal(110)), (FEBRERO, Decimal(115)))}
    for indice, serie_id in enumerate(fuente.REGIONES.values()):
        datos[serie_id] = serie(serie_id, (BASE, Decimal(100)),
                                (ENERO, Decimal(108 + indice)), (FEBRERO, Decimal(113 + indice)))
    return datos


def descarga(clave):
    return DescargaRegistrada(1, clave, "https://www.indec.gob.ar/x.xls", "a" * 64,
                              Path("/crudo/x.xls"), "nueva", datetime(2017, 3, 5, tzinfo=timezone.utc))


class ValidacionTests(unittest.TestCase):
    def test_serie_regular_no_genera_hallazgos(self):
        self.assertEqual(validar(conjunto(), {}, [descarga("nacional"), descarga("aperturas")], hoy=HOY), [])

    def test_historia_revisada_y_omitida_quedan_identificadas(self):
        datos = conjunto()
        vigente = {"ipc_ng_nacional": {ENERO: Decimal(109), date(2017, 3, 1): Decimal(118)}}
        original = datos["ipc_ng_nacional"].observaciones
        hallazgos = validar(datos, vigente, [], hoy=HOY)
        cambios = [h for h in hallazgos if h.regla == "historia_intacta"]
        self.assertEqual(len(cambios), 2)
        self.assertEqual({h.periodo for h in cambios}, {ENERO, date(2017, 3, 1)})
        self.assertTrue(all(h.severidad == "alta" for h in cambios))
        self.assertEqual(datos["ipc_ng_nacional"].observaciones, original)

    def test_desfase_del_nacional_del_piloto_es_hallazgo_de_cobertura(self):
        datos = conjunto()
        datos["ipc_ng_nacional"] = serie("ipc_ng_nacional", (BASE, Decimal(100)), (ENERO, Decimal(110)))
        hallazgos = validar(datos, {}, [], hoy=HOY)
        cobertura = [h for h in hallazgos if h.regla == "cobertura"]
        self.assertEqual(len(cobertura), 1)
        self.assertEqual(cobertura[0].serie_id, "ipc_ng_nacional")
        self.assertEqual(cobertura[0].periodo, ENERO)
        self.assertIn("2017-02", cobertura[0].detalle)

    def test_cruce_regional_y_salto_son_alertas_distintas(self):
        datos = conjunto()
        datos["ipc_ng_nacional"] = serie("ipc_ng_nacional", (BASE, Decimal(100)),
                                          (ENERO, Decimal(150)), (FEBRERO, Decimal(115)))
        hallazgos = validar(datos, {}, [], hoy=HOY)
        self.assertIn("cruce_regional", {h.regla for h in hallazgos})
        self.assertIn("salto_mensual", {h.regla for h in hallazgos})
        self.assertTrue(all(h.serie_id == "ipc_ng_nacional" for h in hallazgos))

    def test_marca_estructura_y_continuidad_sin_corregirlas(self):
        datos = conjunto()
        del datos["ipc_ng_gba"]
        datos["ipc_ng_cuyo"] = serie("ipc_ng_cuyo", (BASE, Decimal(100)),
                                      (date(2017, 2, 1), Decimal(0)))
        hallazgos = validar(datos, {}, [], hoy=HOY)
        reglas = {h.regla for h in hallazgos}
        self.assertTrue({"estructura", "continuidad", "rango"}.issubset(reglas))
        self.assertEqual(datos["ipc_ng_cuyo"].observaciones[-1][1], Decimal(0))

    def test_nota_del_encabezado_es_revisable(self):
        datos = conjunto()
        anterior = datos["ipc_ng_nacional"]
        datos["ipc_ng_nacional"] = serie(anterior.serie_id, *anterior.observaciones,
                                          notas=("Encabezado 2017-01-26 interpretado como período mensual 2017-01",))
        hallazgos = validar(datos, {}, [], hoy=HOY)
        self.assertEqual([(h.regla, h.severidad) for h in hallazgos], [("fecha_normalizada", "baja")])

    def test_frescura_solo_despues_del_plazo_y_con_archivo_descargado(self):
        datos = conjunto()
        datos["ipc_ng_nacional"] = serie("ipc_ng_nacional", (BASE, Decimal(100)), (ENERO, Decimal(110)))
        self.assertNotIn("frescura", {h.regla for h in validar(datos, {}, [descarga("nacional")], hoy=HOY)})
        tardios = validar(datos, {}, [descarga("nacional")], hoy=date(2017, 3, 26))
        frescura = [h for h in tardios if h.regla == "frescura"]
        self.assertEqual(len(frescura), 1)
        self.assertEqual(frescura[0].serie_id, "ipc_ng_nacional")
        self.assertIn("2017-02", frescura[0].detalle)
        self.assertNotIn("frescura", {h.regla for h in validar(datos, {}, [], hoy=date(2017, 3, 26))})

    @unittest.skipUnless(os.environ.get("DATOS_IPC_ORIGINALES_DIR"), "No hay XLS originales configurados")
    def test_piloto_atrasado_y_archivos_vigentes(self):
        carpeta = Path(os.environ["DATOS_IPC_ORIGINALES_DIR"])
        nacional, aperturas = fuente.archivos(date(2026, 10, 6))
        regionales = leer_archivo(carpeta / "sh_ipc_aperturas.xls", aperturas)
        viejo = leer_archivo(carpeta / "sh_ipc_08_26.xls", nacional) | regionales
        nuevo = leer_archivo(carpeta / "sh_ipc_09_26.xls", nacional) | regionales
        anterior = validar(viejo, {}, [descarga("nacional"), descarga("aperturas")], hoy=date(2026, 10, 6))
        actual = validar(nuevo, {}, [descarga("nacional"), descarga("aperturas")], hoy=date(2026, 10, 6))
        self.assertIn("ipc_ng_nacional", {h.serie_id for h in anterior if h.regla == "cobertura"})
        self.assertIn("ipc_ng_nacional", {h.serie_id for h in anterior if h.regla == "frescura"})
        self.assertFalse(any(h.regla in {"cobertura", "frescura"} for h in actual))


if __name__ == "__main__":
    unittest.main()
