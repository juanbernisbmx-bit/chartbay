"""Interfaz de revisión: seguridad, pantallas y acciones, con candidatos que deja el pipeline."""
import base64
import re
import unittest
from datetime import date
from unittest.mock import patch

from werkzeug.security import check_password_hash, generate_password_hash

from servicio_datos.ipc.modelos import Hallazgo
from servicio_datos.revision import crear_app
from servicio_datos.revision import __main__ as cli
from servicio_datos.tests.base import URL
from servicio_datos.tests.test_publicacion import A, B, C, BasePublicacion

CLAVE = "una-clave-larga-de-prueba"
HASH = generate_password_hash(CLAVE, method="pbkdf2:sha256:1000")  # pocas vueltas: las pruebas no necesitan lentitud


def basic(usuario, clave=CLAVE):
    return {"Authorization": "Basic " + base64.b64encode(f"{usuario}:{clave}".encode()).decode()}


class BaseRevision(BasePublicacion):
    def setUp(self):
        super().setUp()
        url = f"{URL}{'&' if '?' in URL else '?'}options=-csearch_path%3D{self.schema}%2Cpublic"
        self.app = crear_app(url, {"juani": HASH, "ana": HASH})
        self.web = self.app.test_client()

    def get(self, ruta, usuario="juani", **kwargs):
        return self.web.get(ruta, headers=basic(usuario), **kwargs)

    def token(self, candidato_id, usuario="juani"):
        html = self.get(f"/candidatos/{candidato_id}", usuario).get_data(as_text=True)
        return re.search(r'name="csrf" value="([0-9a-f]+)"', html).group(1)

    def post(self, ruta, candidato_id, datos=None, usuario="juani", token=None, **kwargs):
        datos = {"csrf": token or self.token(candidato_id, usuario), **(datos or {})}
        return self.web.post(ruta, data=datos, headers=basic(usuario), **kwargs)

    def abierto(self, hallazgos=(A, B, C), **opciones):
        return self.candidato(hallazgos=list(hallazgos), **opciones)

    def estado(self, candidato_id):
        return self.uno("SELECT estado FROM candidato WHERE id = %s", (candidato_id,))


