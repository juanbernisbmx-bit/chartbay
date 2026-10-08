import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import type { AvisoTomado, BaseAvisos, Entrega, Tomados } from "../_compartido/base.ts";
import { type Canal, ErrorEnvio, type Mensaje } from "../_compartido/canales.ts";
import { avisar, type Configuracion, configuracionDesdeEntorno, enlace } from "./avisos.ts";

const HOY = "2026-10-06";
const REVISION = "https://chartbay.example/base-de-datos/revision";

function aviso(id: number, extra: Partial<AvisoTomado> = {}): AvisoTomado {
  return { id, asunto: `Asunto ${id}`, cuerpo: `Cuerpo ${id}`, ruta: `/candidatos/${id}`, entregas: {}, intentos: 0, ...extra };
}

class BaseFalsa implements BaseAvisos {
  llamadas: string[] = [];
  registradas: { aviso: number; entregas: Record<string, Entrega>; completo: boolean }[] = [];
  constructor(readonly tomados: Tomados = { descartados: 0, en_curso: 0, avisos: [] }, readonly estados: Record<number, string> = {}) {}
  async detectar(hoy: string, recordatorioDias: number) {
    this.llamadas.push(`detectar ${hoy} ${recordatorioDias}`);
    return await Promise.resolve(this.tomados.avisos.length);
  }
  async tomar(hoy: string, segundos: number) {
    this.llamadas.push(`tomar ${hoy} ${segundos}`);
    return await Promise.resolve(this.tomados);
  }
  async registrarEntrega(aviso: number, entregas: Record<string, Entrega>, completo: boolean) {
    this.registradas.push({ aviso, entregas, completo });
    return await Promise.resolve(this.estados[aviso] ?? (completo ? "enviado" : "pendiente"));
  }
  async cerrar() {}
}

class CanalFalso implements Canal {
  mensajes: Mensaje[] = [];
  constructor(readonly nombre = "falso", public falla: unknown = null) {}
  async enviar(mensaje: Mensaje) {
    if (this.falla) throw this.falla;
    this.mensajes.push(await Promise.resolve(mensaje));
  }
}

const configuracion = (canales: Canal[], extra: Partial<Configuracion> = {}): Configuracion => ({ canales, urlRevision: REVISION, recordatorioDias: 3, ...extra });

Deno.test("sin canales no toca la base: al configurar uno después no llega de golpe lo acumulado", async () => {
  const base = new BaseFalsa();
  const resultado = await avisar(base, configuracion([]), HOY);
  assertEquals([resultado.sin_canales, resultado.creados, base.llamadas], [true, 0, []]);
});

Deno.test("detecta, toma y manda cada aviso con su enlace, y anota cómo fue", async () => {
  const base = new BaseFalsa({ descartados: 2, en_curso: 0, avisos: [aviso(3), aviso(4, { ruta: "/corridas/9" }), aviso(5, { ruta: "/" }), aviso(6, { ruta: null })] });
  const canal = new CanalFalso();
  const resultado = await avisar(base, configuracion([canal], { recordatorioDias: 0 }), HOY);
  assertEquals(base.llamadas, [`detectar ${HOY} 0`, `tomar ${HOY} 300`]);
  assertEquals(canal.mensajes.map((m) => m.enlace), [`${REVISION}#candidato=3`, `${REVISION}#corrida=9`, REVISION, null]);
  assertEquals(canal.mensajes[0], { asunto: "Asunto 3", cuerpo: "Cuerpo 3", enlace: `${REVISION}#candidato=3` });
  assertEquals(base.registradas.map((r) => [r.aviso, r.completo, r.entregas.falso.ok]), [[3, true, true], [4, true, true], [5, true, true], [6, true, true]]);
  assertEquals(resultado, { creados: 4, enviados: 4, descartados: 2, fallidos: 0, pendientes: 0, ocupado: false, errores: [] });
});

