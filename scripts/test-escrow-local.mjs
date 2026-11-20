import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { decodeFunctionResult } from 'viem';
import { network } from 'hardhat';

// Load the literal production ABI declaration, without evaluating that module's
// network/config exports. No copied ABI, dotenv, RPC, or wallet configuration.
const abiSource = ts.createSourceFile('flarehqContracts.ts', readFileSync(new URL('../src/lib/wallet/flarehqContracts.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const abiStatement = abiSource.statements.find((statement) => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some((declaration) => declaration.name.getText(abiSource) === 'escrowAbi'));
assert.ok(abiStatement, 'production escrowAbi declaration exists');
const initializer = abiStatement.declarationList.declarations[0].initializer;
assert.ok(ts.isAsExpression(initializer) && ts.isArrayLiteralExpression(initializer.expression), 'ABI remains a literal array');
const { outputText } = ts.transpileModule(abiStatement.getText(abiSource), { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { escrowAbi } = await import(`data:text/javascript,${encodeURIComponent(outputText)}`);

const { ethers } = await network.getOrCreate();
const [admin, beneficiary, stranger] = await ethers.getSigners();
const token = await ethers.deployContract('EscrowTestToken');
const escrow = await ethers.deployContract('FlareHQEscrow', [await token.getAddress(), admin.address, admin.address, stranger.address]);
assert.equal(await escrow.owner(), admin.address);
assert.equal(await escrow.arbiter(), admin.address);
assert.equal(await escrow.treasury(), stranger.address);
assert.equal(await escrow.FEE_BPS(), 25n);
await token.approve(await escrow.getAddress(), 1000000);
let n = 0;
let abiReads = 0;
const terms = new Map();
const backendInterface = new ethers.Interface(escrowAbi);
const id = () => ethers.id(`escrow-${++n}`);
async function create(condition = 'delivery') {
  const key = id();
  const block = await ethers.provider.getBlock('latest');
  const deadline = block.timestamp + 100;
  await escrow.createEscrow(key, beneficiary.address, 100, deadline, condition);
  terms.set(key, { depositor: admin.address, beneficiary: beneficiary.address, amount: 100n, deadline: BigInt(deadline), ref: condition });
  return key;
}
async function assertBackendTuple(key, depositorConfirmed = false, beneficiaryConfirmed = false) {
  const expected = { ...terms.get(key), depositorConfirmed, beneficiaryConfirmed };
  for (const functionName of ['getEscrow', 'escrows']) {
    const data = await ethers.provider.call({ to: await escrow.getAddress(), data: backendInterface.encodeFunctionData(functionName, [key]) });
    // Decode real EVM return bytes with both backend-supported libraries, not
    // the generated Solidity artifact (which could hide a mismatched ABI).
    const decodedEthers = backendInterface.decodeFunctionResult(functionName, data)[0];
    const decodedViem = decodeFunctionResult({ abi: escrowAbi, functionName, data });
    for (const decoded of [decodedEthers, decodedViem]) {
      for (const [field, value] of Object.entries(expected)) assert.equal(decoded[field], value, `${functionName}.${field}`);
    }
    abiReads++;
  }
}
const missing = id();
terms.set(missing, { depositor: ethers.ZeroAddress, beneficiary: ethers.ZeroAddress, amount: 0n, deadline: 0n, ref: '' });
await assertBackendTuple(missing);
const a = await create('Delivery with a dynamic string longer than one ABI word — café ✓');
assert.equal((await escrow.getEscrow(a)).amount, 100n);
assert.deepEqual(Array.from(await escrow.getEscrow(a)), Array.from(await escrow.escrows(a)));
await assertBackendTuple(a);
await assert.rejects(escrow.connect(stranger).confirmDelivery(a));
await escrow.confirmDelivery(a);
await assertBackendTuple(a, true, false);
assert.equal(await token.balanceOf(beneficiary.address), 0n);
await escrow.connect(beneficiary).confirmDelivery(a);
await assertBackendTuple(a, true, true);
assert.equal(await token.balanceOf(beneficiary.address), 100n);
await assert.rejects(escrow.confirmDelivery(a));
for (const release of [true, false]) {
  const key = await create();
  await assert.rejects(escrow.connect(stranger).dispute(key, 'x'));
  await escrow.connect(beneficiary).dispute(key, 'not delivered');
  await assertBackendTuple(key);
  await assert.rejects(escrow.confirmDelivery(key));
  await assert.rejects(escrow.dispute(key, 'duplicate'));
  await assert.rejects(escrow.connect(stranger).resolveDispute(key, release));
  await escrow.resolveDispute(key, release);
  await assertBackendTuple(key);
  assert.equal(await escrow.settled(key), true);
  await assert.rejects(escrow.resolveDispute(key, release));
}
const expired = await create();
await assert.rejects(escrow.refundExpired(expired));
await ethers.provider.send('evm_increaseTime', [101]);
await ethers.provider.send('evm_mine', []);
await assert.rejects(escrow.connect(stranger).refundExpired(expired));
await escrow.refundExpired(expired);
await assertBackendTuple(expired);
assert.equal(await escrow.settled(expired), true);
await assert.rejects(escrow.createEscrow(expired, beneficiary.address, 100, 9999999999, 'reuse'));
await assert.rejects(escrow.createEscrow(id(), admin.address, 100, 9999999999, 'self'));
await assert.rejects(escrow.createEscrow(id(), beneficiary.address, 0, 9999999999, 'zero'));
await assert.rejects(escrow.createEscrow(ethers.ZeroHash, beneficiary.address, 100, 9999999999, 'zero id'));
await assert.rejects(escrow.createEscrow(id(), ethers.ZeroAddress, 100, 9999999999, 'zero beneficiary'));
await assert.rejects(escrow.createEscrow(id(), await escrow.getAddress(), 100, 9999999999, 'contract beneficiary'));
await assert.rejects(escrow.createEscrow(id(), beneficiary.address, 100, 1, 'expired terms'));
await assert.rejects(ethers.deployContract('FlareHQEscrow', [stranger.address, admin.address, admin.address, stranger.address]));
await assert.rejects(ethers.deployContract('FlareHQEscrow', [await token.getAddress(), ethers.ZeroAddress, admin.address, stranger.address]));
await assert.rejects(ethers.deployContract('FlareHQEscrow', [await token.getAddress(), admin.address, ethers.ZeroAddress, stranger.address]));
await assert.rejects(ethers.deployContract('FlareHQEscrow', [await token.getAddress(), admin.address, admin.address, ethers.ZeroAddress]));
await assert.rejects(escrow.setArbiter(ethers.ZeroAddress));
await assert.rejects(escrow.setTreasury(ethers.ZeroAddress));
await assert.rejects(escrow.connect(stranger).setArbiter(stranger.address));
await assert.rejects(escrow.connect(stranger).setTreasury(stranger.address));
await assert.rejects(escrow.transferAdmin(ethers.ZeroAddress));
await assert.rejects(escrow.connect(stranger).transferAdmin(stranger.address));
await escrow.transferAdmin(beneficiary.address);
assert.equal(await escrow.admin(), admin.address);
await assert.rejects(escrow.connect(stranger).acceptAdmin());
await escrow.connect(beneficiary).acceptAdmin();
assert.equal(await escrow.admin(), beneficiary.address);
// 25 bps release fee: beneficiary gets net, treasury gets the fee, the
// contract retains nothing, and a refund returns the full amount (no fee).
async function createAmount(amount) {
  const key = id();
  const block = await ethers.provider.getBlock('latest');
  await escrow.createEscrow(key, beneficiary.address, amount, block.timestamp + 500, 'fee test');
  return key;
}
const feeAmount = 10000n;
const benBeforeFee = await token.balanceOf(beneficiary.address);
const treasBeforeFee = await token.balanceOf(stranger.address);
const feeKey = await createAmount(feeAmount);
await escrow.confirmDelivery(feeKey);
await escrow.connect(beneficiary).confirmDelivery(feeKey);
assert.equal(await token.balanceOf(beneficiary.address), benBeforeFee + feeAmount - 25n, 'beneficiary receives net of 25 bps');
assert.equal(await token.balanceOf(stranger.address), treasBeforeFee + 25n, 'treasury receives 25 bps');
assert.equal(await escrow.settled(feeKey), true);
const refundKey = await createAmount(feeAmount);
const depBeforeRefund = await token.balanceOf(admin.address);
await ethers.provider.send('evm_increaseTime', [501]);
await ethers.provider.send('evm_mine', []);
await escrow.refundExpired(refundKey);
assert.equal(await token.balanceOf(admin.address), depBeforeRefund + feeAmount, 'expired refund has no fee');

// Arbiter is the only dispute resolver; owner and strangers cannot decide.
const alt = await ethers.deployContract('FlareHQEscrow', [await token.getAddress(), admin.address, stranger.address, stranger.address]);
await token.approve(await alt.getAddress(), 1000);
const altKey = id();
await alt.createEscrow(altKey, beneficiary.address, 1000, (await ethers.provider.getBlock('latest')).timestamp + 500, 'arbiter test');
await alt.connect(beneficiary).dispute(altKey, 'not delivered');
await assert.rejects(alt.connect(admin).resolveDispute(altKey, true));
await assert.rejects(alt.connect(beneficiary).resolveDispute(altKey, true));
await alt.connect(stranger).resolveDispute(altKey, true);
assert.equal(await alt.settled(altKey), true);

// Fuzz release accounting over deterministic pseudo-random amounts.
let seed = 123456789n;
const nextAmount = () => { seed = (seed * 1103515245n + 12345n) % 2147483648n; return (seed % 5000n) + 1n; };
for (let i = 0; i < 12; i++) {
  const amount = nextAmount();
  const bBefore = await token.balanceOf(beneficiary.address);
  const tBefore = await token.balanceOf(stranger.address);
  const key = await createAmount(amount);
  await escrow.confirmDelivery(key);
  await escrow.connect(beneficiary).confirmDelivery(key);
  const fee = (amount * 25n) / 10000n;
  assert.equal(await token.balanceOf(beneficiary.address), bBefore + amount - fee, `fuzz #${i} net`);
  assert.equal(await token.balanceOf(stranger.address), tBefore + fee, `fuzz #${i} fee`);
  await assert.rejects(escrow.connect(beneficiary).confirmDelivery(key), 'double release must revert');
}

// Failed/fee-taking token transfers must roll back custody and lifecycle state.
for (const mode of [1, 2]) {
  await token.configure(mode, ethers.ZeroAddress, '0x');
  await assert.rejects(create());
  await token.configure(0, ethers.ZeroAddress, '0x');
  const key = await create();
  await escrow.confirmDelivery(key);
  await token.configure(mode, ethers.ZeroAddress, '0x');
  await assert.rejects(escrow.connect(beneficiary).confirmDelivery(key));
  assert.equal(await escrow.settled(key), false);
  assert.equal((await escrow.getEscrow(key)).beneficiaryConfirmed, false);
  await token.configure(0, ethers.ZeroAddress, '0x');
  await escrow.connect(beneficiary).confirmDelivery(key);
}
// Reentrant create from the token callback is refused by the guard.
await token.configure(3, await escrow.getAddress(), escrow.interface.encodeFunctionData('createEscrow', [id(), beneficiary.address, 1, 9999999999, 'attack']));
const reentrant = await create();
assert.equal(await token.callbackSucceeded(), false);
await escrow.confirmDelivery(reentrant);
await escrow.connect(beneficiary).confirmDelivery(reentrant);
assert.equal(await token.callbackSucceeded(), false);
// SafeERC20 accepts a successful legacy token with no return value.
await token.configure(4, ethers.ZeroAddress, '0x');
const legacy = await create();
await escrow.confirmDelivery(legacy);
await escrow.connect(beneficiary).confirmDelivery(legacy);
assert.equal(await escrow.settled(legacy), true);

// Invariant pass with independent roles and two open escrows. Involuntary
// transfers of the ERC-20 can add surplus but must not change liabilities.
const [,, outsider, owner, arbiter, treasury] = await ethers.getSigners();
const reserve = await ethers.deployContract('FlareHQEscrow', [await token.getAddress(), owner.address, arbiter.address, treasury.address]);
const reserveAddress = await reserve.getAddress();
await token.approve(reserveAddress, 50_000);
const open = new Map();
async function assertReserve(surplus = 0n) {
  const liabilities = [...open.values()].reduce((total, amount) => total + amount, 0n);
  assert.equal(await token.balanceOf(reserveAddress), liabilities + surplus);
}
const currentBlock = await ethers.provider.getBlock('latest');
const releaseId = id();
const disputeId = id();
await reserve.connect(admin).createEscrow(releaseId, beneficiary.address, 10_000, currentBlock.timestamp + 1000, 'fee recipient overlaps beneficiary');
open.set(releaseId, 10_000n);
await assertReserve();
await reserve.connect(admin).createEscrow(disputeId, beneficiary.address, 20_000, currentBlock.timestamp + 1000, 'disputed refund');
open.set(disputeId, 20_000n);
await assertReserve();
await assert.rejects(reserve.connect(arbiter).resolveDispute(disputeId, true));
await assert.rejects(reserve.connect(owner).confirmDelivery(releaseId));
await assert.rejects(reserve.connect(arbiter).refundExpired(releaseId));
await reserve.connect(beneficiary).dispute(disputeId, 'disagree');
await assert.rejects(reserve.connect(owner).resolveDispute(disputeId, false));
await assert.rejects(reserve.connect(outsider).resolveDispute(disputeId, false));
await reserve.connect(owner).setTreasury(beneficiary.address);
await assertReserve();
const beneficiaryBefore = await token.balanceOf(beneficiary.address);
await reserve.confirmDelivery(releaseId);
await reserve.connect(beneficiary).confirmDelivery(releaseId);
assert.equal(await token.balanceOf(beneficiary.address) - beneficiaryBefore, 10_000n);
await assert.rejects(reserve.connect(beneficiary).confirmDelivery(releaseId));
open.delete(releaseId);
await assertReserve();
const depositorBefore = await token.balanceOf(admin.address);
await reserve.connect(arbiter).resolveDispute(disputeId, false);
assert.equal(await token.balanceOf(admin.address) - depositorBefore, 20_000n);
assert.equal(await token.balanceOf(owner.address), 0n);
assert.equal(await token.balanceOf(arbiter.address), 0n);
await assert.rejects(reserve.connect(arbiter).resolveDispute(disputeId, false));
open.delete(disputeId);
await assertReserve();
await token.transfer(reserveAddress, 17);
await assertReserve(17n);
console.log(`Escrow lifecycle and accounting invariants passed, including 12 randomized payouts and ${abiReads} production ABI getter reads.`);