class SeguridadTests(BaseRevision):
    def test_sin_credenciales_o_con_credenciales_malas_no_entra(self):
        respuesta = self.web.get("/")
        self.assertEqual(respuesta.status_code, 401)
        self.assertIn("Basic", respuesta.headers["WWW-Authenticate"])
        self.assertEqual(self.web.get("/", headers=basic("juani", "otra-clave-cualquiera")).status_code, 401)
        self.assertEqual(self.web.get("/", headers=basic("intruso")).status_code, 401)
        self.assertEqual(self.get("/").status_code, 200)

    def test_nada_se_ve_sin_iniciar_sesion_ni_los_datos_ni_las_acciones(self):
        candidato = self.abierto()
        for ruta in (f"/candidatos/{candidato}", "/corridas/1", "/"):
            self.assertEqual(self.web.get(ruta).status_code, 401, ruta)
        antes = self.contar("revision_hallazgo")
        self.assertEqual(self.web.post(f"/candidatos/{candidato}/publicar", data={}).status_code, 401)
        self.assertEqual(self.web.post(f"/candidatos/{candidato}/aceptar-pendientes", data={}).status_code, 401)
        self.assertEqual(self.contar("revision_hallazgo"), antes)

    def test_salud_y_estilos_son_publicos_y_no_muestran_datos(self):
        self.assertEqual((self.web.get("/salud").status_code, self.web.get("/salud").get_data(as_text=True)), (200, "ok"))
        self.assertEqual(self.web.get("/static/revision.css").status_code, 200)

    def test_el_exceso_de_intentos_fallidos_bloquea_ese_usuario(self):
        for _ in range(5):
            self.assertEqual(self.web.get("/", headers=basic("juani", "mal-mal-mal-mal")).status_code, 401)
        bloqueado = self.web.get("/", headers=basic("juani"))  # ni siquiera con la clave buena
        self.assertEqual(bloqueado.status_code, 429)
        self.assertIn("Retry-After", bloqueado.headers)
        self.assertEqual(self.web.get("/", headers=basic("ana")).status_code, 200)

    def test_sin_revisores_no_arranca(self):
        with self.assertRaises(ValueError):
            crear_app("postgresql://x", {})

    def test_cabeceras_estrictas_y_sin_cache(self):
        respuesta = self.get("/")
        self.assertIn("default-src 'none'", respuesta.headers["Content-Security-Policy"])
        self.assertNotIn("script", respuesta.headers["Content-Security-Policy"])
        self.assertEqual(respuesta.headers["Cache-Control"], "no-store")
        self.assertEqual(respuesta.headers["X-Frame-Options"], "DENY")
        # No puede ser no-referrer: haría que el navegador mande `Origin: null` en los formularios propios.
        self.assertEqual(respuesta.headers["Referrer-Policy"], "same-origin")
        self.assertNotIn("no-store", self.web.get("/static/revision.css").headers.get("Cache-Control", ""))

    def test_un_formulario_sin_token_o_con_el_de_otro_usuario_se_rechaza(self):
        candidato = self.abierto()
        antes = self.contar("revision_hallazgo")
        ruta = f"/candidatos/{candidato}/aceptar-pendientes"
        self.assertEqual(self.web.post(ruta, data={}, headers=basic("juani")).status_code, 403)
        self.assertEqual(self.web.post(ruta, data={"csrf": "x" * 64}, headers=basic("juani")).status_code, 403)
        self.assertEqual(self.post(ruta, candidato, token=self.token(candidato, "ana")).status_code, 403)
        self.assertEqual(self.contar("revision_hallazgo"), antes)
        self.assertEqual(self.post(ruta, candidato).status_code, 303)

    def test_un_pedido_de_otro_origen_se_rechaza_aunque_traiga_el_token(self):
        candidato = self.abierto()
        token = self.token(candidato)
        ruta = f"/candidatos/{candidato}/publicar"
        ajeno = self.web.post(ruta, data={"csrf": token}, headers={**basic("juani"), "Origin": "https://sitio-malicioso.example"})
        self.assertEqual(ajeno.status_code, 403)
        propio = self.web.post(ruta, data={"csrf": token}, headers={**basic("juani"), "Origin": "http://localhost"})
        self.assertEqual(propio.status_code, 422)  # el origen es válido; lo frena que faltan hallazgos

    def test_un_origen_nulo_se_rechaza_con_un_mensaje_que_dice_que_hacer(self):
        candidato = self.abierto()
        respuesta = self.web.post(f"/candidatos/{candidato}/publicar", data={"csrf": self.token(candidato)},
                                  headers={**basic("juani"), "Origin": "null"})
        self.assertEqual(respuesta.status_code, 403)
        self.assertIn("Recargá la página", respuesta.get_data(as_text=True))

    def test_el_revisor_es_el_usuario_autenticado_y_no_lo_que_diga_el_formulario(self):
        candidato = self.abierto(hallazgos=[A])
        hallazgo = self.hallazgos_de(candidato)[0]
        self.post(f"/candidatos/{candidato}/revisar", candidato,
                  {"accion": "aceptar", "hallazgo": hallazgo, "comentario": "ok", "revisor": "otra-persona"}, usuario="ana")
        self.assertEqual(self.uno("SELECT revisor FROM revision_hallazgo WHERE hallazgo_id = %s", (hallazgo,)), "ana")


