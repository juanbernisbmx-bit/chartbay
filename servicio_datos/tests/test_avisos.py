"""Avisos: qué se detecta, que no se repite, que se reintenta y que no se molesta de más."""
import contextlib
import io
import json
import os
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch

import psycopg

from servicio_datos import avisar, avisos, ejecutar
from servicio_datos.canales import ErrorEnvio, Mensaje
from servicio_datos.ipc.modelos import Hallazgo
from servicio_datos.tests.base import URL
from servicio_datos.tests.test_canales import SlackFalso
from servicio_datos.tests.test_pipeline import HOY
from servicio_datos.tests.test_publicacion import A, B, C, BasePublicacion

BASE = "https://datos.example.com"
AHORA = datetime(2026, 10, 6, 15, 0, tzinfo=timezone.utc)


class CanalFalso:
    def __init__(self, nombre="falso", falla=None):
        self.nombre, self.falla, self.mensajes = nombre, falla, []

    def enviar(self, mensaje: Mensaje):
        if self.falla:
            raise self.falla
        self.mensajes.append(mensaje)


class BaseAvisos(BasePublicacion):
    def setUp(self):
        super().setUp()
        self.canal = CanalFalso()

    def procesar(self, canales=None, hoy=HOY, ahora=AHORA, **kwargs):
        return avisos.procesar(self.conn, canales if canales is not None else [self.canal], BASE, hoy, ahora, **kwargs)

    def avisos(self, estado=None):
        return self.conn.execute(
            "SELECT tipo, estado, intentos, referencia FROM aviso WHERE (%s::text IS NULL OR estado = %s) ORDER BY id", (estado, estado)).fetchall()

    def envejecer_corridas(self, dias):
        self.conn.execute("UPDATE corrida SET iniciada_en = iniciada_en - make_interval(days => %s)", (dias,))


class CandidatoNuevoTests(BaseAvisos):
    def test_un_candidato_para_revisar_avisa_una_sola_vez_con_el_enlace(self):
        candidato = self.candidato(hallazgos=[B])
        resultado = self.procesar()
        self.assertEqual((resultado.creados, resultado.enviados), (1, 1))
        mensaje = self.canal.mensajes[0]
        self.assertEqual(mensaje.asunto, f"Candidato {candidato} para revisar (INDEC_IPC)")
        self.assertEqual(mensaje.enlace, f"{BASE}/candidatos/{candidato}")
        self.assertIn("42 períodos nuevos, 0 datos ya publicados que cambian, 0 que faltan", mensaje.cuerpo)
        self.assertIn("Hallazgos para revisar: 1.", mensaje.cuerpo)
        # Correrlo de nuevo no repite nada.
        segundo = self.procesar()
        self.assertEqual((segundo.creados, segundo.enviados, len(self.canal.mensajes)), (0, 0, 1))

    def test_las_cantidades_van_en_singular_cuando_es_uno(self):
        self.candidato(hallazgos=[B])
        self.conn.execute("UPDATE corrida SET resumen = resumen || '{\"periodos_nuevos\": 1, \"periodos_cambiados\": 1, \"periodos_faltantes\": 1}'")
        self.procesar()
        self.assertIn("1 período nuevo, 1 dato ya publicado que cambia, 1 que falta.", self.canal.mensajes[0].cuerpo)
        self.assertEqual(avisos._cantidad(0, "dato", "datos"), "0 datos")

    def test_marca_como_atencion_lo_que_tiene_hallazgos_graves_o_cambia_lo_publicado(self):
        self.candidato(hallazgos=[C])  # severidad alta
        self.procesar()
        self.assertTrue(self.canal.mensajes[0].asunto.startswith("[Atención] Candidato"))
        self.assertIn("1 de severidad alta", self.canal.mensajes[0].cuerpo)

    def test_un_candidato_sin_hallazgos_lo_dice(self):
        self.candidato(hallazgos=[])
        self.procesar()
        self.assertIn("No tiene hallazgos.", self.canal.mensajes[0].cuerpo)
        self.assertFalse(self.canal.mensajes[0].asunto.startswith("[Atención]"))

    def test_dice_cuantos_hallazgos_ya_revisados_no_se_repiten(self):
        primero = self.candidato(hallazgos=[A, B])
        self.aceptar_todos(primero)
        self.publicar(primero)
        self.candidato(self.mes_nuevo(), hallazgos=[A, B, C], hasta=(2026, 9))
        self.procesar()
        self.assertIn("Otros 2 ya se revisaron", self.canal.mensajes[-1].cuerpo)

    def test_si_el_candidato_se_resuelve_antes_de_entregarse_el_aviso_se_descarta(self):
        candidato = self.candidato(hallazgos=[])
        roto = CanalFalso(falla=ErrorEnvio("Slack respondió HTTP 500"))
        self.procesar([roto])  # se registra, no se entrega
        self.assertEqual(self.avisos("pendiente"), [("candidato_nuevo", "pendiente", 1, str(candidato))])
        self.publicar(candidato)  # alguien lo publica mientras Slack estaba caído
        resultado = self.procesar()
        self.assertEqual((resultado.descartados, resultado.enviados, self.canal.mensajes), (1, 0, []))
        self.assertEqual(self.avisos(), [("candidato_nuevo", "descartado", 1, str(candidato))])


