import assert from 'node:assert/strict';
import { network } from 'hardhat';
const { ethers } = await network.getOrCreate();
const [admin, beneficiary, stranger] = await ethers.getSigners();
const token = await ethers.deployContract('EscrowTestToken');
const escrow = await ethers.deployContract('FlareHQEscrow', [await token.getAddress(), admin.address]);
await token.approve(await escrow.getAddress(), 1000000);
let n = 0;
const id = () => ethers.id(`escrow-${++n}`);
async function create() {
  const key = id();
  const block = await ethers.provider.getBlock('latest');
  await escrow.createEscrow(key, beneficiary.address, 100, block.timestamp + 100, 'delivery');
  return key;
}
const a = await create();
assert.equal((await escrow.getEscrow(a)).amount, 100n);
assert.deepEqual(Array.from(await escrow.getEscrow(a)), Array.from(await escrow.escrows(a)));
await assert.rejects(escrow.connect(stranger).confirmDelivery(a));
await escrow.confirmDelivery(a);
assert.equal(await token.balanceOf(beneficiary.address), 0n);
await escrow.connect(beneficiary).confirmDelivery(a);
assert.equal(await token.balanceOf(beneficiary.address), 100n);
await assert.rejects(escrow.confirmDelivery(a));
for (const release of [true, false]) {
  const key = await create();
  await assert.rejects(escrow.connect(stranger).dispute(key, 'x'));
  await escrow.connect(beneficiary).dispute(key, 'not delivered');
  await assert.rejects(escrow.confirmDelivery(key));
  await assert.rejects(escrow.connect(stranger).resolveDispute(key, release));
  await escrow.resolveDispute(key, release);
  assert.equal(await escrow.settled(key), true);
  await assert.rejects(escrow.resolveDispute(key, release));
}
const expired = await create();
await assert.rejects(escrow.refundExpired(expired));
await ethers.provider.send('evm_increaseTime', [101]);
await ethers.provider.send('evm_mine', []);
await assert.rejects(escrow.connect(stranger).refundExpired(expired));
await escrow.refundExpired(expired);
assert.equal(await escrow.settled(expired), true);
await assert.rejects(escrow.createEscrow(expired, beneficiary.address, 100, 9999999999, 'reuse'));
await assert.rejects(escrow.createEscrow(id(), admin.address, 100, 9999999999, 'self'));
await assert.rejects(escrow.createEscrow(id(), beneficiary.address, 0, 9999999999, 'zero'));
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
console.log('Escrow lifecycle, authorization, replay, expiry, two-step admin, false/no-return tokens, transfer fees and reentrancy checks passed.');