class DetrasDeUnProxyTests(BaseRevision):
    """Con Caddy o nginx delante: la dirección real del visitante, HSTS por HTTPS y nada que se pueda falsear."""

    def app_con_proxy(self, confiar):
        url = f"{URL}{'&' if '?' in URL else '?'}options=-csearch_path%3D{self.schema}%2Cpublic"
        return crear_app(url, {"juani": HASH, "ana": HASH}, confiar_en_proxy=confiar).test_client()

    def fallar(self, cliente, desde, veces=5, usuario="juani"):
        for _ in range(veces):
            cliente.get("/", headers={**basic(usuario, "mal-mal-mal-mal"), "X-Forwarded-For": desde})

    def test_con_proxy_el_limite_de_intentos_cuenta_por_visitante_y_no_por_proxy(self):
        cliente = self.app_con_proxy(True)
        self.fallar(cliente, "203.0.113.7")
        self.assertEqual(cliente.get("/", headers={**basic("juani"), "X-Forwarded-For": "203.0.113.7"}).status_code, 429)
        # Otro visitante, mismo usuario: no queda bloqueado por lo que hizo el primero.
        self.assertEqual(cliente.get("/", headers={**basic("juani"), "X-Forwarded-For": "198.51.100.9"}).status_code, 200)

    def test_sin_confiar_en_el_proxy_no_se_puede_esquivar_el_limite_falseando_la_cabecera(self):
        cliente = self.app_con_proxy(False)
        for i in range(5):
            cliente.get("/", headers={**basic("juani", "mal-mal-mal-mal"), "X-Forwarded-For": f"203.0.113.{i}"})  # un origen distinto cada vez
        self.assertEqual(cliente.get("/", headers={**basic("juani"), "X-Forwarded-For": "198.51.100.9"}).status_code, 429)

    def test_hsts_solo_sale_por_https(self):
        cliente = self.app_con_proxy(True)
        por_http = cliente.get("/", headers=basic("juani"))
        por_https = cliente.get("/", headers={**basic("juani"), "X-Forwarded-Proto": "https"})
        self.assertNotIn("Strict-Transport-Security", por_http.headers)
        self.assertEqual(por_https.headers["Strict-Transport-Security"], "max-age=31536000")
        self.assertNotIn("includeSubDomains", por_https.headers["Strict-Transport-Security"])

    def test_sin_confiar_en_el_proxy_una_cabecera_falsa_no_hace_pasar_el_pedido_por_https(self):
        respuesta = self.app_con_proxy(False).get("/", headers={**basic("juani"), "X-Forwarded-Proto": "https"})
        self.assertNotIn("Strict-Transport-Security", respuesta.headers)

    def test_el_chequeo_de_origen_usa_el_host_publico_que_informa_el_proxy(self):
        candidato = self.abierto()
        token = self.token(candidato)
        ruta = f"/candidatos/{candidato}/publicar"
        publico = {**basic("juani"), "X-Forwarded-Host": "revision.example.org", "X-Forwarded-Proto": "https"}
        con_proxy = self.app_con_proxy(True)
        self.assertEqual(con_proxy.post(ruta, data={"csrf": token}, headers={**publico, "Origin": "https://revision.example.org"}).status_code, 422)
        self.assertEqual(con_proxy.post(ruta, data={"csrf": token}, headers={**publico, "Origin": "https://otro.example.org"}).status_code, 403)
        # Sin confiar en el proxy, esa cabecera no cuenta: el host es el real y el origen público no coincide.
        sin_proxy = self.app_con_proxy(False)
        self.assertEqual(sin_proxy.post(ruta, data={"csrf": token}, headers={**publico, "Origin": "https://revision.example.org"}).status_code, 403)

    def test_la_fabrica_de_gunicorn_activa_el_proxy_solo_si_se_pide(self):
        from werkzeug.middleware.proxy_fix import ProxyFix
        base = {"DATOS_DATABASE_URL": "postgresql://x/y", "DATOS_REVISORES": f"juani={HASH}"}
        with patch.dict("os.environ", {**base, "DATOS_REVISION_PROXY": "1"}):
            self.assertIsInstance(cli.app_desde_entorno().wsgi_app, ProxyFix)
        for valor in ({}, {"DATOS_REVISION_PROXY": "0"}, {"DATOS_REVISION_PROXY": "si"}):
            with patch.dict("os.environ", {**base, **valor}):
                self.assertNotIsInstance(cli.app_desde_entorno().wsgi_app, ProxyFix, valor)


