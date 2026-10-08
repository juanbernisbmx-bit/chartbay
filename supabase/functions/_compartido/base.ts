// La base del servicio, por las funciones del esquema `servicio` (`servicio_datos/api_servicio.py`), que envuelven las de las
// migraciones. La conexión es directa a Postgres (no por la API de Supabase) y con el rol `servicio_datos`, que solo puede
// ejecutar esas funciones: no ve las tablas, no revisa ni publica. El esquema `economia` sigue sin exponerse.
import postgres from "npm:postgres@3.4.5";

/** Un error de negocio de la base (SQLSTATE CB001): `codigo` es el DETAIL (`carga_invalida`, `corrida_cerrada`...). */
export class ErrorNegocio extends Error {
  override name = "ErrorNegocio";
  constructor(readonly codigo: string, mensaje: string) {
    super(mensaje);
  }
}

export interface Descarga {
  corrida: number;
  url: string;
  estado: "nueva" | "identica" | "fallida";
  sha256?: string | null;
  bytes?: number | null;
  rutaCrudo?: string | null;
  publicadaEn?: Date | null;
  error?: string | null;
}

export interface Base {
  asegurarFuente(id: string, nombre: string, urlBase: string): Promise<void>;
  abrirCorrida(fuente: string, vencimientoSegundos: number): Promise<number | null>;
  ultimaDescarga(url: string): Promise<string | null>;
  registrarDescarga(descarga: Descarga): Promise<number>;
  anotarCorrida(corrida: number, resumen: Record<string, unknown>): Promise<void>;
  cerrarCorrida(corrida: number, estado: string, error?: string | null, resumen?: Record<string, unknown> | null): Promise<boolean>;
  cargarCandidato(corrida: number, hoy: string, carga: Record<string, unknown>): Promise<Record<string, unknown>>;
  cerrar(): Promise<void>;
}

export interface Tomados {
  descartados: number; // dejaron de ser ciertos antes de entregarse
  en_curso: number; // reservados por otra entrega que todavía no terminó
  avisos: AvisoTomado[];
}

export interface AvisoTomado {
  id: number;
  asunto: string;
  cuerpo: string;
  ruta: string | null;
  entregas: Record<string, Entrega>;
  intentos: number;
}

/** Cómo le fue a un canal con un aviso. El error nunca lleva secretos. */
export type Entrega = { ok: true; en: string } | { ok: false; error: string };

export interface BaseAvisos {
  detectar(hoy: string, recordatorioDias: number): Promise<number>;
  tomar(hoy: string, segundos: number): Promise<Tomados>;
  registrarEntrega(aviso: number, entregas: Record<string, Entrega>, completo: boolean): Promise<string>;
  cerrar(): Promise<void>;
}

/** La conexión y lo que comparten las dos bases: `api` es el esquema, que cada llamada nombra sin depender del search_path. */
function conectar(url: string, esquema: string) {
  const sql = postgres(url, {
    prepare: false, // el pooler de Supabase en modo transacción no admite sentencias preparadas
    max: 1,
    idle_timeout: 5,
    connect_timeout: 15,
    onnotice: () => {},
  });
  // deno-lint-ignore no-explicit-any
  const traducir = (error: any): never => {
    if (error?.code === "CB001") throw new ErrorNegocio(error.detail ?? "error", error.message);
    throw error;
  };
  return {
    sql,
    api: sql(esquema),
    // deno-lint-ignore no-explicit-any
    una: async (consulta: Promise<any>) => (await consulta.catch(traducir))[0],
    json: (valor: unknown) => sql.json(valor as never),
    cerrar: () => sql.end({ timeout: 5 }),
  };
}

export function basePostgres(url: string, esquema = "servicio"): Base {
  const { sql, api, una, json, cerrar } = conectar(url, esquema);
  return {
    async asegurarFuente(id, nombre, urlBase) {
      await una(sql`SELECT ${api}.asegurar_fuente(${id}, ${nombre}, ${urlBase})`);
    },
    async abrirCorrida(fuente, vencimientoSegundos) {
      const fila = await una(sql`SELECT ${api}.abrir_corrida(${fuente}, ${vencimientoSegundos}::float8) AS id`);
      return fila.id === null ? null : Number(fila.id);
    },
    async ultimaDescarga(url) {
      const fila = await una(sql`SELECT sha256 FROM ${api}.ultima_descarga(${url})`);
      return fila?.sha256 ?? null;
    },
    async registrarDescarga(d) {
      const fila = await una(sql`SELECT ${api}.registrar_descarga(${d.corrida}, ${d.url}, ${d.estado}, ${d.sha256 ?? null}, ${d.bytes ?? null},
                                                                 ${d.rutaCrudo ?? null}, ${d.publicadaEn ?? null}, ${d.error ?? null}) AS id`);
      return Number(fila.id);
    },
    async anotarCorrida(corrida, resumen) {
      await una(sql`SELECT ${api}.anotar_corrida(${corrida}, ${json(resumen)})`);
    },
    async cerrarCorrida(corrida, estado, error = null, resumen = null) {
      const fila = await una(sql`SELECT ${api}.cerrar_corrida(${corrida}, ${estado}, ${error}, ${resumen === null ? null : json(resumen)}) AS cerrada`);
      return Boolean(fila.cerrada);
    },
    async cargarCandidato(corrida, hoy, carga) {
      const fila = await una(sql`SELECT ${api}.cargar_candidato(${corrida}, ${hoy}::date, ${json(carga)}) AS resultado`);
      return fila.resultado;
    },
    async cerrar() {
      await cerrar();
    },
  };
}

export function baseAvisosPostgres(url: string, esquema = "servicio"): BaseAvisos {
  const { sql, api, una, json, cerrar } = conectar(url, esquema);
  return {
    async detectar(hoy, recordatorioDias) {
      const fila = await una(sql`SELECT ${api}.detectar_avisos(${hoy}::date, now(), 25, ${recordatorioDias}) AS creados`);
      return Number(fila.creados);
    },
    async tomar(hoy, segundos) {
      const fila = await una(sql`SELECT ${api}.tomar_avisos(${hoy}::date, 25, ${segundos}) AS tomados`);
      const tomados = fila.tomados as Tomados;
      return { ...tomados, avisos: tomados.avisos.map((a) => ({ ...a, id: Number(a.id) })) };
    },
    async registrarEntrega(aviso, entregas, completo) {
      const fila = await una(sql`SELECT ${api}.registrar_entrega(${aviso}, ${json(entregas)}, ${completo}) AS estado`);
      return String(fila.estado);
    },
    async cerrar() {
      await cerrar();
    },
  };
}
