import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { insertCreators, insertShops, openDatabase } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { signBody } from '../src/signature.ts';

export interface TestContext {
  app: FastifyInstance;
  db: Db;
}

export const TEST_SHOP = { domain: 'loja-de-teste.example', webhookSecret: 'segredo-de-teste' };

// Headers de um webhook assinado pela loja de teste.
export function signedHeaders(body: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-shop-domain': TEST_SHOP.domain,
    'x-hmac-sha256': signBody(TEST_SHOP.webhookSecret, body),
  };
}

export function createContext(): TestContext {
  const db = openDatabase();
  insertShops(db, [TEST_SHOP]);
  insertCreators(db, [
    { id: 'ana', couponCode: 'ANA10', utmContent: 'ana' },
    { id: 'bruno', couponCode: 'BRUNO10', utmContent: 'bruno' },
  ]);
  return { app: buildApp(db), db };
}

export function orderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1001,
    total_price: '100.00',
    currency: 'BRL',
    status: 'paid',
    discount_codes: [{ code: 'ANA10' }],
    landing_site: '/',
    ...overrides,
  };
}

export function refundPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'r1',
    order_id: 1001,
    amount: '30.00',
    currency: 'BRL',
    ...overrides,
  };
}

// Envia um webhook assinado. `view` é o pedido lido por GET /orders/:id logo depois,
// ou null quando o payload não tem id de pedido ou nada foi gravado.
export async function post(app: FastifyInstance, url: string, payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  const response = await app.inject({ method: 'POST', url, payload: body, headers: signedHeaders(body) });
  const orderId = payload.order_id ?? payload.id;
  const order = orderId === undefined ? null : await get(app, `/orders/${orderId}`);
  return {
    status: response.statusCode,
    body: response.json(),
    view: order?.status === 200 ? order.body : null,
  };
}

export async function get(app: FastifyInstance, url: string) {
  const response = await app.inject({ method: 'GET', url });
  return { status: response.statusCode, body: response.json() };
}

// Total líquido do criador em BRL, lido pela API.
export async function netOf(app: FastifyInstance, creatorId: string): Promise<number> {
  const { body } = await get(app, `/creators/${creatorId}/sales`);
  const brl = body.totals.find((total: { currency: string }) => total.currency === 'BRL');
  return brl ? brl.net_cents : 0;
}