class CorridaFallidaTests(BaseAvisos):
    def fallar(self, error="No se pudo abrir la hoja", respuestas=None):
        self.leer.error = ValueError(error)
        return self.correr(respuestas)

    def test_una_corrida_fallida_avisa_con_su_error_y_el_enlace(self):
        resultado = self.fallar("No se pudo abrir la hoja «Índices aperturas»")
        self.procesar()
        mensaje = self.canal.mensajes[0]
        self.assertEqual(mensaje.asunto, f"[Atención] Falló la corrida {resultado.corrida_id} (INDEC_IPC)")
        self.assertIn("Índices aperturas", mensaje.cuerpo)
        self.assertEqual(mensaje.enlace, f"{BASE}/corridas/{resultado.corrida_id}")

    def test_una_racha_de_fallas_avisa_una_sola_vez(self):
        self.fallar()
        self.procesar()
        for _ in range(3):  # el cron sigue corriendo y sigue fallando
            self.fallar()
            self.procesar()
        self.assertEqual(len(self.canal.mensajes), 1)
        self.assertEqual(self.contar("corrida"), 4)

    def test_cuando_la_racha_se_resuelve_una_falla_nueva_vuelve_a_avisar(self):
        self.fallar()
        self.procesar()
        self.leer.error = None
        self.correr()  # termina bien: la racha se resolvió
        self.procesar()
        self.fallar(respuestas=self.mes_nuevo())  # otro mes, otro archivo: una falla distinta
        self.procesar()
        self.assertEqual(len([m for m in self.canal.mensajes if "Falló" in m.asunto]), 2)

    def test_un_error_largo_o_con_saltos_de_linea_se_normaliza_y_se_corta(self):
        self.fallar("linea uno\n\n   linea dos " + "x" * 1000)
        self.procesar()
        cuerpo = self.canal.mensajes[0].cuerpo
        self.assertIn("linea uno linea dos", cuerpo)
        self.assertLess(len(cuerpo), 700)

    def test_si_la_falla_se_resuelve_antes_de_entregarse_se_descarta(self):
        self.fallar()
        self.procesar([CanalFalso(falla=ErrorEnvio("caído"))])
        self.leer.error = None
        self.correr()
        resultado = self.procesar()
        self.assertEqual(resultado.descartados, 1)
        # Lo que sí llega es el aviso del candidato que dejó esa corrida; de la falla, nada.
        self.assertEqual([m.asunto for m in self.canal.mensajes if "Falló" in m.asunto], [])
        self.assertEqual(len([m for m in self.canal.mensajes if "para revisar" in m.asunto]), 1)


