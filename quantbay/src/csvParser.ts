/* eslint-disable @typescript-eslint/no-explicit-any */
declare const Papa: any; // loaded via CDN (PapaParse)

export interface ParsedCSV {
  headers: string[];
  rows: Record<string, unknown>[];
  numericColumns: string[];
}

export function parseCSVFile(file: File): Promise<ParsedCSV> {
  if (typeof Papa === 'undefined') {
    return Promise.reject(new Error('PapaParse no cargado'));
  }
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
      complete(result: { meta: { fields?: string[] }; data: Record<string, unknown>[] }) {
        const headers = result.meta.fields ?? [];
        const rows = result.data;
        const numericColumns = headers.filter(
          h =>
            rows.length > 0 &&
            rows.every(row => {
              const v = row[h];
              return v !== null && v !== '' && !isNaN(Number(v));
            })
        );
        resolve({ headers, rows, numericColumns });
      },
      error(err: unknown) {
        reject(new Error(String(err)));
      },
    });
  });
}

function isValidNumeric(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === '') return false;
  const v = Number(raw);
  return !isNaN(v) && isFinite(v);
}

export function extractColumn(
  rows: Record<string, unknown>[],
  column: string
): number[] {
  return rows.reduce<number[]>((acc, row) => {
    const raw = row[column];
    if (isValidNumeric(raw)) acc.push(Number(raw));
    return acc;
  }, []);
}

export function extractMatrix(
  rows: Record<string, unknown>[],
  columns: string[]
): { X: number[][]; validIndices: number[] } {
  const X: number[][] = [];
  const validIndices: number[] = [];
  rows.forEach((row, i) => {
    if (columns.every(col => isValidNumeric(row[col]))) {
      X.push(columns.map(col => Number(row[col])));
      validIndices.push(i);
    }
  });
  return { X, validIndices };
}

export function getValidRows(
  rows: Record<string, unknown>[],
  yName: string,
  xNames: string[]
): { X: number[][]; y: number[]; dropped: number } {
  const allCols = [yName, ...xNames];
  const valid = rows.filter(row => allCols.every(col => isValidNumeric(row[col])));
  return {
    X: valid.map(row => xNames.map(col => Number(row[col]))),
    y: valid.map(row => Number(row[yName])),
    dropped: rows.length - valid.length,
  };
}
