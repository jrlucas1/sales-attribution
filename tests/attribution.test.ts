import { describe, expect, it } from 'vitest';
import { attribute } from '../src/attribution.ts';
import type { AttributionInput, Creator } from '../src/attribution.ts';

const creators: Creator[] = [
  { id: 'ana', couponCode: 'ANA10', utmContent: 'ana' },
  { id: 'bruno', couponCode: 'BRUNO10', utmContent: 'bruno' },
];

function input(overrides: Partial<AttributionInput> = {}): AttributionInput {
  return { couponCodes: [], utmSource: null, utmContent: null, ...overrides };
}

describe('regra de atribuição', () => {
  it('atribui pelo cupom', () => {
    expect(attribute(input({ couponCodes: ['ANA10'] }), creators)).toEqual({
      creatorId: 'ana',
      reason: 'coupon',
    });
  });

  it('atribui pela UTM quando não há cupom', () => {
    expect(attribute(input({ utmSource: 'conty', utmContent: 'bruno' }), creators)).toEqual({
      creatorId: 'bruno',
      reason: 'utm',
    });
  });

  it('cupom vence quando cupom e UTM apontam para criadores diferentes', () => {
    const result = attribute(
      input({ couponCodes: ['ANA10'], utmSource: 'conty', utmContent: 'bruno' }),
      creators,
    );
    expect(result).toEqual({ creatorId: 'ana', reason: 'coupon' });
  });

  it('cai para a UTM quando o cupom não é de nenhum criador', () => {
    const result = attribute(
      input({ couponCodes: ['FRETEGRATIS'], utmSource: 'conty', utmContent: 'bruno' }),
      creators,
    );
    expect(result).toEqual({ creatorId: 'bruno', reason: 'utm' });
  });

  it('não atribui a ninguém sem cupom nem UTM', () => {
    expect(attribute(input(), creators)).toEqual({ creatorId: null, reason: 'none' });
  });

  it('não atribui quando cupom e UTM são desconhecidos', () => {
    const result = attribute(
      input({ couponCodes: ['X'], utmSource: 'conty', utmContent: 'carla' }),
      creators,
    );
    expect(result).toEqual({ creatorId: null, reason: 'none' });
  });

  it('ignora UTM de outra origem', () => {
    const result = attribute(input({ utmSource: 'google', utmContent: 'ana' }), creators);
    expect(result).toEqual({ creatorId: null, reason: 'none' });
  });

  it('ignora utm_content sem utm_source', () => {
    const result = attribute(input({ utmContent: 'ana' }), creators);
    expect(result).toEqual({ creatorId: null, reason: 'none' });
  });

  it('compara cupom e UTM sem diferenciar maiúsculas nem espaços nas pontas', () => {
    expect(attribute(input({ couponCodes: [' ana10 '] }), creators).creatorId).toBe('ana');
    expect(attribute(input({ utmSource: 'Conty', utmContent: 'BRUNO' }), creators).creatorId).toBe(
      'bruno',
    );
  });

  it('com vários cupons de criadores, vale o primeiro da lista', () => {
    const result = attribute(input({ couponCodes: ['FRETEGRATIS', 'BRUNO10', 'ANA10'] }), creators);
    expect(result).toEqual({ creatorId: 'bruno', reason: 'coupon' });
  });
});
