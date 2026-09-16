/**
 * guarded-connect-tests.ts — regression tests for the WalletConnect
 * double-fire race fix (src/hooks/useGuardedConnect.ts).
 *
 * Bug: every wallet-connect call site guarded re-entry with React state
 * only. A second tap before re-render fired connectAsync() again, opening
 * a second WalletConnect pairing session (two relay websockets) and leaving
 * the modal stuck with a greyed-out "Open" button.
 *
 * Fix: a synchronous ref lock checked+set in the same tick, released in
 * `finally`. The lock primitive (createGuardedInvoker) is pure and tested
 * behaviorally here; a static sweep then proves every call site routes
 * through the hook and no raw useConnect() connect path remains.
 *
 * Run: npx tsx scripts/guarded-connect-tests.ts
 * No dev server, DB, RPC, or funds required.
 */
import fs from "fs";
import path from "path";
import { createGuardedInvoker } from "@/hooks/useGuardedConnect";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

async function main() {
  console.log("=== guarded-connect tests ===");

  // 1. Core regression: two synchronous invocations (no await between
  // calls — exactly the double-tap shape) run the underlying connect once.
  {
    const invoke = createGuardedInvoker();
    let calls = 0;
    const gate = deferred<string>();
    const fn = () => { calls++; return gate.promise; };
    const p1 = invoke(fn, false);
    const p2 = invoke(fn, false); // sync second call, no await between
    ok("double-invocation invokes underlying connect exactly once", calls === 1, `calls=${calls}`);
    gate.resolve("connected");
    const [r1, r2] = await Promise.all([p1, p2]);
    ok("first call resolves with the connect result", r1 === "connected", `r1=${String(r1)}`);
    ok("suppressed second call resolves undefined (no second session)", r2 === undefined, `r2=${String(r2)}`);
  }

  // 2. Triple-fire: still exactly one session.
  {
    const invoke = createGuardedInvoker();
    let calls = 0;
    const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return "ok"; };
    const results = await Promise.all([invoke(fn, false), invoke(fn, false), invoke(fn, false)]);
    ok("triple-fire invokes underlying connect exactly once", calls === 1, `calls=${calls}`);
    ok(
      "exactly one caller gets the result, others get undefined",
      results.filter((r) => r === "ok").length === 1 && results.filter((r) => r === undefined).length === 2,
      JSON.stringify(results)
    );
  }

  // 3. Lock releases after success — a later retry connects normally.
  {
    const invoke = createGuardedInvoker();
    let calls = 0;
    const fn = async () => { calls++; return calls; };
    const first = await invoke(fn, false);
    const second = await invoke(fn, false);
    ok("lock releases after success (sequential retry works)", first === 1 && second === 2 && calls === 2,
      `first=${String(first)} second=${String(second)} calls=${calls}`);
  }

  // 4. Lock releases after failure — errors propagate and don't deadlock.
  {
    const invoke = createGuardedInvoker();
    let calls = 0;
    const fail = async (): Promise<string> => { calls++; throw new Error("user rejected"); };
    let threw: unknown = null;
    try { await invoke(fail, false); } catch (e) { threw = e; }
    ok("connect failure propagates to the caller", (threw as Error)?.message === "user rejected",
      `threw=${String((threw as Error)?.message)}`);
    const retry = await invoke(async () => { calls++; return "recovered"; }, false);
    ok("lock releases after failure (retry after reject works)", retry === "recovered" && calls === 2,
      `retry=${String(retry)} calls=${calls}`);
  }

  // 5. wagmi's own pending flag also suppresses (stale-closure / cross-tick).
  {
    const invoke = createGuardedInvoker();
    let calls = 0;
    const r = await invoke(async () => { calls++; return "x"; }, true);
    ok("isPending=true suppresses the call", r === undefined && calls === 0, `r=${String(r)} calls=${calls}`);
  }

  // 6. Static sweep: all six call sites route through useGuardedConnect,
  // and no component/page calls wagmi's raw useConnect() anymore.
  {
    const root = process.cwd();
    const guardedSites = [
      "src/components/WalletConnectPanel.tsx",
      "src/components/CheckoutWidget.tsx",
      "src/app/consumer/page.tsx",
      "src/components/swap/FlowSwapView.tsx",
      "src/app/escrow-pay/[reference]/page.tsx",
      "src/app/escrow-confirm/[reference]/page.tsx",
    ];
    for (const rel of guardedSites) {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      ok(`${rel} uses useGuardedConnect`, src.includes("useGuardedConnect"),
        "hook not referenced");
      ok(`${rel} no longer calls raw useConnect()`, !src.includes("useConnect()"),
        "raw useConnect() still present");
      ok(`${rel} no longer calls raw connectAsync({ connector`, !src.includes("connectAsync({ connector"),
        "raw connectAsync({ connector… }) still present");
    }
    const hookSrc = fs.readFileSync(path.join(root, "src/hooks/useGuardedConnect.ts"), "utf8");
    ok("hook checks the ref lock synchronously before connecting",
      hookSrc.includes("if (lockRef.current || pendingRef.current) return undefined"),
      "lock check missing");
    ok("hook sets the ref lock synchronously before connectAsync",
      hookSrc.includes("lockRef.current = true"),
      "lock set missing");
    ok("hook releases the ref lock in finally",
      hookSrc.includes("finally") && hookSrc.includes("lockRef.current = false"),
      "lock release missing");
    ok("hook preserves the 45s withTimeout deadline",
      hookSrc.includes("withTimeout") && hookSrc.includes("Wallet connection timed out"),
      "timeout behavior missing");
    ok("hook preserves friendlyWalletError mapping",
      hookSrc.includes("friendlyWalletError"),
      "error mapping missing");
    ok("hook memoizes dedupeConnectors on connectors identity",
      hookSrc.includes("useMemo(() => dedupeConnectors"),
      "memoized dedupe missing");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failures:", failures.join("; "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("guarded-connect tests crashed:", e);
  process.exit(1);
});
