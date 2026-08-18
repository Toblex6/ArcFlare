// src/instrumentation.ts
//
// Runs once on every Next.js server start (nodejs runtime), before the server
// handles requests. Fail-closed environment validation: a wallet address with
// no matching private key (or a key that derives a different address) is a
// startup error, not a runtime surprise.
//
// See src/lib/env/walletEnvCheck.ts for the rules.

export async function register() {
  const { assertWalletEnv } = await import("@/lib/env/walletEnvCheck");
  assertWalletEnv();
}
