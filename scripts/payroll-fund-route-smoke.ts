// scripts/payroll-fund-route-smoke.ts
//
// HTTP smoke test for POST /api/payroll/fund:
//   1. unauthenticated call → 401 (merchant auth wrapper)
//   2. merchant session, no payment-signature → 402 + PAYMENT-REQUIRED header
//      (the x402 challenge shape the client signs against)
//   3. merchant session, garbage payment-signature → 402 (invalid payment)
//
// Requires the dev server on :3000 (BASE). Uses merchant A ("acne corp")
// with a temporarily rehashed password, restored in a finally block.
//
// Run: npx tsx scripts/payroll-fund-route-smoke.ts

import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

const BASE = process.argv[2] ?? "http://localhost:3000";
const TEST_PASSWORD = "E2E_Test_123!";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, info = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${info ? " — " + info : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${info ? " — " + info : ""}`); }
};

async function main() {
  const merchant = await prisma.merchant.findFirst({
    where: { businessName: "acne corp", verified: true, active: true },
  });
  if (!merchant?.email || !merchant.passwordHash) {
    throw new Error("merchant A not found — needed for the session");
  }
  const originalHash = merchant.passwordHash;
  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { passwordHash: await bcrypt.hash(TEST_PASSWORD, 10) },
  });

  try {
    // ── 1. unauthenticated → 401 ───────────────────────────────────────────
    const anon = await fetch(`${BASE}/api/payroll/fund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipients: [{ address: "0x0000000000000000000000000000000000000001", amount: "0.01" }] }),
    });
    ok("unauthenticated → 401", anon.status === 401, `got ${anon.status}`);

    // ── merchant session ───────────────────────────────────────────────────
    const loginRes = await fetch(`${BASE}/api/merchant/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: merchant.email, password: TEST_PASSWORD }),
    });
    const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
    ok("merchant A login ok", loginRes.status === 200 && cookie.length > 0, `got ${loginRes.status}`);

    const payHeaders = {
      "Content-Type": "application/json",
      cookie,
    };

    // ── 2. no payment-signature → 402 + PAYMENT-REQUIRED challenge ────────
    const challenge = await fetch(`${BASE}/api/payroll/fund`, {
      method: "POST",
      headers: payHeaders,
      body: JSON.stringify({ recipients: [{ address: "0x0000000000000000000000000000000000000001", amount: "0.01" }] }),
    });
    const challengeHeader = challenge.headers.get("PAYMENT-REQUIRED");
    let challengeParses = false;
    let challengeAmount = "";
    if (challengeHeader) {
      try {
        const parsed = JSON.parse(Buffer.from(challengeHeader, "base64").toString("utf-8"));
        challengeParses = parsed.x402Version === 2 && Array.isArray(parsed.accepts);
        challengeAmount = parsed.accepts?.[0]?.amount ?? "";
      } catch { /* leave false */ }
    }
    ok("no payment → 402 + PAYMENT-REQUIRED header", challenge.status === 402 && challengeParses,
      `status ${challenge.status}, amount ${challengeAmount} (expect 10000)`);

    // ── 3. garbage payment-signature → 402 ─────────────────────────────────
    const garbage = await fetch(`${BASE}/api/payroll/fund`, {
      method: "POST",
      headers: { ...payHeaders, "payment-signature": "bm90LWEtcGF5bWVudA==" }, // "not-a-payment"
      body: JSON.stringify({ recipients: [{ address: "0x0000000000000000000000000000000000000001", amount: "0.01" }] }),
    });
    ok("garbage payment-signature → 402", garbage.status === 402, `got ${garbage.status}`);

    // ── 4. invalid body → 400 ──────────────────────────────────────────────
    const badBody = await fetch(`${BASE}/api/payroll/fund`, {
      method: "POST",
      headers: payHeaders,
      body: JSON.stringify({ recipients: [{ address: "0x123", amount: "0.01" }] }),
    });
    ok("invalid recipient address → 400", badBody.status === 400, `got ${badBody.status}`);
  } finally {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { passwordHash: originalHash },
    });
  }

  console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) process.exit(1);
  console.log("✅ payroll/fund route smoke verified");
}

main().catch((e) => { console.error("smoke threw:", e.message); process.exit(1); });
