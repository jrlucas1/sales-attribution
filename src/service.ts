import { attribute } from './attribution.ts';
import type { AttributionInput, AttributionReason, Creator } from './attribution.ts';
import type { Db } from './db.ts';

export type OrderStatus = 'pending' | 'paid' | 'cancelled';
export type RefundStatus = 'pending' | 'applied' | 'discarded';

export interface OrderInput extends AttributionInput {
  id: string;
  totalCents: number;
  currency: string;
  status: OrderStatus;
}

export interface RefundInput {
  id: string;
  orderId: string;
  amountCents: number;
  currency: string;
}

export type OrderOutcome = 'created' | 'updated' | 'duplicate';
export type RefundOutcome = RefundStatus | 'duplicate';

interface OrderRow {
  id: string;
  total_cents: number;
  currency: string;
  status: OrderStatus;
  creator_id: string | null;
  attribution_reason: AttributionReason;
  received_at: string;
}

interface RefundRow {
  id: string;
  order_id: string;
  requested_cents: number;
  currency: string;
  status: RefundStatus;
  applied_cents: number | null;
  discard_reason: string | null;
  received_at: string;
  resolved_at: string | null;
}

interface LedgerRow {
  kind: 'sale' | 'refund';
  amount_cents: number;
  refund_id: string | null;
  created_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function listCreators(db: Db): Creator[] {
  return db
    .prepare('SELECT id, coupon_code AS couponCode, utm_content AS utmContent FROM creators')
    .all() as Creator[];
}

function findOrder(db: Db, orderId: string): OrderRow | undefined {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow | undefined;
}

function orderBalance(db: Db, orderId: string): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS balance FROM ledger_entries WHERE order_id = ?')
    .get(orderId) as { balance: number };
  return row.balance;
}

function discardRefund(db: Db, refundId: string, reason: string): void {
  db.prepare(
    "UPDATE refunds SET status = 'discarded', applied_cents = 0, discard_reason = ?, resolved_at = ? WHERE id = ?",
  ).run(reason, now(), refundId);
}

// Resolve um estorno contra um pedido que já saiu de pending.
// O valor aplicado nunca passa do saldo que ainda resta no pedido.
function resolveRefund(db: Db, refund: RefundRow, order: OrderRow): void {
  if (order.status === 'cancelled') {
    discardRefund(db, refund.id, 'order_cancelled');
    return;
  }
  if (refund.currency !== order.currency) {
    discardRefund(db, refund.id, 'currency_mismatch');
    return;
  }

  const appliedCents = Math.min(refund.requested_cents, orderBalance(db, order.id));
  if (appliedCents > 0) {
    db.prepare(
      "INSERT INTO ledger_entries (order_id, creator_id, kind, amount_cents, refund_id, created_at) VALUES (?, ?, 'refund', ?, ?, ?)",
    ).run(order.id, order.creator_id, -appliedCents, refund.id, now());
  }
  db.prepare(
    "UPDATE refunds SET status = 'applied', applied_cents = ?, resolved_at = ? WHERE id = ?",
  ).run(appliedCents, now(), refund.id);
}

// Chamado quando o pedido chega como paid ou cancelled, ou sai de pending.
// Lança a venda (se paid) e resolve os estornos que estavam esperando, em ordem de chegada.
function settleOrder(db: Db, order: OrderRow): void {
  if (order.status === 'pending') {
    return;
  }
  if (order.status === 'paid') {
    db.prepare(
      "INSERT INTO ledger_entries (order_id, creator_id, kind, amount_cents, created_at) VALUES (?, ?, 'sale', ?, ?)",
    ).run(order.id, order.creator_id, order.total_cents, now());
  }

  const waiting = db
    .prepare("SELECT * FROM refunds WHERE order_id = ? AND status = 'pending' ORDER BY seq")
    .all(order.id) as RefundRow[];
  for (const refund of waiting) {
    resolveRefund(db, refund, order);
  }
}

