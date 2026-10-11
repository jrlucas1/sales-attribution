import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.ts';
import type { Db } from '../src/db.ts';

// Segunda linha de defesa: mesmo que o código de ingestão erre,
// o banco recusa venda ou estorno em duplicidade.
let db: Db;

const insertOrder = "INSERT INTO orders VALUES ('1', 10000, 'BRL', 'paid', NULL, 'none', 'agora')";
const insertSale =
  "INSERT INTO ledger_entries (order_id, kind, amount_cents, created_at) VALUES ('1', 'sale', 10000, 'agora')";
const insertRefund =
  "INSERT INTO refunds (id, order_id, requested_cents, currency, status, received_at) VALUES ('r1', '1', 3000, 'BRL', 'pending', 'agora')";
const insertRefundEntry =
  "INSERT INTO ledger_entries (order_id, kind, amount_cents, refund_id, created_at) VALUES ('1', 'refund', -3000, 'r1', 'agora')";

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

  it('recusa dois lançamentos para o mesmo estorno', () => {
    db.exec(insertRefund);
    db.exec(insertRefundEntry);
    expect(() => db.exec(insertRefundEntry)).toThrow(/UNIQUE/);
  });
});
