import { describe, expect, it } from 'vitest';
import { prepareDataset, type EconomicSeries, type Selection, type Snapshot } from '../../src/database/dataset';

function series(id: string, points: Array<[string, number | null]>): EconomicSeries {
  return { id, name: id, available: true, frequency: 'Mensual', unit: 'Indice',
    observations: points.map(([date, value]) => ({ date, value })) } as EconomicSeries;
}
const a = series('a', [['2020-03', 121], ['2020-01', 100], ['2020-02', 110]]);
const snapshot = (...series: EconomicSeries[]): Snapshot => ({ schema_version: 1, release_id: 'test', series });
const choice = (id: string, transform: Selection['transform'] = 'level', lag = 0): Selection => ({ id, transform, lag });
const options = { start: '', end: '', completeOnly: true };

describe('economic database dataset', () => {
  it('joins unordered observations by calendar month, not row position', () => {
    const result = prepareDataset(snapshot(a, series('b', [['2020-02', 0], ['2020-03', 3]])), [choice('a'), choice('b')], options);
    expect(result.rows).toEqual([['2020-02-01', 110, 0], ['2020-03-01', 121, 3]]);
    expect(result.excludedMonths).toEqual(['2020-01-01']);
    expect(result.csv).toBe('fecha,a,b\n2020-02-01,110,0\n2020-03-01,121,3\n');
  });
  it('retains missing observations as null, never as zero', () => {
    const result = prepareDataset(snapshot(series('a', [['2020-01', 0], ['2020-03', 2]])), [choice('a')], { ...options, completeOnly: false });
    expect(result.rows).toEqual([['2020-01-01', 0], ['2020-02-01', null], ['2020-03-01', 2]]);
    expect(result.excludedMonths).toEqual([]);
    expect(result.incompleteMonths).toEqual(['2020-02-01']);
  });
  it('computes transformations before trimming dates and uses calendar lags', () => {
    const result = prepareDataset(snapshot(a), [choice('a', 'monthly', 1)], { ...options, start: '2020-03', end: '2020-03' });
    expect(result.rows).toEqual([['2020-03-01', 10]]);
    expect(result.headers).toEqual(['fecha', 'a_monthly_lag1']);
  });
  it('does not bridge a missing month for differences or monthly returns', () => {
    const data = snapshot(series('a', [['2020-01', 100], ['2020-03', 121]]));
    for (const transform of ['monthly', 'difference'] as const) {
      expect(prepareDataset(data, [choice('a', transform)], options).rows).toEqual([]);
    }
  });
  it('uses the same calendar month twelve months earlier for annual changes', () => {
    const data = snapshot(series('a', [['2020-01', 100], ['2021-01', 150]]));
    expect(prepareDataset(data, [choice('a', 'annual')], options).rows).toEqual([['2021-01-01', 50]]);
  });
  it('handles differences, logarithms and zero denominators explicitly', () => {
    expect(prepareDataset(snapshot(a), [choice('a', 'difference')], options).rows).toEqual([['2020-02-01', 10], ['2020-03-01', 11]]);
    const data = snapshot(series('b', [['2020-01', 0], ['2020-02', -1], ['2020-03', 2]]));
    expect(prepareDataset(data, [choice('b', 'log')], options).rows).toEqual([['2020-03-01', Math.log(2)]]);
    expect(prepareDataset(data, [choice('b', 'monthly')], options).rows).toEqual([['2020-03-01', -300]]);
  });
  it('rejects unavailable, duplicate and incompatible selections', () => {
    expect(() => prepareDataset(snapshot(a), [choice('missing')], options)).toThrow('todavía');
    expect(() => prepareDataset(snapshot(a), [choice('a'), choice('a')], options)).toThrow('diferentes');
    expect(() => prepareDataset(snapshot({ ...a, frequency: 'Trimestral' }), [choice('a')], options)).toThrow('mensuales');
    expect(() => prepareDataset(snapshot(a), [choice('a', 'toString' as never)], options)).toThrow('no válido');
    expect(() => prepareDataset(snapshot(a), [choice('a', 'level', -1)], options)).toThrow('no válido');
  });
  it('rejects malformed observations and periods', () => {
    for (const points of [[['2020-01', 1], ['2020-01', 2]], [['2020-01', NaN]], [['2020-13', 1]]] as Array<Array<[string, number]>>) {
      expect(() => prepareDataset(snapshot(series('b', points)), [choice('b')], options)).toThrow();
    }
    expect(() => prepareDataset(snapshot(a), [choice('a')], { ...options, start: '2021-01', end: '2020-01' })).toThrow('anterior');
  });
});
