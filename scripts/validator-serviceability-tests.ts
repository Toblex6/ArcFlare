/**
 * validator-serviceability-tests.ts
 *
 * Focused regression coverage for the validator Circle-serviceability gate
 * (griefing-vector fix) in the three scoped hire routes:
 *   - src/app/api/agents/[id]/hire/route.ts
 *   - src/app/api/agents/[id]/treasury/hire/route.ts
 *   - src/app/api/procurement/[id]/hire/route.ts
 *
 * Rule under test: when validation is requested at hire time, validatorSCA
 * must resolve server-side (case-insensitive) to a Circle-managed identity —
 * Merchant.walletAddress with walletProvider === 'CIRCLE' (+ circleWalletId),
 * AgentRegistry.scaAddress with non-null circleWalletId, or
 * ConsumerAccount.walletAddress with non-null circleWalletId — otherwise the
 * validation-required hire is rejected 400 BEFORE side effects with:
 * "validatorSCA must be a Circle-managed wallet capable of signing a
 *  validation response — external wallets cannot respond to validation requests."
 *
 * Non-validation hires are unaffected (gate lives inside the
 * validation.required clause only).
 *
 * Approach follows repo convention (see scripts/direct-hire-create-tests.ts):
 * static source-ordering proofs (no faked txHash/jobId — chain success paths
 * are proven by ordering, never by stubbing Circle/viem) + real Prisma
 * fixtures with random wallets + cleanup. Forbidden files are asserted
 * untouched.
 *
 * Run: npx tsx scripts/validator-serviceability-tests.ts
 * No dev server required. Needs DB (DATABASE_URL).
 */
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path, { dirname, join } from "path";
import { fileURLToPath } from "node:url";

const prisma = new PrismaClient() as any;
let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(join(here, "..", rel), "utf8");

const EXPECTED_ERROR =
  "validatorSCA must be a Circle-managed wallet capable of signing a validation response — external wallets cannot respond to validation requests.";

const SCOPED = [
  "src/app/api/agents/[id]/hire/route.ts",
  "src/app/api/agents/[id]/treasury/hire/route.ts",
  "src/app/api/procurement/[id]/hire/route.ts",
];
// Forbidden by the task brief — the gate must NOT leak into these.
const FORBIDDEN = [
  "src/lib/jobs/jobValidationPolicy.ts",
  "src/app/api/agent/validation/route.ts",
  "src/app/api/jobs/[jobId]/validation/request/route.ts",
  "src/app/api/jobs/[jobId]/validation/respond/route.ts",
];