class ColaTests(BaseRevision):
    def test_vacia_dice_todo_al_dia(self):
        html = self.get("/").get_data(as_text=True)
        self.assertIn("Todo al día", html)
        self.assertIn("Todavía no hay", html)  # release vigente
        self.assertIn("Requieren atención · 0", html)

    def test_lista_el_candidato_con_lo_que_falta_resolver(self):
        candidato = self.abierto()
        html = self.get("/").get_data(as_text=True)
        self.assertIn(f"Candidato {candidato}", html)
        self.assertIn("3 de 3 hallazgos sin resolver", html)
        self.assertIn(f'href="/candidatos/{candidato}"', html)
        self.assertNotIn("Todo al día", html)

    def test_cuando_todo_esta_resuelto_dice_listo_para_publicar(self):
        candidato = self.abierto(hallazgos=[A])
        self.aceptar_todos(candidato)
        self.assertIn("Listo para publicar", self.get("/").get_data(as_text=True))

    def test_una_corrida_fallida_se_ve_hasta_que_una_posterior_termina_bien(self):
        self.leer.error = ValueError("formato roto")
        self.correr()
        html = self.get("/").get_data(as_text=True)
        self.assertIn("formato roto", html)
        self.assertIn("Requieren atención · 1", html)
        self.leer.error = None
        self.correr()
        self.assertNotIn("formato roto", self.get("/").get_data(as_text=True))

    def test_las_fallidas_van_antes_que_los_candidatos(self):
        self.abierto(hallazgos=[A])
        self.conn.execute("INSERT INTO corrida (fuente_id, estado, terminada_en, error) VALUES ('INDEC_IPC', 'fallida', now(), 'se cayó')")
        html = self.get("/").get_data(as_text=True)
        self.assertLess(html.index("se cayó"), html.index("Abrir revisión"))

    def test_el_historial_muestra_publicados_y_descartados(self):
        publicado = self.abierto(hallazgos=[A])
        self.aceptar_todos(publicado)
        p = self.publicar(publicado)
        descartado = self.candidato(self.mes_nuevo(), hallazgos=[B], valor=200)
        from servicio_datos import publicacion
        publicacion.descartar_candidato(self.conn, descartado, "juani", "Parece mal cargado")
        html = self.get("/?ver=historial").get_data(as_text=True)
        self.assertIn(p.release_id, html)
        self.assertIn("Parece mal cargado", html)
        self.assertIn(f"Candidato {publicado}", html)
        self.assertIn(f"Candidato {descartado}", html)
        self.assertIn("Historial · 2", html)

    def test_una_pestana_desconocida_cae_en_la_de_atencion(self):
        self.assertEqual(self.get("/?ver=<script>").status_code, 200)
        self.assertNotIn("<script>", self.get("/?ver=<script>").get_data(as_text=True))


