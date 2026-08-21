// scripts/test-stream-local.mjs
// LOCAL contract tests for ArcFlareStream on Hardhat's in-process EVM.
// Run:  npx hardhat run scripts/test-stream-local.mjs
// (no --network → ephemeral local network, no real funds move)

import { network } from "hardhat";

const { ethers } = await network.getOrCreate();

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  ❌ ${name} — ${detail}`);
  }
}

async function expectRevert(label, fn, needle) {
  try {
    await fn();
    ok(label, false, "did NOT revert");
  } catch (e) {
    const msg = e?.shortMessage || e?.message || String(e);
    ok(label, !needle || msg.includes(needle), `reverted with "${msg.slice(0, 90)}"`);
  }
}

const [poster, worker, stranger, ...rest] = await ethers.getSigners();
const MockToken = await ethers.getContractFactory("MockERC20", poster);
const token = await MockToken.deploy("Mock USDC", "mUSDC", 6);
const Stream = await ethers.getContractFactory("ArcFlareStream", poster);
const stream = await Stream.deploy();

console.log("── openStream ───────────────────────────────────────────────");
await expectRevert("zero budget reverts", () => stream.openStream(worker.address, token.target, 0, 3), "zero budget");
await expectRevert("zero worker reverts", () => stream.openStream(ethers.ZeroAddress, token.target, 100000, 3), "bad worker");
await expectRevert("zero tranches reverts", () => stream.openStream(worker.address, token.target, 100000, 0), "bad tranche count");
await expectRevert(">50 tranches reverts", () => stream.openStream(worker.address, token.target, 100000, 51), "bad tranche count");
await expectRevert("no allowance reverts", () => stream.openStream(worker.address, token.target, 100000, 3), "ERC20");

const BUDGET = 100000n;
await token.approve(stream.target, BUDGET);
const openTx = await stream.openStream(worker.address, token.target, BUDGET, 3);
const openReceipt = await openTx.wait();
ok("openStream emits StreamOpened", openReceipt.logs.some((l) => l.topics[0] === ethers.id("StreamOpened(uint256,address,address,address,uint256,uint256)")), "");
const streamId = 0n;

const st = await stream.getStream(streamId);
ok("stream stores poster", st.poster === poster.address, st.poster);
ok("stream stores worker", st.worker === worker.address, st.worker);
ok("stream stores token", st.token === token.target, st.token);
ok("stream stores budget", st.totalBudget === BUDGET, st.totalBudget.toString());
ok("stream stores trancheCount", st.trancheCount === 3n, st.trancheCount.toString());
ok("stream not closed", st.closed === false, "");
ok("stream holds the full budget", (await token.balanceOf(stream.target)) === BUDGET, "");

ok("tranche 0 = 33333", (await stream.trancheAmounts(streamId, 0)) === 33333n, "");
ok("tranche 1 = 33333", (await stream.trancheAmounts(streamId, 1)) === 33333n, "");
ok("tranche 2 = 33334 (remainder)", (await stream.trancheAmounts(streamId, 2)) === 33334n, "");
const sum = (await stream.trancheAmounts(streamId, 0)) + (await stream.trancheAmounts(streamId, 1)) + (await stream.trancheAmounts(streamId, 2));
ok("tranche sum == budget exactly", sum === BUDGET, sum.toString());

console.log("── releaseTranche ───────────────────────────────────────────");
await expectRevert("stranger cannot release", () => stream.connect(stranger).releaseTranche(streamId, 0), "not poster");
await expectRevert("bad index reverts", () => stream.releaseTranche(streamId, 3), "bad index");

const workerBefore = await token.balanceOf(worker.address);
const tx0 = await stream.releaseTranche(streamId, 0);
const r0 = await tx0.wait();
ok("release 0 emits TrancheReleased(0,33333)", r0.logs.some((l) => l.topics[0] === ethers.id("TrancheReleased(uint256,uint256,uint256)")), "");
ok("worker balance += 33333", (await token.balanceOf(worker.address)) - workerBefore === 33333n, "");
ok("releasedTranches[0] true", (await stream.releasedTranches(streamId, 0)) === true, "");
ok("tranchesReleased = 1", (await stream.getStream(streamId)).tranchesReleased === 1n, "");

await expectRevert("double release of index 0 reverts", () => stream.releaseTranche(streamId, 0), "already released");
// release-after-close check on a throwaway stream (closing stream 0 would
// break the later partial-close assertions)
await token.approve(stream.target, 10000n);
const throwawayId = await stream.openStream.staticCall(worker.address, token.target, 10000n, 1);
await stream.openStream(worker.address, token.target, 10000n, 1);
await stream.closeStream(throwawayId);
await expectRevert("release after close reverts", () => stream.releaseTranche(throwawayId, 0), "stream closed");

console.log("── closeStream ──────────────────────────────────────────────");
// open a second stream to test close in isolation
await token.approve(stream.target, 60000n);
const sid2 = await stream.openStream.staticCall(worker.address, token.target, 60000n, 2);
await stream.openStream(worker.address, token.target, 60000n, 2);
await expectRevert("stranger cannot close", () => stream.connect(stranger).closeStream(sid2), "not poster");
const wBefore = await token.balanceOf(worker.address);
const closeTx = await stream.closeStream(sid2);
const rc = await closeTx.wait();
ok("closeStream emits StreamClosed", rc.logs.some((l) => l.topics[0] === ethers.id("StreamClosed(uint256,uint256,uint256)")), "");
ok("close paid full remainder to worker", (await token.balanceOf(worker.address)) - wBefore === 60000n, "");
const st2 = await stream.getStream(sid2);
ok("stream closed", st2.closed === true, "");
ok("totalReleased == budget after close", st2.totalReleased === 60000n, "");
await expectRevert("double close reverts", () => stream.closeStream(sid2), "already closed");

// stream 1: partial release then close pays remainder (33334)
const wB2 = await token.balanceOf(worker.address);
await stream.releaseTranche(streamId, 1);
const wB3 = await token.balanceOf(worker.address);
ok("release 1 pays 33333", wB3 - wB2 === 33333n, "");
await stream.closeStream(streamId);
const wB4 = await token.balanceOf(worker.address);
ok("close after partial release pays remainder 33334", wB4 - wB3 === 33334n, "");
const st1 = await stream.getStream(streamId);
ok("final totalReleased == budget", st1.totalReleased === BUDGET, st1.totalReleased.toString());
ok("two tranches released on-chain before close", st1.tranchesReleased === 2n, st1.tranchesReleased.toString());

// no funds ever return to the poster
ok("poster never receives a single token", (await token.balanceOf(poster.address)) === 1000000000000n - BUDGET - 60000n - 10000n, "");

console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f.name} — ${f.detail}`);
  process.exit(1);
}
console.log("✅ ArcFlareStream local contract tests passed");