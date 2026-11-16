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
const escrow = await ethers.deployContract('FlareHQEscrow', [await token.getAddress(), admin.address]);
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
await assert.rejects(ethers.deployContract('FlareHQEscrow', [stranger.address, admin.address]));
await assert.rejects(ethers.deployContract('FlareHQEscrow', [await token.getAddress(), ethers.ZeroAddress]));
await assert.rejects(escrow.transferAdmin(ethers.ZeroAddress));
await assert.rejects(escrow.connect(stranger).transferAdmin(stranger.address));
await escrow.transferAdmin(beneficiary.address);
assert.equal(await escrow.admin(), admin.address);
await assert.rejects(escrow.connect(stranger).acceptAdmin());
await escrow.connect(beneficiary).acceptAdmin();
assert.equal(await escrow.admin(), beneficiary.address);
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
console.log(`Escrow lifecycle, authorization, replay, expiry, two-step admin, false/no-return tokens, transfer fees and reentrancy checks passed; ${abiReads} raw getter reads decoded with the production ABI in both ethers and viem.`);