class PantallaDeRevisionTests(BaseRevision):
    def test_agrupa_por_regla_con_su_explicacion_y_cuenta(self):
        candidato = self.abierto(hallazgos=[A, B, C, Hallazgo("salto_mensual", "media", "ipc_ng_gba", date(2026, 4, 1), "varió 30%")])
        html = self.get(f"/candidatos/{candidato}").get_data(as_text=True)
        self.assertIn("Salto mensual atípico", html)
        self.assertIn("Encabezado de fecha normalizado", html)
        self.assertIn("Cobertura desigual", html)
        self.assertRegex(html, r'Salto mensual atípico <span class="cuenta">2</span>')
        # Primero lo más grave: la cobertura (alta) antes que los saltos (media) y las notas (baja).
        self.assertLess(html.index("Cobertura desigual"), html.index("Salto mensual atípico"))
        self.assertLess(html.index("Salto mensual atípico"), html.index("Encabezado de fecha normalizado"))

    def test_cada_hallazgo_con_serie_trae_su_grafico(self):
        candidato = self.abierto(hallazgos=[A])
        html = self.get(f"/candidatos/{candidato}").get_data(as_text=True)
        self.assertIn('<svg class="grafico"', html)
        self.assertIn("lin-resalte", html)  # el período del hallazgo, marcado
        self.assertEqual(len(set(re.findall(r'id="(t-h\d+)"', html))), html.count('<svg class="grafico"'))

    def test_un_dato_publicado_que_cambia_se_destaca(self):
        self.publicar(self.candidato(hasta=(2026, 8)))
        cambio = {("ipc_ng_cuyo", date(2026, 4, 1)): "999"}
        candidato = self.candidato(self.segundo_mes(cambio), hallazgos=[Hallazgo("historia_intacta", "alta", "ipc_ng_cuyo", date(2026, 4, 1), "pasó de 101 a 999")])
        html = self.get(f"/candidatos/{candidato}").get_data(as_text=True)
        self.assertIn("Datos ya publicados que cambian", html)
        self.assertIn("1 con otro valor", html)
        self.assertIn("Cambia un dato ya publicado", html)
        self.assertIn("101,0000", html)
        self.assertIn("999,0000", html)

    def segundo_mes(self, cambios):
        from servicio_datos.tests.test_publicacion import VersionadoTests
        return VersionadoTests.segundo_mes(self, cambios)

    def test_lo_que_trae_el_archivo_se_muestra_escapado(self):
        malo = Hallazgo("estructura", "alta", None, None, "<script>alert(1)</script> & \"comillas\"")
        candidato = self.abierto(hallazgos=[malo])
        html = self.get(f"/candidatos/{candidato}").get_data(as_text=True)
        self.assertNotIn("<script>alert(1)</script>", html)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", html)
        hallazgo = self.hallazgos_de(candidato)[0]
        self.post(f"/candidatos/{candidato}/revisar", candidato,
                  {"accion": "aceptar", "hallazgo": hallazgo, "comentario": "<img src=x onerror=alert(2)>"})
        html = self.get(f"/candidatos/{candidato}").get_data(as_text=True)
        self.assertNotIn("<img src=x", html)
        self.assertIn("&lt;img src=x", html)

    def test_un_candidato_que_no_existe_es_404(self):
        respuesta = self.get("/candidatos/99999")
        self.assertEqual(respuesta.status_code, 404)
        self.assertIn("No encontramos eso", respuesta.get_data(as_text=True))
        self.assertEqual(self.get("/corridas/99999").status_code, 404)

    def test_un_candidato_publicado_se_ve_sin_formularios(self):
        candidato = self.abierto(hallazgos=[A])
        self.aceptar_todos(candidato)
        p = self.publicar(candidato)
        html = self.get(f"/candidatos/{candidato}").get_data(as_text=True)
        self.assertIn(f"Publicado como <strong>{p.release_id}</strong> por juani", html)
        self.assertNotIn('name="csrf"', html)
        self.assertNotIn("Publicar versión", html)
        self.assertIn("Aceptado por juani", html)

    def test_las_propuestas_del_agente_se_muestran_y_frenan_la_publicacion(self):
        candidato = self.abierto(hallazgos=[A])
        hallazgo = self.hallazgos_de(candidato)[0]
        self.conn.execute("INSERT INTO propuesta (hallazgo_id, tipo, confianza, evidencia) VALUES (%s, 'nota', 'media', 'Según la nota metodológica')", (hallazgo,))
        self.aceptar_todos(candidato)
        html = self.get(f"/candidatos/{candidato}").get_data(as_text=True)
        self.assertIn("Propuesta del agente", html)
        self.assertIn("Según la nota metodológica", html)
        self.assertIn("Faltan decidir 1 propuesta", html)


