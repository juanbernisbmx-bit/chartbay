// La base del servicio, por las funciones del esquema `colecta` (`servicio_datos/api_colecta.py`), que envuelven las de las
// migraciones 0011 y 0012. La conexión es directa a Postgres (no por la API de Supabase) y con el rol `colector`, que solo puede
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

/** `esquema`: donde están las funciones; cada llamada lo nombra, sin depender del search_path de la conexión. */
export function basePostgres(url: string, esquema = "colecta"): Base {
  const sql = postgres(url, {
    prepare: false, // el pooler de Supabase en modo transacción no admite sentencias preparadas
    max: 1,
    idle_timeout: 5,
    connect_timeout: 15,
    onnotice: () => {},
  });
  const api = sql(esquema);
  // deno-lint-ignore no-explicit-any
  const traducir = (error: any): never => {
    if (error?.code === "CB001") throw new ErrorNegocio(error.detail ?? "error", error.message);
    throw error;
  };
  // deno-lint-ignore no-explicit-any
  const una = async (consulta: Promise<any>) => (await consulta.catch(traducir))[0];
  const json = (valor: unknown) => sql.json(valor as never);
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
      await sql.end({ timeout: 5 });
    },
  };
}
