import { beforeEach, describe, expect, it } from 'vitest';
import { createContext, get, netOf, orderPayload, post, refundPayload } from './helpers.ts';
import type { TestContext } from './helpers.ts';

let ctx: TestContext;

beforeEach(() => {
  ctx = createContext();
});

describe('estorno de pedido já pago', () => {
  it('estorno total zera a atribuição sem apagar a venda do histórico', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload());
    const { status, body, view } = await post(
      ctx.app,
      '/webhooks/refunds',
      refundPayload({ amount: '100.00' }),
    );

    expect(status).toBe(200);
    expect(body.outcome).toBe('applied');
    expect(view.net_cents).toBe(0);
    expect(view.ledger).toMatchObject([
      { kind: 'sale', amount_cents: 10000, refund_id: null },
      { kind: 'refund', amount_cents: -10000, refund_id: 'r1' },
    ]);
    expect(view.order.creator_id).toBe('ana');
    expect(await netOf(ctx.app, 'ana')).toBe(0);
  });

  it('estorno parcial reverte só o valor estornado', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload());
    const { view } = await post(ctx.app, '/webhooks/refunds', refundPayload({ amount: '30.00' }));

    expect(view).toMatchObject({ sale_cents: 10000, refunded_cents: 3000, net_cents: 7000 });
    expect(view.refunds).toMatchObject([
      { id: 'r1', status: 'applied', requested_cents: 3000, applied_cents: 3000 },
    ]);
    expect(await netOf(ctx.app, 'ana')).toBe(7000);
  });

  it('vários estornos parciais se acumulam', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload());
    await post(ctx.app, '/webhooks/refunds', refundPayload({ id: 'r1', amount: '30.00' }));
    await post(ctx.app, '/webhooks/refunds', refundPayload({ id: 'r2', amount: '20.00' }));

    expect(await netOf(ctx.app, 'ana')).toBe(5000);
  });

  it('estorno repetido não é aplicado de novo', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload());
    await post(ctx.app, '/webhooks/refunds', refundPayload());
    const second = await post(ctx.app, '/webhooks/refunds', refundPayload());
    const third = await post(ctx.app, '/webhooks/refunds', refundPayload({ amount: '99.00' }));

    expect(second.body.outcome).toBe('duplicate');
    expect(third.body.outcome).toBe('duplicate');
    expect(third.view.refunds).toHaveLength(1);
    expect(third.view.refunded_cents).toBe(3000);
    expect(await netOf(ctx.app, 'ana')).toBe(7000);
  });

  it('o mesmo estorno enviado em paralelo é aplicado uma vez só', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload());
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => post(ctx.app, '/webhooks/refunds', refundPayload())),
    );

    const outcomes = responses.map((response) => response.body.outcome);
    expect(outcomes.filter((outcome) => outcome === 'applied')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'duplicate')).toHaveLength(9);
    expect(await netOf(ctx.app, 'ana')).toBe(7000);
  });

  it('a soma dos estornos nunca passa do valor da venda, e o excesso fica registrado', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload());
    await post(ctx.app, '/webhooks/refunds', refundPayload({ id: 'r1', amount: '70.00' }));
    const over = await post(
      ctx.app,
      '/webhooks/refunds',
      refundPayload({ id: 'r2', amount: '50.00' }),
    );
    const afterZero = await post(
      ctx.app,
      '/webhooks/refunds',
      refundPayload({ id: 'r3', amount: '10.00' }),
    );

    expect(over.body.outcome).toBe('applied');
    expect(afterZero.view).toMatchObject({ refunded_cents: 10000, net_cents: 0 });
    expect(afterZero.view.refunds).toMatchObject([
      { id: 'r1', requested_cents: 7000, applied_cents: 7000 },
      { id: 'r2', requested_cents: 5000, applied_cents: 3000 },
      { id: 'r3', requested_cents: 1000, applied_cents: 0, status: 'applied' },
    ]);
    // Estorno que não aplicou nada não gera lançamento.
    expect(afterZero.view.ledger).toHaveLength(3);
    expect(await netOf(ctx.app, 'ana')).toBe(0);
  });

  it('estorno exatamente igual ao saldo restante é aplicado inteiro', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload());
    await post(ctx.app, '/webhooks/refunds', refundPayload({ id: 'r1', amount: '99.99' }));
    const last = await post(
      ctx.app,
      '/webhooks/refunds',
      refundPayload({ id: 'r2', amount: '0.01' }),
    );

    expect(last.view.refunds[1]).toMatchObject({ requested_cents: 1, applied_cents: 1 });
    expect(last.view.net_cents).toBe(0);
  });

  it('estorno de pedido sem criador reverte o pedido e não afeta nenhum criador', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload({ discount_codes: [] }));
    const { view } = await post(ctx.app, '/webhooks/refunds', refundPayload());

    expect(view.net_cents).toBe(7000);
    expect(await netOf(ctx.app, 'ana')).toBe(0);
    expect(await netOf(ctx.app, 'bruno')).toBe(0);
  });

  it('estorno em moeda diferente da do pedido é registrado e descartado', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload());
    const { body, view } = await post(ctx.app, '/webhooks/refunds', refundPayload({ currency: 'USD' }));

    expect(body.outcome).toBe('discarded');
    expect(view.refunds).toMatchObject([
      { status: 'discarded', applied_cents: 0, discard_reason: 'currency_mismatch' },
    ]);
    expect(await netOf(ctx.app, 'ana')).toBe(10000);
  });

  it('rejeita estorno inválido com 422 e não grava nada', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload());
    const invalid = [
      refundPayload({ id: undefined }),
      refundPayload({ id: '   ' }),
      refundPayload({ order_id: undefined }),
      refundPayload({ amount: '0.00' }),
      refundPayload({ amount: '-5.00' }),
      refundPayload({ amount: 30 }),
      refundPayload({ currency: undefined }),
    ];

    for (const payload of invalid) {
      const { status, body } = await post(ctx.app, '/webhooks/refunds', payload);
      expect(status).toBe(422);
      expect(body.error).toBe('invalid_payload');
    }
    const { body } = await get(ctx.app, '/orders/1001');
    expect(body.refunds).toHaveLength(0);
    expect(body.net_cents).toBe(10000);
  });
});