class AccionesTests(BaseRevision):
    def test_aceptar_un_hallazgo_lo_registra_y_vuelve_a_la_pagina(self):
        candidato = self.abierto(hallazgos=[A, B])
        hallazgo = self.hallazgos_de(candidato)[0]
        respuesta = self.post(f"/candidatos/{candidato}/revisar", candidato, {"accion": "aceptar", "hallazgo": hallazgo, "comentario": "Es la devaluación"})
        self.assertEqual(respuesta.status_code, 303)
        self.assertEqual(respuesta.headers["Location"], f"/candidatos/{candidato}?ok=aceptado")
        self.assertEqual(self.conn.execute("SELECT decision, revisor, comentario FROM revision_hallazgo").fetchone(), ("aceptado", "juani", "Es la devaluación"))
        html = self.get(respuesta.headers["Location"]).get_data(as_text=True)
        self.assertIn("Hallazgo aceptado.", html)
        self.assertIn("«Es la devaluación»", html)
        self.assertIn("1 de 2", html)

    def test_rechazar_exige_un_motivo_y_conserva_lo_escrito(self):
        candidato = self.abierto(hallazgos=[A])
        hallazgo = self.hallazgos_de(candidato)[0]
        sin_motivo = self.post(f"/candidatos/{candidato}/revisar", candidato, {"accion": "rechazar", "hallazgo": hallazgo, "comentario": "   "})
        self.assertEqual(sin_motivo.status_code, 422)
        self.assertIn("Para rechazar escribí por qué.", sin_motivo.get_data(as_text=True))
        self.assertEqual(self.contar("revision_hallazgo"), 0)
        con_motivo = self.post(f"/candidatos/{candidato}/revisar", candidato, {"accion": "rechazar", "hallazgo": hallazgo, "comentario": "Parece un error de carga"})
        self.assertEqual(con_motivo.status_code, 303)
        html = self.get(f"/candidatos/{candidato}").get_data(as_text=True)
        self.assertIn("Rechazado por juani", html)
        self.assertIn("no se puede publicar", html)
        self.assertIn("Con rechazos", self.get("/").get_data(as_text=True))

    def test_se_puede_cambiar_de_opinion(self):
        candidato = self.abierto(hallazgos=[A])
        hallazgo = self.hallazgos_de(candidato)[0]
        self.post(f"/candidatos/{candidato}/revisar", candidato, {"accion": "rechazar", "hallazgo": hallazgo, "comentario": "Parece mal"})
        self.post(f"/candidatos/{candidato}/revisar", candidato, {"accion": "aceptar", "hallazgo": hallazgo, "comentario": "Es real"})
        self.assertIn("Aceptado por juani", self.get(f"/candidatos/{candidato}").get_data(as_text=True))
        self.assertEqual(self.contar("revision_hallazgo"), 2)

    def test_aceptar_los_pendientes_de_un_grupo_no_toca_los_otros(self):
        candidato = self.abierto(hallazgos=[A, B, Hallazgo("salto_mensual", "media", "ipc_ng_gba", date(2026, 4, 1), "varió 30%")])
        respuesta = self.post(f"/candidatos/{candidato}/aceptar-pendientes", candidato, {"regla": "salto_mensual", "comentario": "Devaluación"})
        self.assertEqual(respuesta.headers["Location"], f"/candidatos/{candidato}?ok=grupo&n=2")
        self.assertIn("Hallazgos aceptados. (2)", self.get(respuesta.headers["Location"]).get_data(as_text=True))
        self.assertEqual(self.contar("revision_hallazgo"), 2)
        self.assertEqual(self.uno("SELECT count(*) FROM revision_hallazgo WHERE comentario = 'Devaluación'"), 2)

    def test_aceptar_todos_sin_comentario_deja_uno_por_defecto_y_respeta_los_rechazados(self):
        candidato = self.abierto(hallazgos=[A, B, C])
        rechazado = self.hallazgos_de(candidato)[2]
        self.post(f"/candidatos/{candidato}/revisar", candidato, {"accion": "rechazar", "hallazgo": rechazado, "comentario": "Mal"})
        self.post(f"/candidatos/{candidato}/aceptar-pendientes", candidato, {})
        self.assertEqual(self.uno("SELECT count(*) FROM revision_hallazgo WHERE comentario = 'Revisado'"), 2)
        self.assertIn("1 hallazgo rechazado", self.get(f"/candidatos/{candidato}").get_data(as_text=True))

    def test_pedidos_que_no_corresponden_se_rechazan(self):
        uno, otro = self.abierto(hallazgos=[A]), None
        ajeno = self.hallazgos_de(uno)[0]
        otro = self.candidato(self.mes_nuevo(), hallazgos=[B])
        ruta = f"/candidatos/{otro}/revisar"
        for datos in ({"accion": "aceptar", "hallazgo": ajeno}, {"accion": "borrar", "hallazgo": 1}, {"accion": "aceptar"}, {"accion": "aceptar", "hallazgo": "x"}):
            self.assertEqual(self.post(ruta, otro, datos).status_code, 400, datos)
        self.assertEqual(self.post(f"/candidatos/{otro}/aceptar-pendientes", otro, {"regla": "inventada"}).status_code, 400)
        self.assertEqual(self.post("/candidatos/99999/publicar", otro).status_code, 404)

    def test_publicar_con_pendientes_dice_cuantos_faltan_y_no_publica(self):
        candidato = self.abierto()
        respuesta = self.post(f"/candidatos/{candidato}/publicar", candidato)
        self.assertEqual(respuesta.status_code, 422)
        self.assertIn("Faltan 3 hallazgos por resolver", respuesta.get_data(as_text=True))
        self.nada_publicado()

    def test_publicar_con_todo_resuelto_crea_el_release_a_nombre_de_quien_lo_hizo(self):
        candidato = self.abierto()
        self.post(f"/candidatos/{candidato}/aceptar-pendientes", candidato, {})
        respuesta = self.post(f"/candidatos/{candidato}/publicar", candidato, usuario="ana")
        self.assertEqual(respuesta.headers["Location"], f"/candidatos/{candidato}?ok=publicado")
        self.assertEqual(self.uno("SELECT aprobado_por FROM release"), "ana")
        self.assertEqual(self.estado(candidato), "publicado")
        self.assertIn("Candidato publicado.", self.get(respuesta.headers["Location"]).get_data(as_text=True))
        self.assertIn("Release vigente", self.get("/").get_data(as_text=True))

    def test_publicar_dos_veces_da_conflicto(self):
        candidato = self.abierto(hallazgos=[A])
        self.aceptar_todos(candidato)
        token = self.token(candidato)
        self.assertEqual(self.post(f"/candidatos/{candidato}/publicar", candidato, token=token).status_code, 303)
        repetido = self.post(f"/candidatos/{candidato}/publicar", candidato, token=token)
        self.assertEqual(repetido.status_code, 409)
        self.assertEqual(self.uno("SELECT count(*) FROM release"), 1)

    def test_descartar_exige_motivo_y_no_toca_lo_publicado(self):
        self.publicar(self.candidato(hasta=(2026, 7)))
        antes = self.contar("observacion")
        candidato = self.candidato(self.mes_nuevo(), hallazgos=[A])
        sin_motivo = self.post(f"/candidatos/{candidato}/descartar", candidato, {"motivo": " "})
        self.assertEqual(sin_motivo.status_code, 422)
        self.assertIn("escribí el motivo", sin_motivo.get_data(as_text=True))
        self.assertEqual(self.estado(candidato), "abierto")
        self.assertEqual(self.post(f"/candidatos/{candidato}/descartar", candidato, {"motivo": "Está mal cargado"}).status_code, 303)
        self.assertEqual(self.conn.execute("SELECT estado, decidido_por, motivo FROM candidato WHERE id = %s", (candidato,)).fetchone(), ("descartado", "juani", "Está mal cargado"))
        self.assertEqual(self.contar("observacion"), antes)
        self.assertIn("Está mal cargado", self.get(f"/candidatos/{candidato}").get_data(as_text=True))

    def test_no_se_revisa_un_candidato_ya_cerrado(self):
        candidato = self.abierto(hallazgos=[A])
        hallazgo = self.hallazgos_de(candidato)[0]
        token = self.token(candidato)
        self.post(f"/candidatos/{candidato}/descartar", candidato, {"motivo": "Mal"}, token=token)
        respuesta = self.post(f"/candidatos/{candidato}/revisar", candidato, {"accion": "aceptar", "hallazgo": hallazgo}, token=token)
        self.assertEqual(respuesta.status_code, 409)
        self.assertEqual(self.contar("revision_hallazgo"), 0)

    def test_un_aviso_inventado_en_la_direccion_no_se_refleja(self):
        candidato = self.abierto(hallazgos=[A])
        html = self.get(f"/candidatos/{candidato}?ok=<script>alert(1)</script>&n=<b>").get_data(as_text=True)
        self.assertNotIn("alert(1)", html)


