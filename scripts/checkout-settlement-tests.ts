import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { NextRequest } from 'next/server';

type Intent = {
  id: string;
  invoiceReference: string | null;
  checkoutTopUpReference: string | null;
  checkoutTopUpAfter: string | null;
  sourceWallet: string;
  sourceChain: string;
  destination: string;
  amount: string;
  status: string;
  burnTxHash: string;
  mintTxHash: string | null;
  actualAmount: string | null;
  cctpNonce: string | null;
  error: string | null;
};

const invoice = { reference: 'invoice-1', amount: 10, status: 'PENDING', merchantSCA: '0x' + 'a'.repeat(40) };
const intents: Intent[] = [];
const settledFees: string[] = [];
let proofAmount = 0n;
let proofHash = '';
let feeCalls = 0;
let txTail = Promise.resolve();

const db: any = {
  paymentLog: {
    async findUnique() { return { ...invoice }; },
    async updateMany({ where, data }: any) {
      if (where.reference !== invoice.reference || !where.status.in.includes(invoice.status)) return { count: 0 };
      Object.assign(invoice, data);
      return { count: 1 };
    },
  },
  flowBridgeIntent: {
    async findUnique({ where }: any) { return structuredClone(intents.find((row) => row.id === where.id) ?? null); },
    async findFirst({ where }: any) {
      if (where.id?.not) {
        return intents.find((row) => row.id !== where.id.not && row.mintTxHash?.toLowerCase() === where.mintTxHash.equals.toLowerCase()) ?? null;
      }
      return null;
    },
    async findMany({ where }: any) {
      const reference = where.OR[0].invoiceReference ?? where.OR[1].checkoutTopUpReference;
      return intents.filter((row) => (row.invoiceReference ?? row.checkoutTopUpReference) === reference
        && row.status === 'COMPLETED' && row.actualAmount !== null && row.mintTxHash !== null && row.cctpNonce !== null)
        .map((row) => ({ actualAmount: row.actualAmount }));
    },
    async updateMany({ where, data }: any) {
      const row = intents.find((item) => item.id === where.id && item.status === where.status);
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  },
  async $transaction(fn: (tx: any) => Promise<unknown>) {
    const previous = txTail;
    let release!: () => void;
    txTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await fn(db); } finally { release(); }
  },
  async $executeRawUnsafe() { return 1; },
};

mock.module('@/lib/prisma', { namedExports: { prisma: db } });
mock.module('@/lib/ratelimit', { namedExports: { checkRateLimit: async () => ({ allowed: true, response: null }) } });
mock.module('@/lib/config/network', { namedExports: { explorerTxUrl: (hash: string) => `https://explorer.invalid/${hash}` } });
mock.module('@/lib/bridge/sourceChains', { namedExports: { formatBridgeBaseUnits: (amount: bigint) => (Number(amount) / 1e6).toFixed(6) } });
mock.module('@/lib/bridge/externalVerify', {
  namedExports: {
    verifyArcMint: async () => ({ ok: true, actualAmount: proofAmount, mintTxHash: proofHash }),
    sourceCctpV2: () => ({ domain: 6, tokenMessenger: '0x' + 'b'.repeat(20) }),
  },
});
mock.module('@/lib/bridge/irisNonce', { namedExports: { fetchIrisBridgeMessage: async () => ({ ok: true, nonce: 'nonce-1' }) } });
mock.module('@/lib/bridge/stageLogger', { namedExports: { logBridgeStage: async (_id: string, stage: any) => { settledFees.push(stage.stage); } } });
mock.module('@/lib/payments/settleFeeBestEffort', { namedExports: { settleFeeBestEffort: async () => { feeCalls++; } } });
mock.module('@/lib/tokens/resolveCurrency', { namedExports: { resolveRowCurrency: () => ({ symbol: 'USDC' }) } });

const { POST } = await import('../src/app/api/checkout/[reference]/bridge/complete/route');

function makeIntent(id: string, topUpAfter: string | null = null): Intent {
  return {
    id,
    invoiceReference: topUpAfter ? null : invoice.reference,
    checkoutTopUpReference: topUpAfter ? invoice.reference : null,
    checkoutTopUpAfter: topUpAfter,
    sourceWallet: '0x' + 'c'.repeat(40),
    sourceChain: 'Ethereum_Sepolia',
    destination: invoice.merchantSCA,
    amount: '6000000',
    status: 'BURN_CONFIRMED',
    burnTxHash: `burn-${id}`,
    mintTxHash: null,
    actualAmount: null,
    cctpNonce: null,
    error: null,
  };
}

async function complete(intent: string, mintTxHash: string) {
  return POST(new NextRequest('http://localhost/api/checkout/invoice-1/bridge/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intent, mintTxHash }),
  }), { params: Promise.resolve({ reference: invoice.reference }) });
}

test('underpayment remains unpaid; sequential top-up settles once; replay and concurrent retry are idempotent', async () => {
  intents.length = 0;
  settledFees.length = 0;
  feeCalls = 0;
  txTail = Promise.resolve();
  invoice.status = 'PENDING';

  const first = makeIntent('leg-1');
  intents.push(first);
  proofAmount = 4_000_000n;
  proofHash = '0x' + '1'.repeat(64);
  const underpaid = await (await complete(first.id, proofHash)).json();
  assert.equal(underpaid.code, 'UNDERPAID');
  assert.equal(underpaid.remainingAmountDisplay, '6.000000');
  assert.equal(invoice.status, 'PENDING');
  assert.equal(feeCalls, 0);

  const replay = await (await complete(first.id, proofHash)).json();
  assert.equal(replay.code, 'UNDERPAID');
  assert.equal(replay.actualAmount, '4000000');

  const topUp = makeIntent('leg-2', first.id);
  intents.push(topUp);
  proofAmount = 6_000_000n;
  proofHash = '0x' + '2'.repeat(64);
  const concurrent = await Promise.all([complete(topUp.id, proofHash), complete(topUp.id, proofHash)]);
  const payloads = await Promise.all(concurrent.map((response) => response.json()));
  assert.ok(payloads.every((body) => body.success && body.state === 'completed'));
  assert.equal(invoice.status, 'SUCCESS');
  assert.equal(feeCalls, 1);
  assert.equal(intents.filter((row) => row.status === 'COMPLETED').length, 2);

  const completedReplay = await (await complete(topUp.id, proofHash)).json();
  assert.equal(completedReplay.success, true);
  assert.equal(completedReplay.actualAmount, '10000000');
  assert.equal(feeCalls, 1);
});
