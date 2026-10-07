// Dónde se guarda el crudo: el bucket privado `economia-crudos` de Supabase Storage. El nombre es el hash del contenido
// (`ab/ab12…ef.xls`), así que guardar dos veces lo mismo no duplica nada y un archivo no puede cambiar sin cambiar de nombre.
// La procedencia (URL, hash, tamaño, Last-Modified) queda en la tabla `descarga`, con esta ruta en `ruta_crudo`.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

export const BUCKET_CRUDO = "economia-crudos";

export interface Almacen {
  guardar(ruta: string, contenido: Uint8Array, tipo: string): Promise<void>;
}

export function rutaCrudo(sha256: string, extension = ".xls"): string {
  return `${sha256.slice(0, 2)}/${sha256}${extension}`;
}

export async function sha256Hex(contenido: Uint8Array): Promise<string> {
  const digesto = await crypto.subtle.digest("SHA-256", contenido as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digesto), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function almacenSupabase(url: string, clave: string, bucket = BUCKET_CRUDO): Almacen {
  const cliente = createClient(url, clave, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    async guardar(ruta, contenido, tipo) {
      const { error } = await cliente.storage.from(bucket).upload(ruta, contenido, { contentType: tipo, upsert: false });
      // Ya estaba: el nombre es el hash, así que es el mismo contenido.
      // deno-lint-ignore no-explicit-any
      const yaEstaba = error && (String((error as any).statusCode ?? (error as any).status) === "409" || /exist|duplicate/i.test(error.message));
      if (error && !yaEstaba) throw new Error(`No se pudo guardar el crudo ${ruta}: ${error.message}`);
    },
  };
}