Deno.test("un canal caído queda anotado para reintentar, y el que ya llegó no se repite", async () => {
  const base = new BaseFalsa({ descartados: 0, en_curso: 1, avisos: [aviso(3, { entregas: { slack: { ok: true, en: "2026-10-06T12:00:00Z" } }, intentos: 1 })] });
  const slack = new CanalFalso("slack"), correo = new CanalFalso("email", new ErrorEnvio("SMTP caído"));
  const resultado = await avisar(base, configuracion([slack, correo]), HOY);
  assertEquals(slack.mensajes, []);
  assertEquals(base.registradas[0].completo, false);
  assertEquals(base.registradas[0].entregas, { slack: { ok: true, en: "2026-10-06T12:00:00Z" }, email: { ok: false, error: "SMTP caído" } });
  assertEquals([resultado.pendientes, resultado.ocupado, resultado.errores], [1, true, ["email: SMTP caído"]]);
});

Deno.test("un canal que explota no frena a los demás ni deja ver su mensaje", async () => {
  const base = new BaseFalsa({ descartados: 0, en_curso: 0, avisos: [aviso(3), aviso(4)] }, { 4: "fallido" });
  const explota = new CanalFalso("email", new TypeError("clave-secreta-del-smtp")), bueno = new CanalFalso("slack");
  const resultado = await avisar(base, configuracion([explota, bueno]), HOY);
  assertEquals(bueno.mensajes.length, 2);
  assertEquals(resultado.errores, ["email: Falló la entrega (TypeError)", "email: Falló la entrega (TypeError)"]);
  assert(!JSON.stringify(base.registradas).includes("clave-secreta"));
  assertEquals([resultado.pendientes, resultado.fallidos, resultado.enviados], [1, 1, 0]);
});

Deno.test("el enlace: candidatos y corridas van a su ancla; lo demás, a la página", () => {
  assertEquals(enlace(REVISION, "/candidatos/12"), `${REVISION}#candidato=12`);
  assertEquals(enlace(REVISION, "/corridas/7"), `${REVISION}#corrida=7`);
  assertEquals(enlace(REVISION, "/"), REVISION);
  assertEquals(enlace(REVISION, "/candidatos/12/otra"), REVISION);
  assertEquals([enlace(null, "/candidatos/1"), enlace(REVISION, null)], [null, null]);
});

Deno.test("la configuración sale del entorno y sus errores no repiten secretos", () => {
  assertEquals(configuracionDesdeEntorno({}), { canales: [], urlRevision: null, recordatorioDias: 3 });
  const conf = configuracionDesdeEntorno({ DATOS_AVISOS_SLACK_URL: "https://hooks.slack.com/services/T/B/x", DATOS_REVISION_URL: ` ${REVISION}/ `,
                                           DATOS_AVISOS_RECORDATORIO_DIAS: "0" });
  assertEquals([conf.canales.map((c) => c.nombre), conf.urlRevision, conf.recordatorioDias], [["slack"], REVISION, 0]);
  const error = assertThrows(() => configuracionDesdeEntorno({ DATOS_AVISOS_SLACK_URL: "https://otro.example/secreto" }));
  assert(!(error as Error).message.includes("secreto"));
  const discord = "https://discord.com/api/webhooks/123456789012345678/token-secreto-abcdefghijklmn";
  assertEquals(configuracionDesdeEntorno({ DATOS_AVISOS_DISCORD_URL: discord }).canales.map((c) => c.nombre), ["discord"]);
  assertEquals(configuracionDesdeEntorno({ DATOS_AVISOS_DISCORD_URL: discord, DATOS_AVISOS_SLACK_URL: "https://hooks.slack.com/services/T/B/x" })
    .canales.map((c) => c.nombre), ["slack", "discord"]);
  const mala = assertThrows(() => configuracionDesdeEntorno({ DATOS_AVISOS_DISCORD_URL: "https://discord.com/api/webhooks/1/token-secreto-corto?x=1" }));
  assert(!(mala as Error).message.includes("token-secreto"));
  assertThrows(() => configuracionDesdeEntorno({ DATOS_REVISION_URL: "chartbay.example" }), Error, "https://");
  for (const dias of ["-1", "61", "tres", "2.5"]) {
    assertThrows(() => configuracionDesdeEntorno({ DATOS_AVISOS_RECORDATORIO_DIAS: dias }), Error, "entre 0 (sin recordatorios) y 60");
  }
});
