import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkEscrowAmount } from '../src/lib/escrow/escrowAmount.ts';

test('default cap uses exact six-decimal USDC units', () => {
  const previous = process.env.ESCROW_MAX_AMOUNT_USDC;
  delete process.env.ESCROW_MAX_AMOUNT_USDC;
  try {
    assert.deepEqual(checkEscrowAmount('50.000000'), { units: 50_000_000n, amountUSDC: 50 });
    assert.equal(checkEscrowAmount('50.000001').status, 400);
    assert.equal(checkEscrowAmount(50_000_001n).status, 400);
    assert.equal(checkEscrowAmount('0.000001').units, 1n);
  } finally {
    if (previous !== undefined) process.env.ESCROW_MAX_AMOUNT_USDC = previous;
  }
});

test('configured fractional cap is inclusive; invalid config fails closed', () => {
  assert.equal(checkEscrowAmount('1.012345', '1.012345').units, 1_012_345n);
  assert.equal(checkEscrowAmount('1.012346', '1.012345').status, 400);
  for (const value of ['', '0', '-1', '1e3', '1.0000001', 'Infinity', '10000001']) {
    assert.equal(checkEscrowAmount('1', value).status, 503);
  }
  for (const value of [null, [], {}, '0', '-1', '1e-2', 'NaN', '0.0000009', '10 USDC']) {
    assert.equal(checkEscrowAmount(value, '50').status, 400);
  }
});

test('all FlareHQEscrow creation paths use the guard before their first funding or create sink', () => {
  for (const [file, sink] of [
    ['escrow/create', 'await circleClient.createContractExecutionTransaction'],
    ['merchant/escrow-link', 'await prisma.escrow.create'],
    ['flarehq-jobs', '.flareHQJob.create'],
    ['flarehq-jobs/[id]/fund', 'if (wallet.mode === "EXTERNAL")'],
  ]) {
    const source = readFileSync(`src/app/api/${file}/route.ts`, 'utf8');
    const guard = source.indexOf('const checked = checkEscrowAmount(');
    assert.ok(guard >= 0 && guard < source.indexOf(sink), file);
    assert.match(source.slice(guard, source.indexOf(sink)), /return NextResponse\.json\([^\n]*checked\.status/);
  }
});
