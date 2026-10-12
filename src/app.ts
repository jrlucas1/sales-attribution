import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.ts';
import { MONEY_PATTERN, toCents } from './money.ts';
import {
  createCreator,
  getCreatorSales,
  getOrderView,
  ingestOrder,
  ingestRefund,
} from './service.ts';

// JSON.parse arredonda inteiro acima de 2^53. Aqui o inteiro positivo que não cabe
// em number volta como o texto que veio no corpo, com todos os dígitos.
function parseJsonKeepingBigIntegers(text: string): unknown {
  return JSON.parse(text, keepBigInteger as (key: string, value: unknown) => unknown);
}

// O Node 22 passa ao reviver o texto original do valor; a lib do TypeScript ainda não tipa isso.
function keepBigInteger(_key: string, value: unknown, context: { source?: string }): unknown {
  const source = context.source;
  if (typeof value === 'number' && !Number.isSafeInteger(value) && source && /^\d+$/.test(source)) {
    return source;
  }
  return value;
}

// O Shopify manda ids numéricos; aqui eles viram texto para não perder precisão.
const externalId = z
  .union([z.string().trim().min(1), z.number().int().positive()])
  .transform((value) => String(value));

const money = z.string().regex(MONEY_PATTERN).transform(toCents);

const currency = z
  .string()
  .length(3)
  .transform((value) => value.toUpperCase());

const orderPayload = z.object({
  id: externalId,
  total_price: money,
  currency,
  status: z.enum(['pending', 'paid', 'cancelled']),
  discount_codes: z.array(z.object({ code: z.string() })).default([]),
  landing_site: z.string().nullish(),
});

const refundPayload = z.object({
  id: externalId,
  order_id: externalId,
  amount: money.refine((cents) => cents > 0, 'o estorno precisa ser maior que zero'),
  currency,
});

const creatorField = z.string().trim().min(1);

const creatorPayload = z.object({
  id: creatorField,
  coupon_code: creatorField,
  utm_content: creatorField,
});

// As UTMs vêm na query string de landing_site, como no pedido do Shopify.
function readUtm(landingSite: string | null | undefined): {
  utmSource: string | null;
  utmContent: string | null;
} {
  if (!landingSite) {
    return { utmSource: null, utmContent: null };
  }
  try {
    const params = new URL(landingSite, 'https://loja.invalid').searchParams;
    return { utmSource: params.get('utm_source'), utmContent: params.get('utm_content') };
  } catch {
    return { utmSource: null, utmContent: null };
  }
}

export function buildApp(db: Db): FastifyInstance {
  const app = Fastify();

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    try {
      done(null, parseJsonKeepingBigIntegers(body as string));
    } catch {
      done(Object.assign(new Error('JSON inválido'), { statusCode: 400 }));
    }
  });

  app.post('/webhooks/orders', (request, reply) => {
    const parsed = orderPayload.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: 'invalid_payload', issues: parsed.error.issues });
    }
    const payload = parsed.data;
    const outcome = ingestOrder(db, {
      id: payload.id,
      totalCents: payload.total_price,
      currency: payload.currency,
      status: payload.status,
      couponCodes: payload.discount_codes.map((discount) => discount.code),
      ...readUtm(payload.landing_site),
    });
    return reply.send({ outcome });
  });

  app.post('/webhooks/refunds', (request, reply) => {
    const parsed = refundPayload.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: 'invalid_payload', issues: parsed.error.issues });
    }
    const payload = parsed.data;
    const outcome = ingestRefund(db, {
      id: payload.id,
      orderId: payload.order_id,
      amountCents: payload.amount,
      currency: payload.currency,
    });
    return reply.send({ outcome });
  });

  app.get<{ Params: { id: string } }>('/orders/:id', (request, reply) => {
    const view = getOrderView(db, request.params.id);
    if (!view) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.send(view);
  });

  // Vale para os pedidos que chegarem depois: pedido já recebido não muda de criador.
  app.post('/creators', (request, reply) => {
    const parsed = creatorPayload.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: 'invalid_payload', issues: parsed.error.issues });
    }
    const payload = parsed.data;
    const outcome = createCreator(db, {
      id: payload.id,
      couponCode: payload.coupon_code,
      utmContent: payload.utm_content,
    });
    if (outcome === 'conflict') {
      return reply.code(409).send({ error: 'creator_conflict' });
    }
    return reply.code(201).send(payload);
  });

  app.get<{ Params: { id: string } }>('/creators/:id/sales', (request, reply) => {
    const sales = getCreatorSales(db, request.params.id);
    if (!sales) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.send(sales);
  });

  return app;
}
