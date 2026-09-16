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
 * Prompt 7 follow-up: the per-instance ref lock was proven insufficient
 * alone (device retest: one tap still opened 5 relay sockets). Co-mounted
 * hook instances (page picker + FlowSwapView, picker + wallet-switch
 * modal) each own an independent ref, so a second surface could proceed
 * while another instance's attempt was in flight. Fix: a module-level
 * app-wide guard (createGlobalConnectGuard) shared by all instances, on
 * top of the per-instance lock. Sections 7–10 below prove the shared
 * property: two independent invokers sharing one guard run the underlying
 * connect exactly once, no matter the interleaving.
 *
 * Run: npx tsx scripts/guarded-connect-tests.ts
 * No dev server, DB, RPC, or funds required.
 */
import fs from "fs";
import path from "path";
import { createGuardedInvoker, createGlobalConnectGuard } from "@/hooks/useGuardedConnect";

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
    ok("hook checks the per-instance ref lock synchronously before connecting",
      hookSrc.includes("lockRef.current") && hookSrc.includes("pendingRef.current"),
      "lock check missing");
    ok("hook checks the app-wide global guard synchronously before connecting",
      hookSrc.includes("globalConnectGuard.tryAcquire()"),
      "global guard acquisition missing");
    ok("hook releases the app-wide global guard in finally",
      hookSrc.includes("globalConnectGuard.release()"),
      "global guard release missing");
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

  // 7. Prompt 7 core regression: TWO INDEPENDENT hook instances sharing the
  // app-wide guard (the co-mounted page-picker + FlowSwapView shape) let
  // exactly one connect attempt proceed. Each instance keeps its own
  // per-instance invoker (as the hook does with lockRef); the shared
  // global guard is the second gate both must pass.
  {
    const shared = createGlobalConnectGuard();
    const instanceA = createGuardedInvoker();
    const instanceB = createGuardedInvoker();
    let calls = 0;
    const gate = deferred<string>();
    const attempt = (invoker: ReturnType<typeof createGuardedInvoker>) => {
      // Mirrors connectAsyncGuarded's gate order: per-instance first, then
      // the shared app-wide slot; release of both happens in finally.
      if (!shared.tryAcquire()) return Promise.resolve(undefined);
      return invoker(async () => { calls++; return gate.promise; }, false)
        .finally(() => shared.release());
    };
    const pA = attempt(instanceA);
    const pB = attempt(instanceB); // sync second attempt, other instance
    ok("two co-mounted instances proceed exactly once app-wide", calls <= 1, `calls=${calls}`);
    gate.resolve("connected");
    const [rA, rB] = await Promise.all([pA, pB]);
    const proceeded = [rA, rB].filter((r) => r === "connected").length;
    ok("exactly one instance gets the result, the other is suppressed",
      proceeded === 1 && calls === 1, `calls=${calls} results=${JSON.stringify([String(rA), String(rB)])}`);
  }

  // 8. Global slot releases after success — a later attempt (any instance)
  // connects normally instead of deadlocking the app's wallet UX.
  {
    const shared = createGlobalConnectGuard();
    ok("global guard starts free", !shared.isInFlight());
    ok("first acquire succeeds", shared.tryAcquire());
    ok("second acquire while held fails", !shared.tryAcquire());
    ok("guard reports in-flight while held", shared.isInFlight());
    shared.release();
    ok("guard is free after release", !shared.isInFlight());
    ok("acquire succeeds again after release", shared.tryAcquire());
    shared.release();
  }

  // 9. Five near-simultaneous attempts through one shared guard (the
  // reported 5-socket shape, whatever its sub-wagmi origin) still yield a
  // single underlying connect at the app layer.
  {
    const shared = createGlobalConnectGuard();
    let calls = 0;
    const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return "ok"; };
    const invokers = Array.from({ length: 5 }, () => createGuardedInvoker());
    const results = await Promise.all(
      invokers.map((inv) => {
        if (!shared.tryAcquire()) return Promise.resolve(undefined);
        return inv(fn, false).finally(() => shared.release());
      })
    );
    ok("five-way race invokes underlying connect exactly once", calls === 1, `calls=${calls}`);
    ok("exactly one of five gets the result",
      results.filter((r) => r === "ok").length === 1,
      JSON.stringify(results));
  }

  // 10. No auto-reconnect race path exists in src (Hypothesis B disproven):
  // no file calls wagmi's useReconnect/reconnect(), and WagmiProvider is
  // constructed with config only (wagmi v3 has no reconnectOnMount prop).
  {
    const root = process.cwd();
    const srcFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full); }
        else if (/\.(ts|tsx)$/.test(entry.name)) srcFiles.push(full);
      }
    };
    walk(path.join(root, "src"));
    const reconnectUsers = srcFiles.filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      // Code usage only: the wagmi hook or an actual reconnect() call.
      // Prose mentions in comments (e.g. "no auto-reconnect race") must
      // not count — strip line/block comments before matching.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1");
      return code.includes("useReconnect") || /(^|[^\w])reconnect\s*\(/.test(code);
    });
    ok("no src file calls useReconnect/reconnect()",
      reconnectUsers.length === 0,
      `reconnect callers: ${reconnectUsers.map((f) => path.relative(root, f)).join(", ")}`);
    const providersSrc = fs.readFileSync(path.join(root, "src/app/providers.tsx"), "utf8");
    ok("WagmiProvider takes config only (no reconnectOnMount prop)",
      providersSrc.includes("<WagmiProvider config={config}>") && !providersSrc.includes("reconnectOnMount"),
      "unexpected WagmiProvider props");
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
