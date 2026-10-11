import Database from 'better-sqlite3';
import type { Creator } from './attribution.ts';

export type Db = Database.Database;
type Statement = Database.Statement<unknown[], unknown>;

const statementsByDb = new WeakMap<Db, Map<string, Statement>>();

// Prepara cada SQL uma vez por conexão e devolve o mesmo statement nas chamadas seguintes.
// Preparar custa cerca de 11 µs; um webhook usa de 5 a 8 statements.
export function prepared(db: Db, sql: string): Statement {
  let statements = statementsByDb.get(db);
  if (!statements) {
    statements = new Map();
    statementsByDb.set(db, statements);
  }
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

// ledger_entries é só de inserção: +total na venda, -valor aplicado em cada estorno.
// O valor líquido de um pedido ou criador é sempre a soma dos lançamentos.
// O lançamento copia a moeda do pedido. Como nenhum dos dois muda depois, a cópia não diverge.
// A regra de atribuição não diferencia maiúsculas, então o banco também não pode
// aceitar o mesmo cupom ou a mesma UTM para dois criadores mudando só a caixa.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS creators (
  id          TEXT PRIMARY KEY,
  coupon_code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  utm_content TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,
  total_cents        INTEGER NOT NULL CHECK (total_cents >= 0),
  currency           TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'cancelled')),
  creator_id         TEXT REFERENCES creators (id),
  attribution_reason TEXT NOT NULL CHECK (attribution_reason IN ('coupon', 'utm', 'none')),
  received_at        TEXT NOT NULL
);

-- order_id não é chave estrangeira: o estorno pode chegar antes do pedido.
CREATE TABLE IF NOT EXISTS refunds (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  order_id        TEXT NOT NULL,
  requested_cents INTEGER NOT NULL CHECK (requested_cents > 0),
  currency        TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'discarded')),
  applied_cents   INTEGER,
  discard_reason  TEXT,
  received_at     TEXT NOT NULL,
  resolved_at     TEXT
);

CREATE INDEX IF NOT EXISTS refunds_by_order ON refunds (order_id);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     TEXT NOT NULL REFERENCES orders (id),
  creator_id   TEXT REFERENCES creators (id),
  kind         TEXT NOT NULL CHECK (kind IN ('sale', 'refund')),
  amount_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  refund_id    TEXT UNIQUE REFERENCES refunds (id),
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ledger_by_order ON ledger_entries (order_id);

-- Cobre a query de totais do criador inteira: ela não precisa ler a tabela.
CREATE INDEX IF NOT EXISTS ledger_totals_by_creator
  ON ledger_entries (creator_id, currency, kind, amount_cents);

-- Um pedido só pode ter um lançamento de venda.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_one_sale_per_order
  ON ledger_entries (order_id) WHERE kind = 'sale';
`;

export function openDatabase(path = ':memory:'): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function insertCreators(db: Db, creators: Creator[]): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO creators (id, coupon_code, utm_content) VALUES (?, ?, ?)',
  );
  for (const creator of creators) {
    insert.run(creator.id, creator.couponCode, creator.utmContent);
  }
}

export const SEED_CREATORS: Creator[] = [
  { id: 'ana', couponCode: 'ANA10', utmContent: 'ana' },
  { id: 'bruno', couponCode: 'BRUNO10', utmContent: 'bruno' },
];
