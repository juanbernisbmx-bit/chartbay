// Un número como lo escribe Python (`str(float)`): 100 → "100.0", 101.5859 → "101.5859". El parser de Python guardaba
// `Decimal(str(valor))`; escribirlo igual hace que las dos implementaciones den exactamente la misma carga.
export function comoPython(valor: number): string {
  if (!Number.isFinite(valor)) return Number.isNaN(valor) ? "NaN" : valor > 0 ? "Infinity" : "-Infinity";
  if (Number.isInteger(valor) && Math.abs(valor) < 1e16) return `${Object.is(valor, -0) ? "-0" : valor}.0`;
  return String(valor); // el más corto que vuelve al mismo número, igual que Python, en el rango de un índice
}