class BaseCaidaTests(unittest.TestCase):
    def test_si_la_base_no_responde_muestra_un_mensaje_claro_sin_datos_de_conexion(self):
        app = crear_app("postgresql://usuario-secreto:clave-secreta@127.0.0.1:1/base?connect_timeout=1", {"juani": HASH})
        with self.assertLogs(app.logger, level="ERROR") as logs:
            respuesta = app.test_client().get("/", headers=basic("juani"))
        self.assertEqual(respuesta.status_code, 503)
        html = respuesta.get_data(as_text=True)
        self.assertIn("No se pudo conectar con la base de datos", html)
        for secreto in ("usuario-secreto", "clave-secreta", "127.0.0.1"):
            self.assertNotIn(secreto, html)
            self.assertNotIn(secreto, " ".join(logs.output))
        self.assertIn("OperationalError", " ".join(logs.output))
        self.assertEqual(app.test_client().get("/salud").status_code, 200)  # la salud no depende de la base


class CorridaTests(BaseRevision):
    def test_una_corrida_fallida_muestra_el_error_el_comando_y_los_archivos(self):
        self.leer.error = ValueError("No se pudo abrir la hoja «Índices aperturas»")
        resultado = self.correr()
        html = self.get(f"/corridas/{resultado.corrida_id}").get_data(as_text=True)
        self.assertIn("Índices aperturas", html)
        self.assertIn("python -m servicio_datos.ejecutar ipc", html)
        self.assertIn("sh_ipc_09_26.xls", html)
        self.assertIn("Reintentar es manual", html)

    def test_una_corrida_con_candidato_enlaza_a_la_revision(self):
        resultado = self.correr()
        html = self.get(f"/corridas/{resultado.corrida_id}").get_data(as_text=True)
        self.assertIn(f'href="/candidatos/{resultado.candidato_id}"', html)