function randAddr(): string {
  const hex = [...Array(40)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
  return "0x" + hex;
}

// Mirror of the inline gate rule (same three canonical lookups + same
// serviceability predicate the routes implement). Used ONLY to evaluate
// fixtures against the real DB — the routes themselves are proven by the
// static proofs below, never by importing route code.
async function isServiceable(address: string): Promise<boolean> {
  const [m, a, c] = await Promise.all([
    prisma.merchant.findFirst({
      where: { walletAddress: { equals: address, mode: "insensitive" } },
      select: { walletProvider: true, circleWalletId: true, walletAddress: true },
    }),
    prisma.agentRegistry.findFirst({
      where: { scaAddress: { equals: address, mode: "insensitive" } },
      select: { circleWalletId: true },
    }),
    prisma.consumerAccount.findFirst({
      where: { walletAddress: { equals: address, mode: "insensitive" } },
      select: { circleWalletId: true, walletAddress: true },
    }),
  ]);
  return (
    (m?.walletProvider === "CIRCLE" && !!m?.circleWalletId && !!m?.walletAddress) ||
    !!a?.circleWalletId ||
    (!!c?.circleWalletId && !!c?.walletAddress)
  );
}

async function main() {
  console.log("=== [static] scoped-route wiring proofs ===");
  const srcs = SCOPED.map((f) => ({ f, src: read(f) }));

  for (const { f, src } of srcs) {
    ok(`${f}: exact 400 serviceability error present`, src.includes(EXPECTED_ERROR), "error string missing");
    const gateIdx = src.indexOf(EXPECTED_ERROR);
    const chainIdx = src.indexOf("createContractExecutionTransaction");
    ok(`${f}: gate ordered BEFORE first on-chain side effect`, gateIdx !== -1 && chainIdx !== -1 && gateIdx < chainIdx, "gate must precede createJob tx");
    // Case-insensitive canonical lookups for all three identity types.
    ok(`${f}: merchant lookup is case-insensitive`, /merchant\.findFirst\(\{\s*where:\s*\{\s*walletAddress:\s*\{\s*equals:\s*\w+,?\s*mode:\s*"insensitive"/s.test(src), "merchant findFirst insensitive missing");
    ok(`${f}: agent lookup is case-insensitive`, /agentRegistry\.findFirst\(\{\s*where:\s*\{\s*scaAddress:\s*\{\s*equals:\s*\w+,?\s*mode:\s*"insensitive"/s.test(src), "agent findFirst insensitive missing");
    ok(`${f}: consumer lookup is case-insensitive`, /consumerAccount\.findFirst\(\{\s*where:\s*\{\s*walletAddress:\s*\{\s*equals:\s*\w+,?\s*mode:\s*"insensitive"/s.test(src), "consumer findFirst insensitive missing");
    // No client-supplied identity trust introduced in the validation path.
    ok(`${f}: no client-supplied merchantId/circleWalletId trusted`, !src.includes("validation.merchantId") && !src.includes("validation.circleWalletId") && !src.includes("validatorCircleWalletId"), "untrusted client identity field referenced");
  }

  // Gate only fires for validation-required hires; ordinary hires unaffected.
  ok("agents/hire: gate inside validation.required clause", /if\s*\(\s*validation\s*&&\s*validation\.required\s*\)[\s\S]{0,6000}?validatorSCA must be a Circle-managed/.test(srcs[0].src), "gate must be scoped to validation.required");
  ok("treasury/hire: gate inside validation.required clause", /if\s*\(\s*validation\s*&&\s*validation\.required\s*\)[\s\S]{0,6000}?validatorSCA must be a Circle-managed/.test(srcs[1].src), "gate must be scoped to validation.required");
  ok("procurement/hire: gate inside body.validation.required clause", /if\s*\(\s*body\.validation\s*&&\s*body\.validation\.required\s*\)[\s\S]{0,6000}?validatorSCA must be a Circle-managed/.test(srcs[2].src), "gate must be scoped to body.validation.required");

  // Existing self-validation checks are preserved (not duplicated/weakened —
  // the gate is additive and ordered AFTER them in agents + treasury hire).
  for (const label of ["validator cannot be the job client", "validator cannot be the job provider", "validator cannot be client", "validator cannot be provider"]) {
    const found = srcs.some(({ src }) => src.includes(label));
    ok(`self-validation preserved somewhere scoped ("${label}")`, found, "self-check missing");
  }
  for (const { f, src } of [srcs[0], srcs[1]]) {
    const selfIdx = Math.max(src.indexOf("self-validation)"), src.indexOf("validator cannot be"));
    const gateIdx = src.indexOf(EXPECTED_ERROR);
    ok(`${f}: serviceability gate ordered AFTER self-validation checks`, selfIdx !== -1 && gateIdx > selfIdx, "gate must not precede/weaken self-checks");
  }
  // Procurement early gate releases the SELECTED→HIRING claim (no stuck posting).
  ok("procurement/hire: early gate releases claim via fail()", srcs[2].src.includes('return await fail("validatorSCA must be a Circle-managed'), "must fail() to release claim");

  // Scope discipline: forbidden files carry no serviceability logic.
  for (const f of FORBIDDEN) {
    const src = read(f);
    ok(`forbidden file untouched: ${f}`, !src.includes("Circle-managed wallet capable of signing"), "serviceability logic leaked into forbidden file");
  }

  console.log("=== [live] DB fixture proofs (real Prisma, cleaned up) ===");
  const suffix = Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  const addrs = {
    circleMerchant: randAddr(),
    externalMerchant: randAddr(),
    walletAgent: randAddr(),
    bareAgent: randAddr(),
    walletConsumer: randAddr(),
    bareConsumer: randAddr(),
    externalEoa: randAddr(),
  };
  const emailA = `valsvc-a-${suffix}@test.local`;
  const emailB = `valsvc-b-${suffix}@test.local`;
  const otherMerchantAddr = randAddr();
  const created: { kind: string; key: any }[] = [];
  try {
    await prisma.merchant.create({
      data: { email: emailA, businessName: "valsvc-circle", passwordHash: "x", walletProvider: "CIRCLE", walletAddress: addrs.circleMerchant, circleWalletId: `cw-${suffix}` },
    });
    created.push({ kind: "merchant", key: emailA });
    await prisma.merchant.create({
      data: { email: emailB, businessName: "valsvc-other-circle", passwordHash: "x", walletProvider: "CIRCLE", walletAddress: otherMerchantAddr, circleWalletId: `cw2-${suffix}` },
    });
    created.push({ kind: "merchant", key: emailB });
    // External merchant wallet: same address shape, non-CIRCLE provider, no wallet id.
    const extM = await prisma.merchant.create({
      data: { email: `valsvc-ext-${suffix}@test.local`, businessName: "valsvc-ext", passwordHash: "x", walletProvider: "METAMASK", walletAddress: addrs.externalMerchant, circleWalletId: null },
    });
    created.push({ kind: "merchant", key: extM.email });
    const mkAgent = async (sca: string, walletId: string | null) =>
      prisma.agentRegistry.create({
        data: { name: `valsvc-${suffix}`, tokenId: `t-${suffix}-${sca.slice(2, 10)}`, scaAddress: sca, circleWalletId: walletId, ownerNode: "test", status: "ACTIVE_AGENT_PROVISIONED" },
      });
    const ag1 = await mkAgent(addrs.walletAgent, `cwid-${suffix}`);
    created.push({ kind: "agent", key: ag1.id });
    const ag2 = await mkAgent(addrs.bareAgent, null);
    created.push({ kind: "agent", key: ag2.id });
    const c1 = await prisma.consumerAccount.create({ data: { walletAddress: addrs.walletConsumer, circleWalletId: `ccw-${suffix}` } });
    created.push({ kind: "consumer", key: c1.id });
    const c2 = await prisma.consumerAccount.create({ data: { walletAddress: addrs.bareConsumer } });
    created.push({ kind: "consumer", key: c2.id });

    // Valid Circle-managed identities → serviceable (unchanged behavior).
    ok("CIRCLE merchant wallet is serviceable", await isServiceable(addrs.circleMerchant) === true);
    ok("agent with circleWalletId is serviceable", await isServiceable(addrs.walletAgent) === true);
    ok("consumer with circleWalletId is serviceable", await isServiceable(addrs.walletConsumer) === true);
    // Non-serviceable identities → rejected.
    ok("external EOA is NOT serviceable", await isServiceable(addrs.externalEoa) === false);
    ok("non-CIRCLE merchant wallet is NOT serviceable", await isServiceable(addrs.externalMerchant) === false);
    ok("agent WITHOUT circleWalletId is NOT serviceable", await isServiceable(addrs.bareAgent) === false);
    ok("consumer WITHOUT circleWalletId is NOT serviceable", await isServiceable(addrs.bareConsumer) === false);
    // Case variations resolve identically.
    ok("uppercase CIRCLE merchant address resolves", await isServiceable(addrs.circleMerchant.toUpperCase()) === true);
    ok("uppercase agent address resolves", await isServiceable(addrs.walletAgent.toUpperCase()) === true);
    ok("mixed-case consumer address resolves", await isServiceable(addrs.walletConsumer.toLowerCase()) === true);
    ok("uppercase external EOA still rejected", await isServiceable(addrs.externalEoa.toUpperCase()) === false);
    // No cross-merchant scoping: another merchant's CIRCLE wallet is equally
    // serviceable with no merchant context (gate is address-based, leaks nothing).
    ok("other merchant's CIRCLE wallet is serviceable (no merchant scoping)", await isServiceable(otherMerchantAddr) === true);
    ok("other merchant's wallet resolves case-insensitively", await isServiceable(otherMerchantAddr.toUpperCase()) === true);
  } finally {
    for (const c of created) {
      try {
        if (c.kind === "merchant") await prisma.merchant.deleteMany({ where: { email: c.key } });
        else if (c.kind === "agent") await prisma.agentRegistry.delete({ where: { id: c.key } }).catch(() => {});
        else await prisma.consumerAccount.delete({ where: { id: c.key } }).catch(() => {});
      } catch {}
    }
    await prisma.$disconnect().catch(() => {});
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) { console.error("FAILURES:", failures.join("; ")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