class SinDatosTests(BaseAvisos):
    def test_pasada_la_ventana_sin_el_dato_avisa_una_vez_por_mes(self):
        self.publicar(self.candidato(hasta=(2026, 7)))  # lo último publicado: julio
        self.procesar(hoy=date(2026, 10, 26))  # después del día 25 ya se esperaba septiembre
        sin_datos = [m for m in self.canal.mensajes if "No llegaron" in m.asunto]
        self.assertEqual(len(sin_datos), 1)
        self.assertEqual(sin_datos[0].asunto, "[Atención] No llegaron los datos de septiembre 2026 (INDEC_IPC)")
        self.assertIn("lo más nuevo que hay de INDEC es julio 2026", sin_datos[0].cuerpo)
        self.procesar(hoy=date(2026, 10, 27))
        self.assertEqual(len([m for m in self.canal.mensajes if "No llegaron" in m.asunto]), 1)
        self.procesar(hoy=date(2026, 11, 26))  # un mes después, si sigue sin llegar, es otro aviso
        self.assertEqual(len([m for m in self.canal.mensajes if "No llegaron" in m.asunto]), 2)

    def test_antes_del_dia_limite_se_espera_un_mes_menos(self):
        self.publicar(self.candidato(hasta=(2026, 7)))
        self.procesar(hoy=date(2026, 10, 6))  # el 6 de octubre ya debería estar agosto
        self.assertEqual(self.canal.mensajes[-1].asunto, "[Atención] No llegaron los datos de agosto 2026 (INDEC_IPC)")
        self.assertEqual(self.avisos("pendiente"), [])

    def test_no_avisa_si_lo_publicado_ya_cubre_lo_esperado(self):
        self.publicar(self.candidato(hasta=(2026, 8)))
        self.procesar(hoy=date(2026, 10, 6))
        self.assertEqual([m for m in self.canal.mensajes if "No llegaron" in m.asunto], [])

    def test_no_avisa_si_un_candidato_abierto_ya_trae_el_dato(self):
        self.publicar(self.candidato(hasta=(2026, 7)))
        self.candidato(self.mes_nuevo(), hasta=(2026, 9))  # esperando revisión, pero el dato llegó
        self.procesar(hoy=date(2026, 10, 26))
        self.assertEqual([m for m in self.canal.mensajes if "No llegaron" in m.asunto], [])

    def test_sin_ningun_dato_todavia_no_hay_nada_que_se_haya_atrasado(self):
        self.leer.error = ValueError("falla")
        self.correr()
        self.procesar(hoy=date(2026, 10, 26))
        self.assertEqual([m for m in self.canal.mensajes if "No llegaron" in m.asunto], [])

    def test_si_el_dato_llega_antes_de_entregarse_se_descarta(self):
        self.publicar(self.candidato(hasta=(2026, 7)))
        self.procesar([CanalFalso(falla=ErrorEnvio("caído"))], hoy=date(2026, 10, 26))
        self.publicar(self.candidato(self.mes_nuevo(), hasta=(2026, 9)))
        resultado = self.procesar(hoy=date(2026, 10, 26))
        self.assertGreaterEqual(resultado.descartados, 1)
        self.assertEqual([m for m in self.canal.mensajes if "No llegaron" in m.asunto], [])


