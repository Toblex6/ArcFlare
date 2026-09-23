// scripts/verify-unitflow-mainnet-bytecode.mjs
//
// Live bytecode check for the supplied Arc Mainnet UnitFlow V3 family.
// Reads eth_getCode for each of the 9 supplied addresses via an Arc Mainnet
// JSON-RPC endpoint and reports code present (0x… non-empty) vs absent.
//
// Configuration/integration stage only: NO signing, NO broadcasting, NO
// funds move — eth_getCode is a read-only eth_call-family RPC.
//
// Usage:
//   node scripts/verify-unitflow-mainnet-bytecode.mjs [--network mainnet|testnet]
//   ARC_MAINNET_RPC_URL=https://... node scripts/verify-unitflow-mainnet-bytecode.mjs
//
// RPC selection: --network mainnet (default) tries ARC_MAINNET_RPC_URL then
// the documented public mainnet endpoints (permissioned — may 401/refuse
// without credentials from your Circle point of contact). --network testnet
// checks the pinned testnet family against the public testnet RPC as a
// control that this script works.
//
// Exit 0 only when EVERY address has bytecode. Any missing/unreachable RPC
// exits non-zero with a fail-closed message (configuration NOT valid).

const MAINNET_FAMILY = {
  UnitFlowV3Factory: '0x5bfBCeb73d39F722B1cB83fD2F11736b28c1Be6d',
  UnitFlowInterfaceMulticall: '0xc9E1780bA34698C1067EA6B2fcF78f111a5F110b',
  TickLens: '0x20Df732207340234E490a1e686A3A8055AF59b4e',
  NFTDescriptor: '0x9Ca8e324380Aa2E80011A16C4d684366E47d4Ab4',
  NonfungibleTokenPositionDescriptor: '0x5Bc0735F5D806C184EDE0A7731632F7c491B3B02',
  UnitFlowV3PositionManager: '0x300F5f2861eF0d9D3c6B812797C0A4c8b15C86a8',
  UnitFlowV3Router: '0x6fD8351b9596C1F0b2f2479BfA6A171cb3d0f410',
  Quoter: '0x5AF6E89F0960Ff375AF84d9911D8153ef6240E34',
  V3Migrator: '0x36E9b24b9CF39c4C7069B75f01FA0419547F977a',
};

const TESTNET_FAMILY = {
  Factory: '0xAb6A8AAb7d490007634ef59d424b5d89688a1971',
  Quoter: '0x121aeB6DEf00F6F67665008CaC1C19805886ed1a',
  UniversalRouter: '0xEaF3195bE51861632cd32850973C9515DA48e76F',
  Permit2: '0x4ce562F687d0Ced27b79Ba51d79B63BD978F7F48',
  WUSDC: '0x911b4000D3422F482F4062a913885f7b035382Df',
};

const MAINNET_RPCS = [
  process.env.ARC_MAINNET_RPC_URL,
  'https://rpc.mainnet.arc.io',
  'https://rpc.blockdaemon.mainnet.arc.io',
  'https://rpc.drpc.mainnet.arc.io',
  'https://rpc.quicknode.mainnet.arc.io',
].filter(Boolean);

const TESTNET_RPCS = [
  process.env.ARC_TESTNET_RPC,
  'https://rpc.testnet.arc.network',
  'https://rpc.testnet.arc.io',
].filter(Boolean);

async function getCode(rpc, address) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC error: ${JSON.stringify(body.error).slice(0, 160)}`);
  return body.result;
}

async function main() {
  const network = (process.argv.find((a) => a.startsWith('--network=')) ?? '').split('=')[1] ?? 'mainnet';
  const family = network === 'testnet' ? TESTNET_FAMILY : MAINNET_FAMILY;
  const rpcs = network === 'testnet' ? TESTNET_RPCS : MAINNET_RPCS;
  console.log(`[verify-bytecode] network=${network} addresses=${Object.keys(family).length} rpcs=${rpcs.length}`);
  let rpc = null;
  let chainId = null;
  const errors = [];
  for (const candidate of rpcs) {
    try {
      const res = await fetch(candidate, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(`RPC error: ${JSON.stringify(body.error).slice(0, 120)}`);
      rpc = candidate;
      chainId = body.result;
      break;
    } catch (e) {
      errors.push(`${candidate}: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }
  if (!rpc) {
    console.error('[verify-bytecode] NO REACHABLE RPC — configuration NOT valid (fail-closed).');
    for (const e of errors) console.error(`  rpc failed: ${e}`);
    process.exit(2);
  }
  console.log(`[verify-bytecode] rpc=${rpc} chainId=${chainId}`);
  let pass = 0;
  let fail = 0;
  for (const [label, address] of Object.entries(family)) {
    try {
      const code = await getCode(rpc, address);
      const bytes = code && code !== '0x' ? (code.length - 2) / 2 : 0;
      if (bytes > 0) {
        pass++;
        console.log(`  ✅ ${label} ${address} bytecode=${bytes} bytes`);
      } else {
        fail++;
        console.log(`  ❌ ${label} ${address} NO BYTECODE (EOA or undeployed)`);
      }
    } catch (e) {
      fail++;
      console.log(`  ❌ ${label} ${address} check failed: ${String(e?.message ?? e).slice(0, 140)}`);
    }
  }
  console.log(`[verify-bytecode] PASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) {
    console.error('[verify-bytecode] configuration NOT valid (fail-closed) — missing bytecode above.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[verify-bytecode] threw: ${String(e?.message ?? e).slice(0, 200)}`);
  process.exit(2);
});
