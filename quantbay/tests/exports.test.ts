import { describe, expect, it } from 'vitest';
import { csvCell } from '../src/ui/exports';

describe('csvCell', () => {
  it('leaves plain values unchanged', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(42)).toBe('42');
  });

  it('quotes commas and escapes quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('prefixes spreadsheet formulas before quoting', () => {
    expect(csvCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(csvCell('-1,2')).toBe(`"'-1,2"`);
  });
});
