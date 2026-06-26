function cleanNumber(value: number): number {
  const rounded = Number(value.toFixed(12));
  return Math.abs(rounded) < 1e-12 ? 0 : rounded;
}

export function simpleDifference(values: number[]): Array<number | null> {
  return values.map((value, index) => (index === 0 ? null : cleanNumber(value - values[index - 1])));
}

export function percentReturn(values: number[]): Array<number | null> {
  return values.map((value, index) => {
    if (index === 0) return null;
    const previous = values[index - 1];
    if (previous === 0) return null;
    return cleanNumber(((value - previous) / previous) * 100);
  });
}

export function logReturn(values: number[]): Array<number | null> {
  return values.map((value, index) => {
    if (index === 0) return null;
    const previous = values[index - 1];
    if (previous <= 0 || value <= 0) return null;
    return cleanNumber(Math.log(value / previous));
  });
}

export function normalizeBase100(values: number[]): Array<number | null> {
  if (values.length === 0) return [];
  const base = values[0];
  if (base === 0 || !Number.isFinite(base)) return values.map(() => null);
  return values.map(value => cleanNumber((value / base) * 100));
}

export function simpleMovingAverage(values: number[], window: number): Array<number | null> {
  if (!Number.isInteger(window) || window <= 0) {
    throw new Error('Moving average window must be a positive integer.');
  }

  return values.map((_, index) => {
    if (index + 1 < window) return null;
    const slice = values.slice(index + 1 - window, index + 1);
    return cleanNumber(slice.reduce((sum, value) => sum + value, 0) / window);
  });
}
