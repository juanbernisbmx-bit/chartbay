import { describe, expect, it } from 'vitest';
import { assessAgroModelCapacity } from '../../src/verticals/agro/agroModelCapacity';

describe('assessAgroModelCapacity', () => {
  it('unsafe cuando rowCount <= selectedXCount + 2', () => {
    expect(assessAgroModelCapacity(7, 5).level).toBe('unsafe');
    expect(assessAgroModelCapacity(6, 5).level).toBe('unsafe'); // límite exacto: 6 <= 5+2
    expect(assessAgroModelCapacity(2, 0).level).toBe('unsafe'); // 2 <= 0+2
  });

  it('no es unsafe apenas se supera el límite', () => {
    expect(assessAgroModelCapacity(8, 5).level).not.toBe('unsafe'); // 8 > 5+2
  });

  it('warning cuando rowCount < selectedXCount * 5 (y no es unsafe)', () => {
    const result = assessAgroModelCapacity(20, 5); // 20 < 25
    expect(result.level).toBe('warning');
  });

  it('safe cuando rowCount >= selectedXCount * 5', () => {
    const result = assessAgroModelCapacity(25, 5); // 25 >= 25
    expect(result.level).toBe('safe');
  });

  it('safe con muchas observaciones y pocas X', () => {
    expect(assessAgroModelCapacity(1000, 3).level).toBe('safe');
  });

  it('agrega warning categórico cuando hay categóricas y rowCount es chico', () => {
    const result = assessAgroModelCapacity(50, 2, 1); // safe por n/k (50 >= 10) pero rowCount < 100
    expect(result.level).toBe('warning');
    expect(result.messages.some(m => m.includes('categórica'))).toBe(true);
  });

  it('no agrega warning categórico si rowCount es grande', () => {
    const result = assessAgroModelCapacity(500, 3, 2);
    expect(result.level).toBe('safe');
    expect(result.messages.some(m => m.includes('categórica'))).toBe(false);
  });

  it('no agrega warning categórico si categoricalXCount es 0', () => {
    const result = assessAgroModelCapacity(50, 2, 0);
    expect(result.level).toBe('safe');
    expect(result.messages.some(m => m.includes('categórica'))).toBe(false);
  });

  it('el warning categórico no sobreescribe un unsafe existente', () => {
    const result = assessAgroModelCapacity(6, 5, 2); // unsafe por n/k
    expect(result.level).toBe('unsafe');
  });

  it('calcula maxRecommendedX como floor(rowCount / 5)', () => {
    expect(assessAgroModelCapacity(1000, 3).maxRecommendedX).toBe(200);
    expect(assessAgroModelCapacity(23, 2).maxRecommendedX).toBe(4);
    expect(assessAgroModelCapacity(0, 0).maxRecommendedX).toBe(0);
  });

  it('siempre devuelve al menos un mensaje', () => {
    expect(assessAgroModelCapacity(1000, 3).messages.length).toBeGreaterThan(0);
    expect(assessAgroModelCapacity(6, 5).messages.length).toBeGreaterThan(0);
    expect(assessAgroModelCapacity(20, 5).messages.length).toBeGreaterThan(0);
  });

  it('categoricalXCount por defecto es 0 (parámetro opcional)', () => {
    const withDefault = assessAgroModelCapacity(50, 2);
    const explicit = assessAgroModelCapacity(50, 2, 0);
    expect(withDefault).toEqual(explicit);
  });
});