class FormatoTests(unittest.TestCase):
    def test_los_numeros_van_a_la_espanola(self):
        from decimal import Decimal
        from servicio_datos.revision.grafico import numero
        self.assertEqual(numero(Decimal("10714.6255"), 4), "10.714,6255")
        self.assertEqual(numero(12361.4), "12.361")
        self.assertEqual(numero(None), "—")


class ComandoTests(unittest.TestCase):
    def test_revisores_desde_el_entorno(self):
        h1, h2 = generate_password_hash("clave-uno-larga", method="pbkdf2:sha256:1000"), generate_password_hash("clave-dos-larga", method="scrypt")
        revisores = cli.revisores_desde_entorno(f"juani={h1}; ana={h2} ;")
        self.assertEqual(sorted(revisores), ["ana", "juani"])
        self.assertTrue(check_password_hash(revisores["ana"], "clave-dos-larga"))
        self.assertEqual(cli.revisores_desde_entorno(None), {})
        for malo in ("juani", "=hash", "juani="):
            with self.assertRaises(ValueError):
                cli.revisores_desde_entorno(malo)

    def test_clave_genera_la_linea_para_el_entorno_y_exige_una_clave_larga(self):
        import contextlib
        import io
        salida = io.StringIO()
        with patch("getpass.getpass", side_effect=["una clave bien larga", "una clave bien larga"]), contextlib.redirect_stdout(salida), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli.main(["clave", "juani"]), 0)
        usuario, _, hash_clave = salida.getvalue().strip().partition("=")
        self.assertEqual(usuario, "juani")
        self.assertTrue(check_password_hash(hash_clave, "una clave bien larga"))
        with patch("getpass.getpass", side_effect=["corta"]), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli.main(["clave", "juani"]), 1)
        with patch("getpass.getpass", side_effect=["una clave bien larga", "otra distinta larga"]), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli.main(["clave", "juani"]), 1)


if __name__ == "__main__":
    unittest.main()
