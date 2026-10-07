// Fechas como las necesita el servicio.

/** La fecha de hoy en Argentina (AAAA-MM-DD): la del calendario de INDEC. */
export function hoyEnArgentina(ahora: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(ahora);
}

/** Como `datetime.isoformat()` de Python en UTC: "2026-09-10T18:52:05+00:00", con milisegundos solo si los tiene. */
export function isoUtc(fecha: Date): string {
  const texto = fecha.toISOString();
  return (texto.endsWith(".000Z") ? texto.slice(0, -5) : texto.slice(0, -1) + "000") + "+00:00";
}