describe('estorno que chega antes do pedido', () => {
  it('fica pendente e é aplicado quando o pedido chega', async () => {
    const early = await post(ctx.app, '/webhooks/refunds', refundPayload());

    expect(early.status).toBe(200);
    expect(early.body.outcome).toBe('pending');
    expect(early.view.order).toBeNull();
    expect(early.view.refunds).toMatchObject([
      { id: 'r1', status: 'pending', applied_cents: null },
    ]);

    const order = await post(ctx.app, '/webhooks/orders', orderPayload());

    expect(order.body.outcome).toBe('created');
    expect(order.view).toMatchObject({ sale_cents: 10000, refunded_cents: 3000, net_cents: 7000 });
    expect(order.view.refunds).toMatchObject([
      { id: 'r1', status: 'applied', applied_cents: 3000 },
    ]);
    expect(await netOf(ctx.app, 'ana')).toBe(7000);
  });

  it('fica visível em GET /orders/:id mesmo sem o pedido', async () => {
    await post(ctx.app, '/webhooks/refunds', refundPayload());
    const { status, body } = await get(ctx.app, '/orders/1001');

    expect(status).toBe(200);
    expect(body.order).toBeNull();
    expect(body.refunds).toHaveLength(1);
  });

  it('repetido antes do pedido continua sendo um estorno só', async () => {
    await post(ctx.app, '/webhooks/refunds', refundPayload());
    const again = await post(ctx.app, '/webhooks/refunds', refundPayload());
    await post(ctx.app, '/webhooks/orders', orderPayload());
    const afterOrder = await post(ctx.app, '/webhooks/refunds', refundPayload());

    expect(again.body.outcome).toBe('duplicate');
    expect(afterOrder.body.outcome).toBe('duplicate');
    expect(await netOf(ctx.app, 'ana')).toBe(7000);
  });

  it('vários pendentes são aplicados em ordem de chegada, limitados ao total', async () => {
    await post(ctx.app, '/webhooks/refunds', refundPayload({ id: 'r1', amount: '80.00' }));
    await post(ctx.app, '/webhooks/refunds', refundPayload({ id: 'r2', amount: '50.00' }));
    await post(ctx.app, '/webhooks/refunds', refundPayload({ id: 'r3', amount: '10.00' }));
    const { view } = await post(ctx.app, '/webhooks/orders', orderPayload());

    expect(view.refunds).toMatchObject([
      { id: 'r1', applied_cents: 8000 },
      { id: 'r2', applied_cents: 2000 },
      { id: 'r3', applied_cents: 0 },
    ]);
    expect(view.net_cents).toBe(0);
    expect(await netOf(ctx.app, 'ana')).toBe(0);
  });

  it('não é aplicado duas vezes quando o pedido chega repetido', async () => {
    await post(ctx.app, '/webhooks/refunds', refundPayload());
    await post(ctx.app, '/webhooks/orders', orderPayload());
    await post(ctx.app, '/webhooks/orders', orderPayload());

    expect(await netOf(ctx.app, 'ana')).toBe(7000);
  });

  it('continua pendente enquanto o pedido está pending e é aplicado no paid', async () => {
    await post(ctx.app, '/webhooks/refunds', refundPayload({ id: 'r1' }));
    await post(ctx.app, '/webhooks/orders', orderPayload({ status: 'pending' }));
    const duringPending = await post(
      ctx.app,
      '/webhooks/refunds',
      refundPayload({ id: 'r2', amount: '20.00' }),
    );

    expect(duringPending.body.outcome).toBe('pending');
    expect(duringPending.view.refunds).toMatchObject([
      { id: 'r1', status: 'pending' },
      { id: 'r2', status: 'pending' },
    ]);
    expect(await netOf(ctx.app, 'ana')).toBe(0);

    const paid = await post(ctx.app, '/webhooks/orders', orderPayload({ status: 'paid' }));

    expect(paid.view.net_cents).toBe(5000);
    expect(await netOf(ctx.app, 'ana')).toBe(5000);
  });

  it('é descartado, mas continua registrado, quando o pedido é cancelado', async () => {
    await post(ctx.app, '/webhooks/refunds', refundPayload());
    await post(ctx.app, '/webhooks/orders', orderPayload({ status: 'pending' }));
    const cancelled = await post(
      ctx.app,
      '/webhooks/orders',
      orderPayload({ status: 'cancelled' }),
    );
    const late = await post(ctx.app, '/webhooks/refunds', refundPayload({ id: 'r2' }));

    expect(cancelled.view.refunds).toMatchObject([
      { id: 'r1', status: 'discarded', applied_cents: 0, discard_reason: 'order_cancelled' },
    ]);
    expect(late.body.outcome).toBe('discarded');
    expect(late.view.ledger).toHaveLength(0);
    expect(await netOf(ctx.app, 'ana')).toBe(0);
  });

  it('em moeda diferente da do pedido é descartado quando o pedido chega', async () => {
    await post(ctx.app, '/webhooks/refunds', refundPayload({ currency: 'USD' }));
    const { view } = await post(ctx.app, '/webhooks/orders', orderPayload());

    expect(view.refunds).toMatchObject([
      { status: 'discarded', discard_reason: 'currency_mismatch' },
    ]);
    expect(view.net_cents).toBe(10000);
  });

  it('não afeta outro pedido', async () => {
    await post(ctx.app, '/webhooks/refunds', refundPayload({ order_id: 2002 }));
    const { view } = await post(ctx.app, '/webhooks/orders', orderPayload({ id: 1001 }));

    expect(view.refunds).toHaveLength(0);
    expect(view.net_cents).toBe(10000);
  });
});
