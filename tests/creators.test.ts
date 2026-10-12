import { beforeEach, describe, expect, it } from 'vitest';
import { createContext, get, netOf, orderPayload, post } from './helpers.ts';
import type { TestContext } from './helpers.ts';

let ctx: TestContext;

beforeEach(() => {
  ctx = createContext();
});

const CARLA = { id: 'carla', coupon_code: 'CARLA15', utm_content: 'carla' };

async function createCreator(payload: Record<string, unknown>) {
  const response = await ctx.app.inject({ method: 'POST', url: '/creators', payload });
  return { status: response.statusCode, body: response.json() };
}

describe('POST /creators', () => {
  it('cadastra o criador com seu cupom e sua UTM', async () => {
    const { status, body } = await createCreator(CARLA);

    expect(status).toBe(201);
    expect(body).toEqual(CARLA);
    expect((await get(ctx.app, '/creators/carla/sales')).body).toEqual({ creator_id: 'carla', totals: [] });
  });

  it('o cupom cadastrado passa a atribuir vendas', async () => {
    await createCreator(CARLA);

    const { view } = await post(
      ctx.app,
      '/webhooks/orders',
      orderPayload({ discount_codes: [{ code: 'carla15' }] }),
    );

    expect(view.order).toMatchObject({ creator_id: 'carla', attribution_reason: 'coupon' });
    expect(await netOf(ctx.app, 'carla')).toBe(10000);
  });

  it('a UTM cadastrada passa a atribuir vendas', async () => {
    await createCreator(CARLA);

    const { view } = await post(
      ctx.app,
      '/webhooks/orders',
      orderPayload({ discount_codes: [], landing_site: '/?utm_source=conty&utm_content=carla' }),
    );

    expect(view.order).toMatchObject({ creator_id: 'carla', attribution_reason: 'utm' });
  });

  it('pedido que chegou antes do cadastro continua sem criador', async () => {
    await post(ctx.app, '/webhooks/orders', orderPayload({ discount_codes: [{ code: 'CARLA15' }] }));
    await createCreator(CARLA);
    const again = await post(
      ctx.app,
      '/webhooks/orders',
      orderPayload({ discount_codes: [{ code: 'CARLA15' }] }),
    );

    expect(again.view.order).toMatchObject({ creator_id: null, attribution_reason: 'none' });
    expect(await netOf(ctx.app, 'carla')).toBe(0);
  });

  it('guarda os campos sem espaços nas pontas', async () => {
    const { body } = await createCreator({ id: ' carla ', coupon_code: ' CARLA15 ', utm_content: ' carla ' });

    expect(body).toEqual(CARLA);
  });

  it.each([
    ['id', { ...CARLA, id: 'ana' }],
    ['cupom', { ...CARLA, coupon_code: 'ANA10' }],
    ['cupom que só muda maiúsculas', { ...CARLA, coupon_code: 'ana10' }],
    ['UTM', { ...CARLA, utm_content: 'ana' }],
    ['UTM que só muda maiúsculas', { ...CARLA, utm_content: 'ANA' }],
  ])('responde 409 e não grava quando o %s já existe', async (_name, payload) => {
    const { status, body } = await createCreator(payload);

    expect(status).toBe(409);
    expect(body).toEqual({ error: 'creator_conflict' });
    // O cupom e a UTM da ana continuam sendo dela, e a carla só existe se o conflito foi no id.
    const { view } = await post(ctx.app, '/webhooks/orders', orderPayload());
    expect(view.order.creator_id).toBe('ana');
    if (payload.id !== 'ana') {
      expect((await get(ctx.app, '/creators/carla/sales')).status).toBe(404);
    }
  });

  it('cadastro repetido responde 409 na segunda vez', async () => {
    await createCreator(CARLA);

    expect((await createCreator(CARLA)).status).toBe(409);
  });

  it('o mesmo cadastro em paralelo cria um criador só', async () => {
    const responses = await Promise.all(Array.from({ length: 10 }, () => createCreator(CARLA)));

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(9);
  });

  it.each([
    ['sem id', { coupon_code: 'CARLA15', utm_content: 'carla' }],
    ['sem cupom', { id: 'carla', utm_content: 'carla' }],
    ['sem UTM', { id: 'carla', coupon_code: 'CARLA15' }],
    ['id vazio', { ...CARLA, id: '' }],
    ['cupom só com espaços', { ...CARLA, coupon_code: '   ' }],
    ['UTM que não é texto', { ...CARLA, utm_content: 42 }],
  ])('rejeita payload inválido com 422: %s', async (_name, payload) => {
    const { status, body } = await createCreator(payload);

    expect(status).toBe(422);
    expect(body.error).toBe('invalid_payload');
    expect((await get(ctx.app, '/creators/carla/sales')).status).toBe(404);
  });
});
