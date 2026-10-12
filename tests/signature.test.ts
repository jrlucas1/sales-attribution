import { beforeEach, describe, expect, it } from 'vitest';
import { insertShops } from '../src/db.ts';
import { signBody } from '../src/signature.ts';
import { createContext, get, netOf, orderPayload, refundPayload, TEST_SHOP } from './helpers.ts';
import type { TestContext } from './helpers.ts';

const OTHER_SHOP = { domain: 'outra-loja.example', webhookSecret: 'segredo-da-outra-loja' };

let ctx: TestContext;

beforeEach(() => {
  ctx = createContext();
  insertShops(ctx.db, [OTHER_SHOP]);
});

// Envia o corpo exatamente como está, com os headers dados.
async function send(url: string, body: string, headers: Record<string, string>) {
  const response = await ctx.app.inject({
    method: 'POST',
    url,
    payload: body,
    headers: { 'content-type': 'application/json', ...headers },
  });
  return { status: response.statusCode, body: response.json() };
}

function signedBy(shop: { domain: string; webhookSecret: string }, body: string) {
  return { 'x-shop-domain': shop.domain, 'x-hmac-sha256': signBody(shop.webhookSecret, body) };
}

const ORDER = JSON.stringify(orderPayload());
const REFUND = JSON.stringify(refundPayload());

async function expectNothingSaved() {
  expect((await get(ctx.app, '/orders/1001')).status).toBe(404);
  expect(await netOf(ctx.app, 'ana')).toBe(0);
}

describe('assinatura do webhook', () => {
  it('aceita o pedido assinado com o segredo da loja', async () => {
    const { status, body } = await send('/webhooks/orders', ORDER, signedBy(TEST_SHOP, ORDER));

    expect(status).toBe(200);
    expect(body).toEqual({ outcome: 'created' });
  });

  it('cada loja assina com o próprio segredo', async () => {
    const { status } = await send('/webhooks/orders', ORDER, signedBy(OTHER_SHOP, ORDER));

    expect(status).toBe(200);
  });

  it('recusa assinatura feita com o segredo de outra loja', async () => {
    const { status, body } = await send('/webhooks/orders', ORDER, {
      'x-shop-domain': TEST_SHOP.domain,
      'x-hmac-sha256': signBody(OTHER_SHOP.webhookSecret, ORDER),
    });

    expect(status).toBe(401);
    expect(body).toEqual({ error: 'invalid_signature' });
    await expectNothingSaved();
  });

  it.each([
    ['sem assinatura', { 'x-shop-domain': TEST_SHOP.domain }],
    ['sem loja', { 'x-hmac-sha256': signBody(TEST_SHOP.webhookSecret, ORDER) }],
    ['sem nenhum dos dois', {}],
    ['com assinatura vazia', { 'x-shop-domain': TEST_SHOP.domain, 'x-hmac-sha256': '' }],
    ['com assinatura que não é base64', { 'x-shop-domain': TEST_SHOP.domain, 'x-hmac-sha256': '!!!' }],
    [
      'com a assinatura certa cortada',
      { 'x-shop-domain': TEST_SHOP.domain, 'x-hmac-sha256': signBody(TEST_SHOP.webhookSecret, ORDER).slice(0, -4) },
    ],
    [
      'de loja desconhecida',
      { 'x-shop-domain': 'nao-cadastrada.example', 'x-hmac-sha256': signBody(TEST_SHOP.webhookSecret, ORDER) },
    ],
  ])('recusa pedido %s com 401 e não grava nada', async (_name, headers) => {
    const { status, body } = await send('/webhooks/orders', ORDER, headers);

    expect(status).toBe(401);
    expect(body).toEqual({ error: 'invalid_signature' });
    await expectNothingSaved();
  });

  it('recusa corpo alterado depois de assinado', async () => {
    const tampered = ORDER.replace('"100.00"', '"900.00"');

    const { status } = await send('/webhooks/orders', tampered, signedBy(TEST_SHOP, ORDER));

    expect(status).toBe(401);
    await expectNothingSaved();
  });

  it('a assinatura é do corpo como chegou, não do JSON reescrito', async () => {
    // Mesmo conteúdo com espaços, quebra de linha e acento: outros bytes, outra assinatura.
    const spaced = `{ "id": 1001,\n "total_price": "100.00", "currency": "BRL", "status": "paid",\n "discount_codes": [{ "code": "ANA10" }], "landing_site": "/promoção" }`;

    const wrong = await send('/webhooks/orders', spaced, signedBy(TEST_SHOP, JSON.stringify(JSON.parse(spaced))));
    const right = await send('/webhooks/orders', spaced, signedBy(TEST_SHOP, spaced));

    expect(wrong.status).toBe(401);
    expect(right.status).toBe(200);
  });

  it('sem assinatura válida responde 401 antes de olhar o payload', async () => {
    const invalid = JSON.stringify(orderPayload({ status: 'refunded' }));

    const unsigned = await send('/webhooks/orders', invalid, {});
    const signed = await send('/webhooks/orders', invalid, signedBy(TEST_SHOP, invalid));

    expect(unsigned.status).toBe(401);
    expect(signed.status).toBe(422);
  });

  it('recusa estorno sem assinatura válida e não grava nada', async () => {
    await send('/webhooks/orders', ORDER, signedBy(TEST_SHOP, ORDER));

    const unsigned = await send('/webhooks/refunds', REFUND, { 'x-shop-domain': TEST_SHOP.domain });
    const wrongSecret = await send('/webhooks/refunds', REFUND, {
      'x-shop-domain': TEST_SHOP.domain,
      'x-hmac-sha256': signBody('segredo-errado', REFUND),
    });

    expect(unsigned.status).toBe(401);
    expect(wrongSecret.status).toBe(401);
    const { body } = await get(ctx.app, '/orders/1001');
    expect(body.refunds).toEqual([]);
    expect(body.net_cents).toBe(10000);
  });

  it('aceita o estorno assinado', async () => {
    await send('/webhooks/orders', ORDER, signedBy(TEST_SHOP, ORDER));

    const { status, body } = await send('/webhooks/refunds', REFUND, signedBy(TEST_SHOP, REFUND));

    expect(status).toBe(200);
    expect(body).toEqual({ outcome: 'applied' });
  });

  it('o mesmo webhook assinado reenviado continua sendo ignorado', async () => {
    await send('/webhooks/orders', ORDER, signedBy(TEST_SHOP, ORDER));
    const again = await send('/webhooks/orders', ORDER, signedBy(TEST_SHOP, ORDER));

    expect(again.body).toEqual({ outcome: 'duplicate' });
    expect(await netOf(ctx.app, 'ana')).toBe(10000);
  });

  it('o domínio da loja não diferencia maiúsculas', async () => {
    const { status } = await send('/webhooks/orders', ORDER, {
      'x-shop-domain': TEST_SHOP.domain.toUpperCase(),
      'x-hmac-sha256': signBody(TEST_SHOP.webhookSecret, ORDER),
    });

    expect(status).toBe(200);
  });
});
