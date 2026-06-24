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

export function extractColumn(
  rows: Record<string, unknown>[],
  column: string
): number[] {
  return rows
    .map(row => Number(row[column]))
    .filter(v => !isNaN(v) && isFinite(v));
}

export function extractMatrix(
  rows: Record<string, unknown>[],
  columns: string[]
): { X: number[][]; validIndices: number[] } {
  const X: number[][] = [];
  const validIndices: number[] = [];
  rows.forEach((row, i) => {
    const vals = columns.map(col => Number(row[col]));
    if (vals.every(v => !isNaN(v) && isFinite(v))) {
      X.push(vals);
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
  const valid = rows.filter(row =>
    allCols.every(col => {
      const v = Number(row[col]);
      return !isNaN(v) && isFinite(v);
    })
  );
  return {
    X: valid.map(row => xNames.map(col => Number(row[col]))),
    y: valid.map(row => Number(row[yName])),
    dropped: rows.length - valid.length,
  };
}