class ColectorInactivoTests(BaseAvisos):
    def test_avisa_cuando_no_hay_corridas_hace_dias(self):
        self.correr()
        self.envejecer_corridas(3)
        self.procesar(ahora=datetime.now(timezone.utc))
        inactivo = [m for m in self.canal.mensajes if "no corre" in m.asunto]
        self.assertEqual(len(inactivo), 1)
        self.assertEqual(inactivo[0].asunto, "[Atención] El colector de INDEC_IPC no corre desde hace 3 días")
        self.assertIn("¿Está funcionando el cron", inactivo[0].cuerpo)

    def test_no_avisa_si_hubo_una_corrida_reciente(self):
        self.correr()
        self.procesar(ahora=datetime.now(timezone.utc))
        self.assertEqual([m for m in self.canal.mensajes if "no corre" in m.asunto], [])

    def test_no_se_repite_mientras_siga_igual_y_se_descarta_si_vuelve_a_correr(self):
        self.correr()
        self.envejecer_corridas(3)
        ahora = datetime.now(timezone.utc)
        self.procesar([CanalFalso(falla=ErrorEnvio("caído"))], ahora=ahora)
        self.correr()  # el cron volvió antes de que se entregara el aviso
        resultado = self.procesar(ahora=ahora)
        self.assertEqual(resultado.descartados, 1)
        self.assertEqual([m for m in self.canal.mensajes if "no corre" in m.asunto], [])


class EntregaTests(BaseAvisos):
    def test_sin_canales_no_hace_nada_ni_acumula_avisos(self):
        self.candidato(hallazgos=[A])
        resultado = self.procesar(canales=[])
        self.assertEqual((resultado.creados, self.contar("aviso")), (0, 0))
        # Al configurar un canal después, el candidato que sigue abierto avisa una vez.
        self.assertEqual(self.procesar().enviados, 1)

    def test_un_canal_caido_se_reintenta_y_despues_se_entrega(self):
        self.candidato(hallazgos=[B])
        roto = CanalFalso(falla=ErrorEnvio("Slack respondió HTTP 500"))
        primero = self.procesar([roto])
        self.assertEqual((primero.enviados, primero.pendientes, primero.errores), (0, 1, ("falso: Slack respondió HTTP 500",)))
        fila = self.conn.execute("SELECT estado, intentos, entregas FROM aviso").fetchone()
        self.assertEqual((fila[0], fila[1], fila[2]["falso"]), ("pendiente", 1, {"ok": False, "error": "Slack respondió HTTP 500"}))
        segundo = self.procesar()
        self.assertEqual((segundo.enviados, segundo.pendientes, len(self.canal.mensajes)), (1, 0, 1))
        self.assertEqual(self.conn.execute("SELECT estado, intentos, enviado_en IS NOT NULL FROM aviso").fetchone(), ("enviado", 2, True))

    def test_se_rinde_despues_de_los_intentos_y_no_sigue_molestando(self):
        self.candidato(hallazgos=[B])
        roto = CanalFalso(falla=ErrorEnvio("caído"))
        for _ in range(avisos.MAX_INTENTOS):
            resultado = self.procesar([roto])
        self.assertEqual((resultado.fallidos, resultado.pendientes), (1, 0))
        self.assertEqual(self.conn.execute("SELECT tipo, estado, intentos FROM aviso").fetchall(), [("candidato_nuevo", "fallido", avisos.MAX_INTENTOS)])
        sin_cambios = self.procesar([roto])
        self.assertEqual((sin_cambios.errores, sin_cambios.fallidos), ((), 0))  # ya no lo intenta

    def test_con_dos_canales_uno_roto_no_repite_en_el_que_ya_llego(self):
        self.candidato(hallazgos=[B])
        bueno, roto = CanalFalso("slack"), CanalFalso("email", falla=ErrorEnvio("SMTP caído"))
        self.procesar([bueno, roto])
        self.procesar([bueno, roto])
        roto.falla = None
        self.procesar([bueno, roto])
        self.assertEqual((len(bueno.mensajes), len(roto.mensajes)), (1, 1))
        self.assertEqual(self.conn.execute("SELECT estado, intentos FROM aviso").fetchone(), ("enviado", 3))

    def test_un_canal_que_explota_no_frena_a_los_demas_ni_filtra_su_mensaje(self):
        self.candidato(hallazgos=[B])
        explota = CanalFalso("email", falla=RuntimeError("clave-secreta-del-smtp"))
        resultado = self.procesar([explota, self.canal])
        self.assertEqual(len(self.canal.mensajes), 1)
        self.assertEqual(resultado.errores, ("email: Falló la entrega (RuntimeError)",))
        self.assertNotIn("clave-secreta", json.dumps(self.conn.execute("SELECT entregas FROM aviso").fetchone()[0]))

    def test_si_otra_corrida_de_avisos_esta_entregando_no_se_duplica(self):
        self.candidato(hallazgos=[B])
        with psycopg.connect(URL, autocommit=True) as otra:
            otra.execute("SELECT pg_advisory_lock(%s)", (avisos.CANDADO,))
            self.avisos_creados = avisos.detectar(self.conn, HOY, AHORA)
            resultado = avisos.entregar(self.conn, [self.canal], BASE, HOY, AHORA)
        self.assertEqual((resultado.ocupado, self.canal.mensajes), (True, []))
        self.assertEqual(avisos.entregar(self.conn, [self.canal], BASE, HOY, AHORA).enviados, 1)

    def test_sin_url_base_el_aviso_va_sin_enlace(self):
        self.candidato(hallazgos=[B])
        avisos.procesar(self.conn, [self.canal], None, HOY, AHORA)
        self.assertIsNone(self.canal.mensajes[0].enlace)


