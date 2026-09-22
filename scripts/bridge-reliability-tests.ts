// scripts/bridge-reliability-tests.ts
//
// Reliability-gap regression tests for the EXTERNAL Bridge (no funds, no
// chain writes, DB-free):
//
//   1. Persistent resume state — saveBridgeResume/loadBridgeResume round-trip
//      through a localStorage mock, surviving a simulated reload (in-memory
//      refs dropped, store re-read from persistence).
//   2. Pre-signing balance/gas preflight — checkBridgePreflight blocks a
//      known-insufficient wallet (native gas AND USDC) before signing, with
//      the exact user-facing copy the task requires.
//   3. Static wiring guards — ExternalBridge.tsx persists on every forward
//      step, rehydrates on mount, runs the preflight before kit.bridge(),
//      and keeps the single-bridge / kit.retry-resume invariants.
//
// Run: npx tsx scripts/bridge-reliability-tests.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  saveBridgeResume,
  loadBridgeResume,
  clearBridgeResume,
  extractBurnTxHash,
  BRIDGE_RESUME_TTL_MS,
} from "@/lib/bridge/resumeStore";
import {
  checkBridgePreflight,
  nativeSymbolForChainId,
  formatNativeWei,
  MIN_NATIVE_WEI,
} from "@/lib/bridge/preflight";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} — ${detail}`);
  }
}

// ── localStorage mock (simulated browser, survives "reload") ───────────────
const backing = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  get length() {
    return backing.size;
  },
  key: (i: number) => [...backing.keys()][i] ?? null,
} as unknown as Storage;
(globalThis as any).window = { localStorage: fakeStorage };

const WALLET = "0x03baB7F3D5B5Ed19A5f2b1f46B8d9B4bCa123456";
const REF = "11111111-2222-4333-8444-555555555555";
const BURN = `0x${"ab".repeat(32)}`;

async function main() {
  // ── 1. Persistent resume state ───────────────────────────────────────────
  backing.clear();
  ok("no resume before any save", loadBridgeResume(WALLET) === null);

  saveBridgeResume({
    intentReference: REF,
    sourceChainId: "Arbitrum_Sepolia",
    sourceWallet: WALLET,
    burnTxHash: null,
    amount: "10.00",
    destination: "0xc119bb61c119bb61c119bb61c119bb61c119bb61",
  });
  const beforeReload = loadBridgeResume(WALLET);
  ok(
    "resume loads pre-reload (reference + source chain)",
    beforeReload?.intentReference === REF && beforeReload?.sourceChainId === "Arbitrum_Sepolia",
    JSON.stringify(beforeReload)
  );

  // Simulate the burn landing, then a RELOAD: drop every in-memory handle
  // (nothing here references module state — the only copy is persistence).
  saveBridgeResume({
    intentReference: REF,
    sourceChainId: "Arbitrum_Sepolia",
    sourceWallet: WALLET,
    burnTxHash: BURN,
    amount: "10.00",
  });
  const afterReload = loadBridgeResume(WALLET); // fresh read, no in-memory ref
  ok(
    "resume survives simulated reload with burnTxHash",
    afterReload?.intentReference === REF &&
      afterReload?.sourceChainId === "Arbitrum_Sepolia" &&
      afterReload?.burnTxHash === BURN,
    JSON.stringify(afterReload)
  );
  ok(
    "resume is wallet-scoped (foreign wallet sees nothing)",
    loadBridgeResume("0x0000000000000000000000000000000000009999") === null
  );

  // Corrupt / expired entries fail closed.
  fakeStorage.setItem(
    `flarehq:external-bridge:resume:${WALLET.toLowerCase()}`,
    "{not-json"
  );
  ok("corrupt entry loads as null", loadBridgeResume(WALLET) === null);
  saveBridgeResume({
    intentReference: REF,
    sourceChainId: "Base_Sepolia",
    sourceWallet: WALLET,
    burnTxHash: null,
    updatedAt: Date.now() - BRIDGE_RESUME_TTL_MS - 1_000,
  });
  ok("expired entry loads as null", loadBridgeResume(WALLET) === null);

  saveBridgeResume({
    intentReference: REF,
    sourceChainId: "Base_Sepolia",
    sourceWallet: WALLET,
    burnTxHash: null,
  });
  clearBridgeResume(WALLET);
  ok("clear removes the resume", loadBridgeResume(WALLET) === null);

  // Burn-hash extraction (step-name variants).
  ok(
    "extractBurnTxHash finds runtime 'burn'",
    extractBurnTxHash({ steps: [{ name: "burn", txHash: BURN }] }) === BURN
  );
  ok(
    "extractBurnTxHash finds documented 'depositForBurn' alias",
    extractBurnTxHash({ steps: [{ name: "depositForBurn", txHash: BURN }] }) === BURN
  );
  ok(
    "extractBurnTxHash null when no burn step",
    extractBurnTxHash({ steps: [{ name: "approve", txHash: BURN }] }) === null &&
      extractBurnTxHash({}) === null &&
      extractBurnTxHash(null) === null
  );

  // ── 2. Pre-signing preflight ─────────────────────────────────────────────
  const ARB_SEPOLIA = 421614;
  ok("minimum gas floor is 0.0005 native", MIN_NATIVE_WEI === 500_000_000_000_000n);
  ok("ARB Sepolia native symbol is ETH", nativeSymbolForChainId(ARB_SEPOLIA) === "ETH");
  ok("Polygon Amoy native symbol is POL", nativeSymbolForChainId(80002) === "POL");
  ok("floor formats as 0.0005", formatNativeWei(MIN_NATIVE_WEI) === "0.0005");

  // The Arbitrum Sepolia case from the diagnostic: gas-starved wallet.
  const gasStarved = checkBridgePreflight({
    nativeBalanceWei: 100_000_000_000_000n, // 0.0001 ETH < 0.0005 floor
    usdcBalanceUnits: 10_000_000n,
    amountUnits: 10_000_000n,
    sourceLabel: "Arbitrum Sepolia",
    sourceChainId: ARB_SEPOLIA,
  });
  ok(
    "preflight blocks a gas-insufficient wallet before signing",
    gasStarved.ok === false && (gasStarved as any).kind === "INSUFFICIENT_GAS",
    JSON.stringify(gasStarved)
  );
  ok(
    "gas error names asset, chain, and minimum",
    !gasStarved.ok &&
      (gasStarved as any).error ===
        "Insufficient ETH for gas on Arbitrum Sepolia — you need at least 0.0005 ETH to submit the bridge transactions.",
    !gasStarved.ok ? (gasStarved as any).error : ""
  );

  const usdcShort = checkBridgePreflight({
    nativeBalanceWei: 5_000_000_000_000_000n,
    usdcBalanceUnits: 1_000_000n, // 1 USDC
    amountUnits: 10_000_000n, // wants 10
    sourceLabel: "Arbitrum Sepolia",
    sourceChainId: ARB_SEPOLIA,
  });
  ok(
    "preflight blocks a USDC-insufficient wallet before signing",
    usdcShort.ok === false && (usdcShort as any).kind === "INSUFFICIENT_USDC",
    JSON.stringify(usdcShort)
  );

  ok(
    "preflight passes a funded wallet",
    checkBridgePreflight({
      nativeBalanceWei: MIN_NATIVE_WEI,
      usdcBalanceUnits: 10_000_000n,
      amountUnits: 10_000_000n,
      sourceLabel: "Arbitrum Sepolia",
      sourceChainId: ARB_SEPOLIA,
    }).ok === true
  );
  ok(
    "preflight fails open on unreadable balances (wallet stays backstop)",
    checkBridgePreflight({
      nativeBalanceWei: null,
      usdcBalanceUnits: null,
      amountUnits: 10_000_000n,
      sourceLabel: "Arbitrum Sepolia",
      sourceChainId: ARB_SEPOLIA,
    }).ok === true
  );

  // ── 3. Static wiring guards ──────────────────────────────────────────────
  const here = fileURLToPath(import.meta.url).replaceAll("\\", "/");
  const ui = readFileSync(new URL("../src/components/bridge/ExternalBridge.tsx", `file://${here}`), "utf8");
  ok("UI persists resume (saveBridgeResume)", ui.includes("saveBridgeResume"));
  ok("UI rehydrates resume on mount (loadBridgeResume)", ui.includes("loadBridgeResume"));
  ok("UI clears resume on receipt/start-over (clearBridgeResume)", ui.includes("clearBridgeResume"));
  ok("UI extracts burn hash for persistence (extractBurnTxHash)", ui.includes("extractBurnTxHash"));
  ok("UI runs gas+USDC preflight (checkBridgePreflight)", ui.includes("checkBridgePreflight"));
  ok(
    "preflight runs BEFORE kit.bridge()",
    ui.indexOf("checkBridgePreflight") < ui.indexOf(".bridge({"),
    "preflight must block before signing"
  );
  ok(
    "persist-before-signing (intent saved before wallet prompts)",
    ui.indexOf("saveBridgeResume") < ui.indexOf(".bridge({"),
    "a close during signing prompts must still resume"
  );
  ok("single kit.bridge call site preserved", (ui.match(/\.bridge\(\{/g) ?? []).length === 1);
  ok("kit.retry resume path preserved", ui.includes("kit.retry("));
  ok("resumeOnly guard preserved", ui.includes("resumeOnly"));
  ok("rehydrated entries resume server-side (waitForMintViaServer)", ui.includes("waitForMintViaServer"));
  ok(
    "rehydrated burn counts as moved (no unsafe start-over)",
    ui.includes("resumeRef.current?.burnTxHash")
  );
  ok(
    "gas error copy passes through unmapped",
    ui.includes("for gas on") && ui.includes("you need at least")
  );

  console.log(`\nbridge-reliability-tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("FATAL", e?.message ?? e);
  process.exit(1);
});
