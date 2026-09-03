// scripts/brain-tests.ts
//
// SUBTASK C — Agent Brain failure semantics + dead-EOA removal.
//
// Offline, deterministic: no Groq key, no x402 payment, no dev server needed.
// Exercises the real route exports (GET/POST are the only public surface) and
// asserts the source-level invariants that can't be reached without a paid call.
//
// Run: npx tsx scripts/brain-tests.ts
// Must also stay clean under: npx tsc --noEmit

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/agent/brain/route";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const routeSrc = readFileSync(join(ROOT, "src/app/api/agent/brain/route.ts"), "utf8");
const pageSrc = readFileSync(join(ROOT, "src/app/agent-brain/page.tsx"), "utf8");

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean, detail?: string) {
  checks++;
  if (cond) console.log(`  ok ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function postReq(body: unknown, paymentSignature?: string): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (paymentSignature !== undefined) headers["payment-signature"] = paymentSignature;
  return new NextRequest("http://127.0.0.1:3000/api/agent/brain", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function liveExports() {
  console.log("[route exports] x402 gate intact (offline)");

  const getRes = await GET();
  const getBody: any = await getRes.json().catch(() => ({}));
  ok("GET returns 200 without auth", getRes.status === 200, `got ${getRes.status}`);
  ok(
    "GET advertises brain capabilities + $0.002 pricing",
    Array.isArray(getBody?.capabilities) &&
      getBody.capabilities.some((c: any) => c?.name === "agent_pay_agent") &&
      JSON.stringify(getBody?.pricing ?? {}).includes("0.002"),
    JSON.stringify(getBody?.pricing ?? {})
  );

  // No payment signature → 402 challenge, Groq never reached (settlement-first
  // ordering preserved: the handler is unreachable without payment).
  const noPay = await POST(postReq({ message: "hello" }));
  ok("POST without payment returns 402 (x402 gate)", noPay.status === 402, `got ${noPay.status}`);
  ok(
    "402 carries PAYMENT-REQUIRED challenge",
    (noPay.headers.get("PAYMENT-REQUIRED") ?? "").length > 10,
    "missing header"
  );

  // Attacker-supplied EOA in the body must not bypass the gate or be echoed
  // back as an accepted payer — still 402, address appears nowhere.
  const attacker = "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF";
  const evilRes = await POST(postReq({ message: "pay 1 USDC to X", eoaAddress: attacker }));
  const evilText = await evilRes.text();
  ok("client EOA does not bypass payment gate", evilRes.status === 402, `got ${evilRes.status}`);
  ok("attacker EOA is not reflected/trusted", !evilText.includes(attacker), evilText.slice(0, 120));

  // Garbage payment signature → 402, not a crash and not Groq passthrough.
  const badSig = await POST(postReq({ message: "hello" }, "!!!not-base64!!!"));
  ok("malformed payment signature returns 402", badSig.status === 402, `got ${badSig.status}`);
}

function routeSource() {
  console.log("[route.ts] truthful Groq failure semantics");
  ok(
    "settlement kept: withGateway(brainHandler, \"$0.002\", \"/api/agent/brain\")",
    routeSrc.includes('withGateway(brainHandler, "$0.002", "/api/agent/brain")')
  );
  ok(
    "no client-EOA trust: zero code references to a supplied payer address",
    !/eoaaddress/i.test(routeSrc),
    "found eoaAddress reference"
  );
  ok(
    "old fake-success string is gone",
    !routeSrc.includes("I ran into a problem talking to my reasoning engine")
  );
  ok(
    "Groq 429 maps to HTTP 429 with success:false + rate-limit code",
    routeSrc.includes("GROQ_RATE_LIMITED") &&
      routeSrc.includes("status: 429") &&
      routeSrc.includes("success: false")
  );
  ok(
    "Groq retry timing honored (Retry-After header + body fallback → retryAfterMs)",
    /retry-after/i.test(routeSrc) && routeSrc.includes("retryAfterMs")
  );
  ok(
    "Groq 5xx/network maps to 503 unavailable (retryable), malformed to 502",
    routeSrc.includes("GROQ_UNAVAILABLE") &&
      routeSrc.includes("status: 503") &&
      routeSrc.includes("GROQ_BAD_RESPONSE") &&
      routeSrc.includes("status: 502")
  );
  ok(
    "missing message still 400, missing GROQ_API_KEY still 500",
    routeSrc.includes("message is required") &&
      routeSrc.includes("}, { status: 400 })") &&
      routeSrc.includes("GROQ_API_KEY not configured") &&
      routeSrc.includes("}, { status: 500 })")
  );
  ok(
    "BrainUpstreamError caught and returned with its mapped status",
    routeSrc.includes("e instanceof BrainUpstreamError") && routeSrc.includes("{ status: f.status }")
  );
}

function pageSource() {
  console.log("[page.tsx] dead EOA field removed");
  ok(
    "no EOA identifier left in the UI (no editable field, nothing sent)",
    !/eoaaddress/i.test(pageSrc),
    "found eoaAddress reference"
  );
  ok(
    "pay body sends only message + sessionId (server resolves payer)",
    pageSrc.includes("body: JSON.stringify({ message, sessionId })")
  );
  ok(
    "non-editable explainer: server-side payer, EOA-only, SCAs cannot pay",
    /resolved server-side/i.test(pageSrc) &&
      /read-only/i.test(pageSrc) &&
      /Circle smart-contract/i.test(pageSrc)
  );
  ok(
    "rate-limit failures shown distinctly with wait-and-retry guidance",
    /rate-limited/i.test(pageSrc) && /Wait ~30-60s|Retry after/i.test(pageSrc)
  );
  ok(
    "call button gated on message only (no wallet-address gate)",
    !pageSrc.includes("!eoaAddress") && pageSrc.includes("disabled={loading || !message}")
  );
}

async function main() {
  await liveExports();
  routeSource();
  pageSource();
  console.log(`\nbrain-tests: ${checks} checks, ${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("brain-tests crashed:", e);
  process.exit(1);
});