class SlackDeVerdadTests(BaseAvisos):
    """De punta a punta con un Slack local: lo que sale de la base llega escapado."""

    def test_el_error_de_una_corrida_llega_a_slack_sin_poder_mencionar_a_todos(self):
        slack = SlackFalso()
        self.addCleanup(slack.cerrar)
        self.leer.error = ValueError("<!channel> boom <https://malo.example|clic>")
        self.correr()
        avisos.procesar(self.conn, [slack.canal()], BASE, HOY, AHORA)
        texto = slack.recibidos[0][1]["text"]
        self.assertIn("&lt;!channel&gt; boom", texto)
        self.assertNotIn("<!channel>", texto)
        self.assertNotIn("<https://malo.example", texto)
        self.assertIn(f"<{BASE}/corridas/", texto)  # el enlace propio sí es un enlace


class RecordatoriosTests(BaseAvisos):
    """Un candidato que sigue abierto vuelve a avisar, cada vez menos seguido y sin ráfagas."""

    def abierto_hace(self, dias, **kwargs):
        candidato = self.candidato(**kwargs)
        self.conn.execute("UPDATE candidato SET creado_en = now() - make_interval(days => %s) WHERE id = %s", (dias, candidato))
        return candidato

    def edad(self, dias):
        self.conn.execute("UPDATE candidato SET creado_en = now() - make_interval(days => %s)", (dias,))

    def recordar(self, **kwargs):
        return self.procesar(ahora=datetime.now(timezone.utc), **kwargs)

    def recordatorios(self):
        return [m for m in self.canal.mensajes if "sin cerrarse" in m.asunto]

    def test_el_calendario_de_hitos(self):
        hito = avisos.hito_de_recordatorio
        self.assertEqual([hito(e) for e in (0, 2, 3, 6, 7, 13, 14, 20, 21, 100)], [None, None, 3, 3, 7, 7, 14, 14, 21, 98])
        self.assertEqual([hito(e, 1) for e in (0, 1, 6, 7, 8)], [None, 1, 1, 7, 7])
        self.assertEqual([hito(e, 10) for e in (9, 10, 13, 14)], [None, 10, 10, 14])
        self.assertEqual((hito(50, 0), hito(50, -1)), (None, None))

    def test_antes_del_primer_hito_no_recuerda(self):
        self.abierto_hace(2, hallazgos=[B])
        self.recordar()
        self.assertEqual(self.recordatorios(), [])

    def test_a_los_tres_dias_recuerda_con_el_estado_y_el_enlace(self):
        candidato = self.abierto_hace(3, hallazgos=[A, B, C])
        resultado = self.recordar()
        (recordatorio,) = self.recordatorios()
        self.assertEqual(recordatorio.asunto, f"[Recordatorio] Candidato {candidato} lleva 3 días sin cerrarse (INDEC_IPC)")
        self.assertIn("Faltan resolver 3 de 3 hallazgos.", recordatorio.cuerpo)
        self.assertIn("ChartBay sigue mostrando la versión anterior", recordatorio.cuerpo)
        self.assertEqual(recordatorio.enlace, f"{BASE}/candidatos/{candidato}")
        self.assertEqual(resultado.creados, 2)  # el aviso de candidato nuevo, que nunca se había mandado, y el recordatorio

    def test_cada_hito_avisa_una_sola_vez_y_escala(self):
        self.abierto_hace(3, hallazgos=[B])
        for dias, esperados in ((3, 1), (5, 1), (7, 2), (10, 2), (14, 3), (20, 3), (21, 4), (27, 4), (28, 5)):
            self.edad(dias)
            self.recordar()
            self.assertEqual(len(self.recordatorios()), esperados, f"a los {dias} días")
        asuntos = [m.asunto.split(" Candidato")[0] for m in self.recordatorios()]
        self.assertEqual(asuntos, ["[Recordatorio]", "[Recordatorio]", "[Atención]", "[Atención]", "[Atención]"])

    def test_si_el_sistema_estuvo_apagado_manda_solo_el_hito_mas_alto(self):
        self.abierto_hace(20, hallazgos=[B])
        self.recordar()
        (recordatorio,) = self.recordatorios()
        self.assertIn("lleva 20 días", recordatorio.asunto)
        self.assertEqual(self.conn.execute("SELECT clave FROM aviso WHERE tipo = 'candidato_pendiente'").fetchall(), [(f"candidato_pendiente:{self.conn.execute('SELECT id FROM candidato').fetchone()[0]}:14",)])

    def test_si_hay_rechazados_dice_que_no_se_puede_publicar_y_que_hay_que_descartarlo(self):
        candidato = self.abierto_hace(4, hallazgos=[A, B])
        from servicio_datos import publicacion
        publicacion.revisar_hallazgo(self.conn, self.hallazgos_de(candidato)[0], "rechazado", "juani", "Parece mal cargado")
        self.recordar()
        (recordatorio,) = self.recordatorios()
        self.assertIn("Tiene 1 hallazgo rechazado", recordatorio.cuerpo)
        self.assertIn("hay que descartarlo y esperar el próximo", recordatorio.cuerpo)

    def test_si_todo_esta_resuelto_dice_que_solo_falta_publicar(self):
        candidato = self.abierto_hace(4, hallazgos=[A])
        self.aceptar_todos(candidato)
        self.recordar()
        self.assertIn("está listo para publicar", self.recordatorios()[0].cuerpo)

    def test_un_candidato_sin_hallazgos_tambien_recuerda_que_esta_listo(self):
        self.abierto_hace(4, hallazgos=[])
        self.recordar()
        self.assertIn("No tiene hallazgos: está listo para publicar.", self.recordatorios()[0].cuerpo)

    def test_un_candidato_publicado_o_descartado_deja_de_recordar(self):
        from servicio_datos import publicacion
        publicado = self.abierto_hace(8, hallazgos=[])
        self.publicar(publicado)
        self.recordar()
        self.assertEqual(self.recordatorios(), [])
        nuevo = self.candidato(self.mes_nuevo(), hallazgos=[], valor=200)
        self.edad(8)
        publicacion.descartar_candidato(self.conn, nuevo, "juani", "Mal cargado")
        self.recordar()
        self.assertEqual(self.recordatorios(), [])

    def test_un_recordatorio_pendiente_se_descarta_si_el_candidato_se_cierra(self):
        candidato = self.abierto_hace(4, hallazgos=[])
        self.procesar([CanalFalso(falla=ErrorEnvio("caído"))], ahora=datetime.now(timezone.utc))  # se registran, no se entregan
        self.publicar(candidato)
        resultado = self.recordar()
        self.assertGreaterEqual(resultado.descartados, 2)  # el de candidato nuevo y el recordatorio
        self.assertEqual(self.canal.mensajes, [])

    def test_un_candidato_reemplazado_no_sigue_recordando_pero_el_nuevo_arranca_de_cero(self):
        viejo = self.abierto_hace(8, hallazgos=[])
        nuevo = self.candidato(self.mes_nuevo(), hallazgos=[], valor=200)
        self.assertEqual(self.conn.execute("SELECT estado FROM candidato WHERE id = %s", (viejo,)).fetchone()[0], "descartado")
        self.recordar()
        self.assertEqual(self.recordatorios(), [])
        self.edad(3)
        self.recordar()
        (recordatorio,) = self.recordatorios()
        self.assertIn(f"Candidato {nuevo} lleva 3 días", recordatorio.asunto)

    def test_se_pueden_apagar_o_adelantar(self):
        self.abierto_hace(5, hallazgos=[B])
        self.recordar(recordatorio_dias=0)
        self.assertEqual(self.recordatorios(), [])
        self.edad(1)
        self.recordar(recordatorio_dias=1)
        self.assertEqual(len(self.recordatorios()), 1)
        self.assertIn("lleva 1 días", self.recordatorios()[0].asunto)


