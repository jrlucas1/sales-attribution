import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { insertCreators, openDatabase } from '../src/db.ts';
import type { Db } from '../src/db.ts';

export interface TestContext {
  app: FastifyInstance;
  db: Db;
}

export function createContext(): TestContext {
  const db = openDatabase();
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

export async function post(app: FastifyInstance, url: string, payload: unknown) {
  const response = await app.inject({ method: 'POST', url, payload: payload as object });
  return { status: response.statusCode, body: response.json() };
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
