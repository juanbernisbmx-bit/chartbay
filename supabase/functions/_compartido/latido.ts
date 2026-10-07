// El latido hacia el monitor externo (protocolo de Healthchecks): si la función programada deja de correr, el silencio avisa.
// Es lo mismo que `servicio_datos/monitor.py`, para las funciones de Supabase. La dirección es una credencial: nunca se muestra.
export async function latir(url: string | undefined, cuerpo: string, falla: boolean): Promise<string | null> {
  if (!url) return null;
  try {
    const destino = url.replace(/\/+$/, "") + (falla ? "/fail" : "");
    if (!destino.startsWith("https://")) return "el monitor tiene que ser https";
    const respuesta = await fetch(destino, { method: "POST", body: cuerpo.slice(0, 10_000), redirect: "manual", signal: AbortSignal.timeout(10_000) });
    await respuesta.body?.cancel();
    return respuesta.ok ? null : `el monitor respondió HTTP ${respuesta.status}`;
  } catch (error) {
    return `no se pudo hablar con el monitor (${(error as Error).name})`;
  }
}
