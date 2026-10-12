import { describe, expect, it } from 'vitest';
import { toCents } from '../src/money.ts';

describe('toCents', () => {
  it('converte decimal em centavos sem erro de ponto flutuante', () => {
    expect(toCents('199.90')).toBe(19990);
    expect(toCents('0.07')).toBe(7);
    // 0.29 * 100 e 4.35 * 100 dão 28.999... e 434.999... em ponto flutuante.
    expect(toCents('0.29')).toBe(29);
    expect(toCents('4.35')).toBe(435);
    expect(toCents('1.1')).toBe(110);
    expect(toCents('50')).toBe(5000);
    expect(toCents('0')).toBe(0);
  });

  it('rejeita valor que não é decimal de até duas casas', () => {
    for (const invalid of ['', '-1.00', '1,50', '1.999', 'abc', '1e3', ' 10']) {
      expect(() => toCents(invalid)).toThrow();
    }
  });
});
