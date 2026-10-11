import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.ts';
import type { Db } from '../src/db.ts';

// Segunda linha de defesa: mesmo que o código de ingestão erre,
// o banco recusa venda ou estorno em duplicidade.
let db: Db;

const insertOrder = "INSERT INTO orders VALUES ('1', 10000, 'BRL', 'paid', NULL, 'none', 'agora')";
const insertSale =
  "INSERT INTO ledger_entries (order_id, kind, amount_cents, currency, created_at) VALUES ('1', 'sale', 10000, 'BRL', 'agora')";
const insertRefund =
  "INSERT INTO refunds (id, order_id, requested_cents, currency, status, received_at) VALUES ('r1', '1', 3000, 'BRL', 'pending', 'agora')";
const insertRefundEntry =
  "INSERT INTO ledger_entries (order_id, kind, amount_cents, currency, refund_id, created_at) VALUES ('1', 'refund', -3000, 'BRL', 'r1', 'agora')";

beforeEach(() => {
  db = openDatabase();
  db.exec(insertOrder);
});

describe('restrições do banco', () => {
  it('recusa o mesmo pedido duas vezes', () => {
    expect(() => db.exec(insertOrder)).toThrow(/UNIQUE/);
  });

  it('recusa dois lançamentos de venda para o mesmo pedido', () => {
    db.exec(insertSale);
    expect(() => db.exec(insertSale)).toThrow(/UNIQUE/);
  });

  it('recusa o mesmo estorno duas vezes', () => {
    db.exec(insertRefund);
    expect(() => db.exec(insertRefund)).toThrow(/UNIQUE/);
  });

  it('recusa cupom ou UTM de outro criador que só muda maiúsculas', () => {
    db.exec("INSERT INTO creators VALUES ('ana', 'ANA10', 'ana')");
    expect(() => db.exec("INSERT INTO creators VALUES ('outra', 'ana10', 'outra')")).toThrow(
      /UNIQUE/,
    );
    expect(() => db.exec("INSERT INTO creators VALUES ('outra', 'OUTRA10', 'Ana')")).toThrow(
      /UNIQUE/,
    );
  });

  it('busca os lançamentos de um pedido por índice, sem varrer a tabela', () => {
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT amount_cents FROM ledger_entries WHERE order_id = ?')
      .all('1') as { detail: string }[];

    expect(plan.map((step) => step.detail).join(' ')).toContain('USING INDEX ledger_by_order');
  });

  it('soma os totais de um criador só pelo índice, sem ler a tabela', () => {
    const plan = db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT currency, SUM(amount_cents) FROM ledger_entries WHERE creator_id = ? GROUP BY currency',
      )
      .all('ana') as { detail: string }[];

    expect(plan.map((step) => step.detail)).toEqual([
      'SEARCH ledger_entries USING COVERING INDEX ledger_totals_by_creator (creator_id=?)',
    ]);
  });

  it('recusa dois lançamentos para o mesmo estorno', () => {
    db.exec(insertRefund);
    db.exec(insertRefundEntry);
    expect(() => db.exec(insertRefundEntry)).toThrow(/UNIQUE/);
  });
});