export function ingestOrder(db: Db, input: OrderInput): OrderOutcome {
  const run = db.transaction((): OrderOutcome => {
    const existing = findOrder(db, input.id);

    if (!existing) {
      const { creatorId, reason } = attribute(input, listCreators(db));
      const order: OrderRow = {
        id: input.id,
        total_cents: input.totalCents,
        currency: input.currency,
        status: input.status,
        creator_id: creatorId,
        attribution_reason: reason,
        received_at: now(),
      };
      db.prepare(
        'INSERT INTO orders (id, total_cents, currency, status, creator_id, attribution_reason, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        order.id,
        order.total_cents,
        order.currency,
        order.status,
        order.creator_id,
        order.attribution_reason,
        order.received_at,
      );
      settleOrder(db, order);
      return 'created';
    }

    // Só pending -> paid e pending -> cancelled mudam alguma coisa.
    // Total, moeda e criador ficam como chegaram da primeira vez.
    if (existing.status !== 'pending' || input.status === 'pending') {
      return 'duplicate';
    }
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(input.status, existing.id);
    settleOrder(db, { ...existing, status: input.status });
    return 'updated';
  });
  return run.immediate();
}

export function ingestRefund(db: Db, input: RefundInput): RefundOutcome {
  const run = db.transaction((): RefundOutcome => {
    const inserted = db
      .prepare(
        "INSERT INTO refunds (id, order_id, requested_cents, currency, status, received_at) VALUES (?, ?, ?, ?, 'pending', ?) ON CONFLICT (id) DO NOTHING",
      )
      .run(input.id, input.orderId, input.amountCents, input.currency, now());
    if (inserted.changes === 0) {
      return 'duplicate';
    }

    const order = findOrder(db, input.orderId);
    if (!order || order.status === 'pending') {
      return 'pending';
    }

    const refund = db.prepare('SELECT * FROM refunds WHERE id = ?').get(input.id) as RefundRow;
    resolveRefund(db, refund, order);
    const resolved = db.prepare('SELECT status FROM refunds WHERE id = ?').get(input.id) as {
      status: RefundStatus;
    };
    return resolved.status;
  });
  return run.immediate();
}

function listRefunds(db: Db, orderId: string): RefundRow[] {
  return db
    .prepare(
      'SELECT id, order_id, requested_cents, currency, status, applied_cents, discard_reason, received_at, resolved_at FROM refunds WHERE order_id = ? ORDER BY seq',
    )
    .all(orderId) as RefundRow[];
}

export interface OrderView {
  order: OrderRow | null;
  sale_cents: number;
  refunded_cents: number;
  net_cents: number;
  ledger: LedgerRow[];
  refunds: RefundRow[];
}

// Devolve null só quando não existe nem pedido nem estorno para o id:
// um pedido que ainda não chegou pode ter estornos esperando por ele.
export function getOrderView(db: Db, orderId: string): OrderView | null {
  const order = findOrder(db, orderId) ?? null;
  const refunds = listRefunds(db, orderId);
  if (!order && refunds.length === 0) {
    return null;
  }

  const ledger = db
    .prepare(
      'SELECT kind, amount_cents, refund_id, created_at FROM ledger_entries WHERE order_id = ? ORDER BY id',
    )
    .all(orderId) as LedgerRow[];

  let saleCents = 0;
  let refundedCents = 0;
  for (const entry of ledger) {
    if (entry.kind === 'sale') {
      saleCents += entry.amount_cents;
    } else {
      refundedCents -= entry.amount_cents;
    }
  }

  return {
    order,
    sale_cents: saleCents,
    refunded_cents: refundedCents,
    net_cents: saleCents - refundedCents,
    ledger,
    refunds,
  };
}

export interface CreatorTotals {
  currency: string;
  orders: number;
  sale_cents: number;
  refunded_cents: number;
  net_cents: number;
}

export interface CreatorSales {
  creator_id: string;
  totals: CreatorTotals[];
}

export function getCreatorSales(db: Db, creatorId: string): CreatorSales | null {
  const creator = db.prepare('SELECT id FROM creators WHERE id = ?').get(creatorId);
  if (!creator) {
    return null;
  }

  const totals = db
    .prepare(
      `SELECT
         orders.currency AS currency,
         COUNT(DISTINCT ledger_entries.order_id) AS orders,
         SUM(CASE WHEN ledger_entries.kind = 'sale' THEN ledger_entries.amount_cents ELSE 0 END) AS sale_cents,
         SUM(CASE WHEN ledger_entries.kind = 'refund' THEN -ledger_entries.amount_cents ELSE 0 END) AS refunded_cents,
         SUM(ledger_entries.amount_cents) AS net_cents
       FROM ledger_entries
       JOIN orders ON orders.id = ledger_entries.order_id
       WHERE ledger_entries.creator_id = ?
       GROUP BY orders.currency
       ORDER BY orders.currency`,
    )
    .all(creatorId) as CreatorTotals[];

  return { creator_id: creatorId, totals };
}