class LineaDeComandosTests(BaseAvisos):
    def cli(self, *args, entorno=None):
        url = f"{URL}{'&' if '?' in URL else '?'}options=-csearch_path%3D{self.schema}%2Cpublic"
        salida, errores = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, entorno or {}, clear=False), contextlib.redirect_stdout(salida), contextlib.redirect_stderr(errores):
            codigo = avisar.main([*args, "--url", url, "--hoy", HOY.isoformat()])
        return codigo, salida.getvalue(), errores.getvalue()

    def entorno_slack(self, slack):
        return {"DATOS_AVISOS_SLACK_URL": slack.url, "DATOS_REVISION_URL": BASE}

    def test_sin_canales_lo_dice_y_no_registra_nada(self):
        self.candidato(hallazgos=[B])
        with patch.dict(os.environ, {}, clear=True):
            codigo, salida, errores = self.cli()
        self.assertEqual(codigo, 0)
        self.assertIn("No hay ningún canal configurado", errores)
        self.assertEqual(self.contar("aviso"), 0)

    def test_procesar_manda_el_aviso_y_estado_lo_muestra(self):
        slack = SlackFalso()
        self.addCleanup(slack.cerrar)
        self.candidato(hallazgos=[B])
        with patch("servicio_datos.canales.CanalSlack", lambda url: slack.canal()):
            codigo, salida, _ = self.cli(entorno=self.entorno_slack(slack))
        self.assertEqual(codigo, 0)
        self.assertEqual(json.loads(salida)["enviados"], 1)
        self.assertEqual(len(slack.recibidos), 1)
        _, estado, _ = self.cli("estado", entorno=self.entorno_slack(slack))
        self.assertIn("candidato_nuevo · enviado · 1 intentos", estado)
        self.assertIn("slack=ok", estado)

    def test_si_una_entrega_falla_sale_con_codigo_1_para_que_el_cron_lo_marque(self):
        slack = SlackFalso()
        self.addCleanup(slack.cerrar)
        slack.estado = 500
        self.candidato(hallazgos=[B])
        with patch("servicio_datos.canales.CanalSlack", lambda url: slack.canal()):
            codigo, salida, _ = self.cli(entorno=self.entorno_slack(slack))
        self.assertEqual(codigo, 1)
        self.assertIn("Slack respondió HTTP 500", json.loads(salida)["errores"][0])

    def test_estado_funciona_aunque_los_canales_esten_mal_configurados(self):
        self.candidato(hallazgos=[B])
        self.procesar()
        codigo, salida, _ = self.cli("estado", entorno={"DATOS_AVISOS_SLACK_URL": "https://otro.example/services/T/B/X"})
        self.assertEqual(codigo, 0)
        self.assertIn("candidato_nuevo · enviado", salida)

    def test_probar_manda_un_mensaje_de_prueba_y_falla_si_no_hay_canal(self):
        slack = SlackFalso()
        self.addCleanup(slack.cerrar)
        with patch("servicio_datos.canales.CanalSlack", lambda url: slack.canal()):
            codigo, salida, _ = self.cli("probar", entorno=self.entorno_slack(slack))
        self.assertEqual((codigo, salida.strip()), (0, "slack: ok"))
        self.assertIn("Prueba de avisos de ChartBay", slack.recibidos[0][1]["text"])
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.cli("probar")[0], 1)

    def avisar_con_un_candidato_de_cuatro_dias(self, entorno_extra):
        slack = SlackFalso()
        self.addCleanup(slack.cerrar)
        candidato = self.candidato(hallazgos=[B])
        self.conn.execute("UPDATE candidato SET creado_en = now() - interval '4 days' WHERE id = %s", (candidato,))
        with patch("servicio_datos.canales.CanalSlack", lambda url: slack.canal()):
            self.cli(entorno={**self.entorno_slack(slack), **entorno_extra})
        return [r[1]["text"] for r in slack.recibidos]

    def test_el_comando_manda_el_recordatorio_de_un_candidato_abierto_hace_dias(self):
        textos = self.avisar_con_un_candidato_de_cuatro_dias({})
        self.assertEqual(len(textos), 2)
        self.assertTrue(any("sin cerrarse" in t for t in textos))

    def test_los_recordatorios_se_apagan_por_entorno(self):
        textos = self.avisar_con_un_candidato_de_cuatro_dias({"DATOS_AVISOS_RECORDATORIO_DIAS": "0"})
        self.assertEqual(len(textos), 1)
        self.assertFalse(any("sin cerrarse" in t for t in textos))

    def test_una_configuracion_invalida_se_informa_sin_la_url(self):
        codigo, _, errores = self.cli(entorno={"DATOS_AVISOS_SLACK_URL": "https://otro.example/services/T/B/SECRETTOKEN123"})
        self.assertEqual(codigo, 1)
        self.assertIn("Error de configuración", errores)
        self.assertNotIn("SECRETTOKEN123", errores)


