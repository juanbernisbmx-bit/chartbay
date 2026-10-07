// La base del servicio, por las funciones SQL de las migraciones 0011 y 0012. La conexión es directa a Postgres (no por la
// API de Supabase), así que el esquema `economia` sigue sin exponerse. Conviene el rol `datos_escritura`, no el administrador.
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

export function basePostgres(url: string, opciones: { searchPath?: string } = {}): Base {
  const sql = postgres(url, {
    prepare: false, // el pooler de Supabase en modo transacción no admite sentencias preparadas
    max: 1,
    idle_timeout: 5,
    connect_timeout: 15,
    onnotice: () => {},
    ...(opciones.searchPath ? { connection: { search_path: opciones.searchPath } } : {}),
  });
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
      await una(sql`SELECT asegurar_fuente(${id}, ${nombre}, ${urlBase})`);
    },
    async abrirCorrida(fuente, vencimientoSegundos) {
      const fila = await una(sql`SELECT abrir_corrida(${fuente}, ${vencimientoSegundos}::float8) AS id`);
      return fila.id === null ? null : Number(fila.id);
    },
    async ultimaDescarga(url) {
      const fila = await una(sql`SELECT sha256 FROM ultima_descarga(${url})`);
      return fila?.sha256 ?? null;
    },
    async registrarDescarga(d) {
      const fila = await una(sql`SELECT registrar_descarga(${d.corrida}, ${d.url}, ${d.estado}, ${d.sha256 ?? null}, ${d.bytes ?? null},
                                                          ${d.rutaCrudo ?? null}, ${d.publicadaEn ?? null}, ${d.error ?? null}) AS id`);
      return Number(fila.id);
    },
    async anotarCorrida(corrida, resumen) {
      await una(sql`SELECT anotar_corrida(${corrida}, ${json(resumen)})`);
    },
    async cerrarCorrida(corrida, estado, error = null, resumen = null) {
      const fila = await una(sql`SELECT cerrar_corrida(${corrida}, ${estado}, ${error}, ${resumen === null ? null : json(resumen)}) AS cerrada`);
      return Boolean(fila.cerrada);
    },
    async cargarCandidato(corrida, hoy, carga) {
      const fila = await una(sql`SELECT cargar_candidato(${corrida}, ${hoy}::date, ${json(carga)}) AS resultado`);
      return fila.resultado;
    },
    async cerrar() {
      await sql.end({ timeout: 5 });
    },
  };
}
