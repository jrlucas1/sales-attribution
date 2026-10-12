import { beforeEach, describe, expect, it } from 'vitest';
import { createContext, get, netOf } from './helpers.ts';
import type { TestContext } from './helpers.ts';

// 2^53 + 1 não cabe em number: JSON.parse devolve 9007199254740992.
const BIG = '9007199254740993';
const NEIGHBOR = '9007199254740992';

let ctx: TestContext;

beforeEach(() => {
  ctx = createContext();
});

// O corpo vai como texto para o id numérico chegar com todos os dígitos.
async function postRaw(url: string, body: string) {
  const response = await ctx.app.inject({
    method: 'POST',
    url,
    payload: body,
    headers: { 'content-type': 'application/json' },
  });
  return { status: response.statusCode, body: response.json() };
}

function orderJson(id: string): string {
  return `{"id":${id},"total_price":"100.00","currency":"BRL","status":"paid","discount_codes":[{"code":"ANA10"}]}`;
}

function refundJson(id: string, orderId: string): string {
  return `{"id":${id},"order_id":${orderId},"amount":"30.00","currency":"BRL"}`;
}

describe('ids acima de 2^53', () => {
  it('guarda o id numérico do pedido com todos os dígitos', async () => {
    const { status, body } = await postRaw('/webhooks/orders', orderJson(BIG));

    expect(status).toBe(200);
    expect(body.outcome).toBe('created');
    expect((await get(ctx.app, `/orders/${BIG}`)).body.order.id).toBe(BIG);
  });

  it('dois pedidos com ids vizinhos acima de 2^53 são dois pedidos', async () => {
    await postRaw('/webhooks/orders', orderJson(BIG));
    const neighbor = await postRaw('/webhooks/orders', orderJson(NEIGHBOR));

    expect(neighbor.body.outcome).toBe('created');
    expect(await netOf(ctx.app, 'ana')).toBe(20000);
  });

  it('id grande em número e em texto é o mesmo pedido', async () => {
    await postRaw('/webhooks/orders', orderJson(BIG));
    const again = await postRaw('/webhooks/orders', orderJson(`"${BIG}"`));

    expect(again.body.outcome).toBe('duplicate');
    expect(await netOf(ctx.app, 'ana')).toBe(10000);
  });

  it('o estorno acha o pedido certo pelo order_id grande', async () => {
    await postRaw('/webhooks/orders', orderJson(BIG));
    await postRaw('/webhooks/orders', orderJson(NEIGHBOR));

    const refund = await postRaw('/webhooks/refunds', refundJson('1', BIG));

    expect(refund.body.outcome).toBe('applied');
    expect((await get(ctx.app, `/orders/${BIG}`)).body.net_cents).toBe(7000);
    expect((await get(ctx.app, `/orders/${NEIGHBOR}`)).body.net_cents).toBe(10000);
  });

  it('dois estornos com ids vizinhos acima de 2^53 são dois estornos', async () => {
    await postRaw('/webhooks/orders', orderJson(BIG));
    await postRaw('/webhooks/refunds', refundJson(BIG, BIG));
    const second = await postRaw('/webhooks/refunds', refundJson(NEIGHBOR, BIG));

    expect(second.body.outcome).toBe('applied');
    expect((await get(ctx.app, `/orders/${BIG}`)).body.refunded_cents).toBe(6000);
  });

  it('id de 30 dígitos passa inteiro', async () => {
    const huge = '123456789012345678901234567890';
    await postRaw('/webhooks/orders', orderJson(huge));

    expect((await get(ctx.app, `/orders/${huge}`)).body.order.id).toBe(huge);
  });

  it('continua recusando id negativo, fracionário ou em notação científica', async () => {
    for (const id of ['-9007199254740993', '9007199254740993.5', '1e30', '0']) {
      const { status } = await postRaw('/webhooks/orders', orderJson(id));
      expect(status).toBe(422);
    }
  });

  it('JSON malformado ou vazio responde 400', async () => {
    expect((await postRaw('/webhooks/orders', '{"id":')).status).toBe(400);
    expect((await postRaw('/webhooks/orders', '')).status).toBe(400);
  });
});
