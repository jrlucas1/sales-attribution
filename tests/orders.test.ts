import { beforeEach, describe, expect, it } from 'vitest';
import { createContext, get, netOf, orderPayload, post } from './helpers.ts';
import type { TestContext } from './helpers.ts';

let ctx: TestContext;

beforeEach(() => {
  ctx = createContext();
});

describe('webhook de pedido', () => {
  it('grava a venda e atribui ao criador do cupom', async () => {
    const { status, body } = await post(ctx.app, '/webhooks/orders', orderPayload());

    expect(status).toBe(200);
    expect(body.outcome).toBe('created');
    expect(body.order).toMatchObject({
      id: '1001',
      total_cents: 10000,
      status: 'paid',
      creator_id: 'ana',
      attribution_reason: 'coupon',
    });
    expect(await netOf(ctx.app, 'ana')).toBe(10000);
  });

  it('lê as UTMs da query string de landing_site', async () => {
    const { body } = await post(
      ctx.app,
      '/webhooks/orders',
      orderPayload({
        discount_codes: [],
        landing_site: '/produtos/tenis?utm_source=conty&utm_medium=social&utm_content=bruno',
      }),
    );

    expect(body.order).toMatchObject({ creator_id: 'bruno', attribution_reason: 'utm' });
  });

  it('cupom vence a UTM de outro criador', async () => {
    const { body } = await post(
      ctx.app,
      '/webhooks/orders',
      orderPayload({ landing_site: '/?utm_source=conty&utm_content=bruno' }),
    );

    expect(body.order.creator_id).toBe('ana');
    expect(await netOf(ctx.app, 'ana')).toBe(10000);
    expect(await netOf(ctx.app, 'bruno')).toBe(0);
  });

  it('grava pedido sem criador com atribuição nula', async () => {
    const { body } = await post(
      ctx.app,
      '/webhooks/orders',
      orderPayload({ discount_codes: [], landing_site: null }),
    );

    expect(body.order).toMatchObject({ creator_id: null, attribution_reason: 'none' });
    expect(body.net_cents).toBe(10000);
  });

  it('pedido repetido não soma a venda de novo', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload());
    const second = await post(ctx.app, '/webhooks/orders', orderPayload());

    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe('duplicate');
    expect(second.body.ledger).toHaveLength(1);
    expect(await netOf(ctx.app, 'ana')).toBe(10000);
  });

  it('trata id numérico e id em texto como o mesmo pedido', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload({ id: 1001 }));
    const second = await post(ctx.app, '/webhooks/orders', orderPayload({ id: '1001' }));

    expect(second.body.outcome).toBe('duplicate');
    expect(await netOf(ctx.app, 'ana')).toBe(10000);
  });

  it('reenvio com payload diferente não troca criador nem valor', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload());
    const second = await post(
      ctx.app,
      '/webhooks/orders',
      orderPayload({ total_price: '999.00', discount_codes: [{ code: 'BRUNO10' }] }),
    );

    expect(second.body.outcome).toBe('duplicate');
    expect(second.body.order).toMatchObject({ creator_id: 'ana', total_cents: 10000 });
    expect(await netOf(ctx.app, 'ana')).toBe(10000);
    expect(await netOf(ctx.app, 'bruno')).toBe(0);
  });

  it('o mesmo pedido enviado em paralelo soma uma vez só', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => post(ctx.app, '/webhooks/orders', orderPayload())),
    );

    const outcomes = responses.map((response) => response.body.outcome);
    expect(outcomes.filter((outcome) => outcome === 'created')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'duplicate')).toHaveLength(9);
    expect(await netOf(ctx.app, 'ana')).toBe(10000);
  });

  it('pedido pending fixa o criador mas ainda não vira venda', async () => {
    const { body } = await post(ctx.app, '/webhooks/orders', orderPayload({ status: 'pending' }));

    expect(body.order).toMatchObject({ status: 'pending', creator_id: 'ana' });
    expect(body.ledger).toHaveLength(0);
    expect(await netOf(ctx.app, 'ana')).toBe(0);
  });

  it('pending que vira paid lança a venda para o criador da primeira chegada', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload({ status: 'pending' }));
    const paid = await post(
      ctx.app,
      '/webhooks/orders',
      orderPayload({ status: 'paid', discount_codes: [{ code: 'BRUNO10' }] }),
    );

    expect(paid.body.outcome).toBe('updated');
    expect(paid.body.order).toMatchObject({ status: 'paid', creator_id: 'ana' });
    expect(await netOf(ctx.app, 'ana')).toBe(10000);
    expect(await netOf(ctx.app, 'bruno')).toBe(0);
  });

  it('paid repetido depois de pending não soma de novo', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload({ status: 'pending' }));
    await post(ctx.app, '/webhooks/orders', orderPayload({ status: 'paid' }));
    const again = await post(ctx.app, '/webhooks/orders', orderPayload({ status: 'paid' }));

    expect(again.body.outcome).toBe('duplicate');
    expect(await netOf(ctx.app, 'ana')).toBe(10000);
  });

  it('pending repetido continua pending', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload({ status: 'pending' }));
    const again = await post(ctx.app, '/webhooks/orders', orderPayload({ status: 'pending' }));

    expect(again.body.outcome).toBe('duplicate');
    expect(again.body.order.status).toBe('pending');
  });

  it('pending que vira cancelled nunca vira venda', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload({ status: 'pending' }));
    const cancelled = await post(
      ctx.app,
      '/webhooks/orders',
      orderPayload({ status: 'cancelled' }),
    );
    const paidLater = await post(ctx.app, '/webhooks/orders', orderPayload({ status: 'paid' }));

    expect(cancelled.body.outcome).toBe('updated');
    expect(paidLater.body.outcome).toBe('duplicate');
    expect(paidLater.body.order.status).toBe('cancelled');
    expect(await netOf(ctx.app, 'ana')).toBe(0);
  });

  it('paid não volta para pending nem para cancelled', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload());
    await post(ctx.app, '/webhooks/orders', orderPayload({ status: 'pending' }));
    const cancelled = await post(
      ctx.app,
      '/webhooks/orders',
      orderPayload({ status: 'cancelled' }),
    );

    expect(cancelled.body.outcome).toBe('duplicate');
    expect(cancelled.body.order.status).toBe('paid');
    expect(await netOf(ctx.app, 'ana')).toBe(10000);
  });

  it('rejeita payload inválido com 422 e não grava nada', async () => {
    const invalid = [
      orderPayload({ id: undefined }),
      orderPayload({ id: '' }),
      orderPayload({ total_price: '-10.00' }),
      orderPayload({ total_price: 100 }),
      orderPayload({ total_price: '10.999' }),
      orderPayload({ status: 'refunded' }),
      orderPayload({ currency: 'REAL' }),
    ];

    for (const payload of invalid) {
      const { status, body } = await post(ctx.app, '/webhooks/orders', payload);
      expect(status).toBe(422);
      expect(body.error).toBe('invalid_payload');
    }
    expect((await get(ctx.app, '/orders/1001')).status).toBe(404);
  });
});

describe('leitura', () => {
  it('GET /creators/:id/sales soma pedidos do criador e ignora os dos outros', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload({ id: 1, total_price: '100.00' }));
    await post(ctx.app, '/webhooks/orders', orderPayload({ id: 2, total_price: '50.50' }));
    await post(
      ctx.app,
      '/webhooks/orders',
      orderPayload({ id: 3, total_price: '70.00', discount_codes: [{ code: 'BRUNO10' }] }),
    );

    const { body } = await get(ctx.app, '/creators/ana/sales');

    expect(body).toEqual({
      creator_id: 'ana',
      totals: [
        { currency: 'BRL', orders: 2, sale_cents: 15050, refunded_cents: 0, net_cents: 15050 },
      ],
    });
  });

  it('responde 404 para criador ou pedido desconhecido', async () => {
    expect((await get(ctx.app, '/creators/carla/sales')).status).toBe(404);
    expect((await get(ctx.app, '/orders/9999')).status).toBe(404);
  });
});