class IntegracionConEjecutarTests(BaseAvisos):
    def test_si_los_avisos_fallan_la_corrida_no_cambia_y_no_se_filtra_nada(self):
        salida = io.StringIO()
        entorno = {"DATOS_AVISOS_SLACK_URL": "https://otro.example/services/T/B/SECRETTOKEN123"}
        with patch.dict(os.environ, entorno), contextlib.redirect_stderr(salida):
            informe = ejecutar._avisar(self.conn, HOY)
        self.assertEqual(informe, {"error": "ValueError"})
        self.assertNotIn("SECRETTOKEN123", salida.getvalue())

    def test_sin_canales_no_informa_avisos(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(ejecutar._avisar(self.conn, HOY))

    def test_con_un_canal_informa_lo_que_hizo(self):
        self.candidato(hallazgos=[B])
        slack = SlackFalso()
        self.addCleanup(slack.cerrar)
        with patch.dict(os.environ, {"DATOS_AVISOS_SLACK_URL": slack.url}), patch("servicio_datos.canales.CanalSlack", lambda url: slack.canal()):
            informe = ejecutar._avisar(self.conn, HOY)
        self.assertEqual((informe["creados"], informe["enviados"], informe["errores"]), (1, 1, []))


if __name__ == "__main__":
    unittest.main()
