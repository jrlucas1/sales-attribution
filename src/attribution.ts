// Única regra de atribuição do sistema. Uma venda vai para no máximo um criador.
//
// 1. Cupom: o primeiro cupom do pedido que pertence a algum criador.
// 2. UTM: utm_source=conty e utm_content igual ao identificador do criador.
// 3. Ninguém.
//
// Quando cupom e UTM apontam para criadores diferentes, o cupom vence: ele é
// digitado no checkout, enquanto a UTM é o último clique e pode ter sido herdada.

export const UTM_SOURCE = 'conty';

export type AttributionReason = 'coupon' | 'utm' | 'none';

export interface Creator {
  id: string;
  couponCode: string;
  utmContent: string;
}

export interface AttributionInput {
  couponCodes: string[];
  utmSource: string | null;
  utmContent: string | null;
}

export interface Attribution {
  creatorId: string | null;
  reason: AttributionReason;
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function attribute(input: AttributionInput, creators: Creator[]): Attribution {
  for (const code of input.couponCodes) {
    const byCoupon = creators.find((creator) => sameText(creator.couponCode, code));
    if (byCoupon) {
      return { creatorId: byCoupon.id, reason: 'coupon' };
    }
  }

  const { utmSource, utmContent } = input;
  if (utmSource !== null && utmContent !== null && sameText(utmSource, UTM_SOURCE)) {
    const byUtm = creators.find((creator) => sameText(creator.utmContent, utmContent));
    if (byUtm) {
      return { creatorId: byUtm.id, reason: 'utm' };
    }
  }

  return { creatorId: null, reason: 'none' };
}
