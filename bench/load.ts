// Carga e estresse contra o servidor real, em outro processo, com banco em arquivo.
// No fim confere os invariantes direto no banco. Uso: npm run bench
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SEED_SHOPS } from '../src/db.ts';
import { signBody } from '../src/signature.ts';

const SHOP = SEED_SHOPS[0]!;

const LOAD_REQUESTS = Number(process.env.LOAD_REQUESTS ?? 20_000);
const LOAD_CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 50);
const STRESS_REQUESTS = Number(process.env.STRESS_REQUESTS ?? 4_000);
const STRESS_LEVELS = [10, 50, 200, 500, 1000];

interface Stats {
  latencies: number[];
  statuses: Map<number, number>;
  failures: number;
  elapsedMs: number;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

let baseUrl = '';

async function send(stats: Stats, method: 'GET' | 'POST', path: string, body?: unknown): Promise<void> {
  const start = performance.now();
  try {
    const json = body ? JSON.stringify(body) : undefined;
    const response = await fetch(baseUrl + path, {
      method,
      // Os webhooks vão assinados pela loja de desenvolvimento que o servidor cadastra ao subir.
      headers: json
        ? {
            'content-type': 'application/json',
            'x-shop-domain': SHOP.domain,
            'x-hmac-sha256': signBody(SHOP.webhookSecret, json),
          }
        : undefined,
      body: json,
    });
    await response.arrayBuffer();
    stats.statuses.set(response.status, (stats.statuses.get(response.status) ?? 0) + 1);
  } catch {
    stats.failures++;
  }
  stats.latencies.push(performance.now() - start);
}

// Mantém `concurrency` requisições em voo até completar `total`.
async function runPool(
  total: number,
  concurrency: number,
  task: (index: number, stats: Stats) => Promise<void>,
): Promise<Stats> {
  const stats: Stats = { latencies: [], statuses: new Map(), failures: 0, elapsedMs: 0 };
  let next = 0;
  const start = performance.now();
  const worker = async () => {
    while (next < total) {
      const index = next++;
      await task(index, stats);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  stats.elapsedMs = performance.now() - start;
  return stats;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;
}

function report(label: string, stats: Stats): void {
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const total = sorted.length;
  const rps = (total / stats.elapsedMs) * 1000;
  const statuses = [...stats.statuses].map(([status, count]) => `${status}:${count}`).join(' ');
  console.log(
    label.padEnd(26) +
      `${total}`.padStart(7) +
      `${rps.toFixed(0)}`.padStart(8) +
      `${percentile(sorted, 50).toFixed(1)}`.padStart(8) +
      `${percentile(sorted, 95).toFixed(1)}`.padStart(8) +
      `${percentile(sorted, 99).toFixed(1)}`.padStart(8) +
      `${(sorted[total - 1] ?? 0).toFixed(1)}`.padStart(9) +
      `   ${statuses}${stats.failures ? ` falhas de conexão:${stats.failures}` : ''}`,
  );
}

function header(title: string): void {
  console.log(`\n${title}`);
  console.log(
    'cenário'.padEnd(26) +
      'reqs'.padStart(7) +
      'req/s'.padStart(8) +
      'p50 ms'.padStart(8) +
      'p95 ms'.padStart(8) +
      'p99 ms'.padStart(8) +
      'máx ms'.padStart(9) +
      '   status',
  );
}

function order(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    total_price: '100.00',
    currency: 'BRL',
    status: 'paid',
    discount_codes: [{ code: 'ANA10' }],
    landing_site: '/?utm_source=conty&utm_content=bruno',
    ...overrides,
  };
}

function refund(id: string, orderId: string, amount = '30.00'): Record<string, unknown> {
  return { id, order_id: orderId, amount, currency: 'BRL' };
}

// Mistura parecida com o uso real. A cada 10 requisições:
// 5 pedidos novos, 1 pedido repetido, 1 estorno, 1 estorno que chega antes do pedido,
// 1 estorno repetido e 1 leitura. Um a cada 50 pedidos chega como pending.
function mixedTask(index: number, stats: Stats): Promise<void> {
  const slot = index % 10;
  if (slot <= 4) {
    const status = index % 50 === 0 ? 'pending' : 'paid';
    return send(stats, 'POST', '/webhooks/orders', order(`m${index}`, { status }));
  }
  if (slot === 5) {
    return send(stats, 'POST', '/webhooks/orders', order(`m${index - 5}`));
  }
  if (slot === 6) {
    return send(stats, 'POST', '/webhooks/refunds', refund(`mr${index}`, `m${index - 6}`));
  }
  if (slot === 7) {
    return send(stats, 'POST', '/webhooks/refunds', refund(`mr${index}`, `m${index + 3}`, '150.00'));
  }
  if (slot === 8) {
    return send(stats, 'POST', '/webhooks/refunds', refund(`mr${index - 2}`, `m${index - 8}`));
  }
  return send(stats, 'GET', `/orders/m${index - 9}`);
}

interface Check {
  name: string;
  sql: string;
}

// Cada query conta violações; todas precisam dar zero.
const CHECKS: Check[] = [
  {
    name: 'pedido paid sem exatamente um lançamento de venda',
    sql: `SELECT COUNT(*) FROM orders WHERE status = 'paid' AND
          (SELECT COUNT(*) FROM ledger_entries WHERE order_id = orders.id AND kind = 'sale') <> 1`,
  },
  {
    name: 'pedido não pago com lançamento',
    sql: `SELECT COUNT(*) FROM orders WHERE status <> 'paid' AND
          EXISTS (SELECT 1 FROM ledger_entries WHERE order_id = orders.id)`,
  },
  {
    name: 'soma dos estornos maior que a venda',
    sql: `SELECT COUNT(*) FROM (SELECT order_id FROM ledger_entries GROUP BY order_id HAVING SUM(amount_cents) < 0)`,
  },
  {
    name: 'estorno aplicado acima do valor pedido',
    sql: `SELECT COUNT(*) FROM refunds WHERE applied_cents > requested_cents`,
  },
  {
    name: 'estorno pendente de pedido já resolvido',
    sql: `SELECT COUNT(*) FROM refunds JOIN orders ON orders.id = refunds.order_id
          WHERE refunds.status = 'pending' AND orders.status <> 'pending'`,
  },
  {
    name: 'valor aplicado diferente do lançamento',
    sql: `SELECT COUNT(*) FROM refunds
          LEFT JOIN ledger_entries ON ledger_entries.refund_id = refunds.id
          WHERE refunds.status = 'applied' AND refunds.applied_cents <> COALESCE(-ledger_entries.amount_cents, 0)`,
  },
  {
    name: 'lançamento com criador diferente do pedido',
    sql: `SELECT COUNT(*) FROM ledger_entries JOIN orders ON orders.id = ledger_entries.order_id
          WHERE ledger_entries.creator_id IS NOT orders.creator_id`,
  },
];

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sales-bench-'));
  const dbPath = join(dir, 'bench.db');
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;

  const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath },
    stdio: 'ignore',
  });

  let failed = false;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await fetch(`${baseUrl}/orders/ping`);
        break;
      } catch {
        if (attempt > 100) throw new Error('o servidor não subiu');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    header(`CARGA: mistura de pedidos, estornos e leituras, ${LOAD_CONCURRENCY} conexões`);
    report('mistura', await runPool(LOAD_REQUESTS, LOAD_CONCURRENCY, mixedTask));

    header(`ESTRESSE: ${STRESS_REQUESTS} webhooks por nível (pedido novo e o estorno dele)`);
    for (const level of STRESS_LEVELS) {
      const stats = await runPool(STRESS_REQUESTS, level, (index, current) => {
        const id = `s${level}-${index >> 1}`;
        return index % 2 === 0
          ? send(current, 'POST', '/webhooks/orders', order(id))
          : send(current, 'POST', '/webhooks/refunds', refund(`sr${level}-${index}`, id));
      });
      report(`${level} conexões`, stats);
    }

    header('DISPUTA: tudo no mesmo pedido, 200 conexões');
    report(
      'mesmo pedido 1000 vezes',
      await runPool(1000, 200, (_, stats) => send(stats, 'POST', '/webhooks/orders', order('hot'))),
    );
    // Pedido de R$ 10,00 e 2000 estornos de R$ 0,01: só 1000 podem ser aplicados.
    await send({ latencies: [], statuses: new Map(), failures: 0, elapsedMs: 0 }, 'POST', '/webhooks/orders', order('cap', { total_price: '10.00' }));
    report(
      '2000 estornos de 1 centavo',
      await runPool(2000, 200, (index, stats) =>
        send(stats, 'POST', '/webhooks/refunds', refund(`cap${index}`, 'cap', '0.01')),
      ),
    );

    header('LEITURA com o banco cheio');
    report('GET /orders/:id', await runPool(2000, 50, (index, stats) => send(stats, 'GET', `/orders/m${index * 10}`)));
    report('GET /creators/:id/sales', await runPool(200, 10, (_, stats) => send(stats, 'GET', '/creators/ana/sales')));
  } finally {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }

  const db = new Database(dbPath, { readonly: true });
  const count = (sql: string) => Object.values(db.prepare(sql).get() as Record<string, number>)[0] ?? 0;

  console.log('\nBANCO');
  for (const table of ['orders', 'refunds', 'ledger_entries']) {
    console.log(`  ${table.padEnd(16)} ${count(`SELECT COUNT(*) FROM ${table}`)} linhas`);
  }

  console.log('\nINVARIANTES (violações)');
  for (const check of CHECKS) {
    const violations = count(check.sql);
    failed ||= violations > 0;
    console.log(`  ${violations === 0 ? 'ok  ' : 'ERRO'} ${String(violations).padStart(5)}  ${check.name}`);
  }

  const hotSales = count("SELECT COUNT(*) FROM ledger_entries WHERE order_id = 'hot' AND kind = 'sale'");
  const capRefunded = count("SELECT -SUM(amount_cents) FROM ledger_entries WHERE order_id = 'cap' AND kind = 'refund'");
  const capRecorded = count("SELECT COUNT(*) FROM refunds WHERE order_id = 'cap'");
  failed ||= hotSales !== 1 || capRefunded !== 1000 || capRecorded !== 2000;
  console.log(`  ${hotSales === 1 ? 'ok  ' : 'ERRO'} pedido enviado 1000 vezes tem ${hotSales} lançamento de venda`);
  console.log(
    `  ${capRefunded === 1000 && capRecorded === 2000 ? 'ok  ' : 'ERRO'} pedido de 1000 centavos: ${capRefunded} estornados, ${capRecorded} estornos registrados`,
  );

  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (failed) {
    console.log('\nFALHOU');
    process.exit(1);
  }
  console.log('\nnenhuma violação');
}

await main();
