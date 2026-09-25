// scripts/bridge-user-controlled-e2e.mjs
//
// REAL (testnet) verification of the ExternalBridge runBridgeFlow fix:
// BridgeKit user-controlled adapters auto-resolve the source address from
// the connected wallet — an explicit `address` in the `from` context throws
// "Address should not be provided for user-controlled adapters…"
// (CONNECTION_FAILED.code.bridge). This harness replicates the component's
// kit.bridge() call 1:1 with a real EIP-1193 provider backed by a real key
// (browser-wallet equivalent, headless), so the signature request itself is
// real and broadcast to the live Arbitrum Sepolia RPC.
//
//   --negative-control   run ONCE with the OLD buggy shape (address present)
//                        — must reproduce the exact production error, then exit.
//
// Modes without the flag run the FIXED shape. Funding preflight prints
// precise instructions if the source wallet lacks gas/USDC — nothing can
// move without gas, so every run here is fund-safe by construction.
//
// Usage: node scripts/bridge-user-controlled-e2e.mjs [--negative-control]
import 'dotenv/config';
import { createPublicClient, http, formatUnits, parseUnits } from 'viem';
import { ethers } from 'ethers';
import { BridgeKit } from '@circle-fin/bridge-kit';
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import { ArbitrumSepolia } from '@circle-fin/bridge-kit/chains';

const NEGATIVE_CONTROL = process.argv.includes('--negative-control');
const ARB_RPC = 'https://arbitrum-sepolia-rpc.publicnode.com';
const ARB_CHAIN_ID_HEX = '0x66eee'; // 421614 (Arbitrum Sepolia)
const SOURCE_CHAIN = 'Arbitrum_Sepolia'; // production path: sourceChains.ts id
const SOURCE_CHAIN_LABEL = 'Arbitrum Sepolia';
const AMOUNT = '1'; // tiny, matches repo "tiny amounts" rule
const USDC = ArbitrumSepolia.usdcAddress;

const source = new ethers.Wallet((process.env.ESCROW_ADMIN_PRIVATE_KEY ?? '').trim());
if (!/^0x[0-9a-fA-F]{64}$/.test(process.env.ESCROW_ADMIN_PRIVATE_KEY ?? '')) {
  console.error('FATAL: ESCROW_ADMIN_PRIVATE_KEY missing/malformed');
  process.exit(1);
}
const destination = (process.env.SELLER_ADDRESS ?? '').trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(destination)) {
  console.error('FATAL: SELLER_ADDRESS missing/malformed');
  process.exit(1);
}

// ── EIP-1193 provider shim over a REAL ethers signer ────────────────────────
// Browser-wallet equivalent: same JSON-RPC surface MetaMask exposes, real
// signatures, real broadcasts to the live RPC. No UI — the "prompt" is the
// eth_sendTransaction/eth_signTypedData_v4 request itself.
function eip1193FromEthers(signer, rpcUrl) {
  const rpc = new ethers.JsonRpcProvider(rpcUrl);
  const send = async ({ method, params = [] }) => {
    switch (method) {
      case 'eth_chainId':
        return ARB_CHAIN_ID_HEX;
      case 'net_version':
        return '421614';
      case 'eth_accounts':
      case 'eth_requestAccounts':
        return [signer.address];
      case 'eth_sendTransaction': {
        const tx = params[0] ?? {};
        // EVIDENCE: this is the wallet-signature request itself.
        console.log(`[wallet] SIGNATURE REQUESTED eth_sendTransaction to=${tx.to} data=${String(tx.data).slice(0, 20)}…`);
        const populated = {
          to: tx.to,
          value: tx.value ?? 0n,
          data: tx.data ?? '0x',
          ...(tx.gas != null ? { gasLimit: tx.gas } : {}),
          ...(tx.maxFeePerGas != null
            ? { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 0n }
            : tx.gasPrice != null
              ? { gasPrice: tx.gasPrice }
              : {}),
          ...(tx.nonce != null ? { nonce: tx.nonce } : {}),
          ...(tx.chainId != null ? { chainId: tx.chainId } : {}),
        };
        try {
          const sent = await signer.connect(rpc).sendTransaction(populated);
          return sent.hash;
        } catch (err) {
          // When the ONLY blocker is funds, the broadcast still reached the
          // live RPC and the wallet produced a real signature — surface it.
          const info = err?.info ?? {};
          const rawSigned = typeof info.transaction === 'string' ? info.transaction : (typeof info.raw === 'string' ? info.raw : null);
          if (rawSigned) {
            try {
              const t = ethers.Transaction.from(rawSigned);
              console.log(`[evidence] wallet SIGNED the approve tx (signature captured):`);
              console.log(`[evidence]   signedTxHash: ${t.hash}`);
              console.log(`[evidence]   signature r/s/v: ${t.signature?.r} / ${t.signature?.s} / ${t.signature?.v ?? t.signature?.yParity}`);
              console.log(`[evidence]   recovered signer: ${t.from}`);
              console.log(`[evidence]   broadcast reject: ${String(info.error?.message ?? err?.message ?? '').slice(0, 200)}`);
            } catch {}
          }
          throw err;
        }
      }
      case 'eth_signTypedData_v4': {
        const [, typedDataJson] = params;
        const typed = typeof typedDataJson === 'string' ? JSON.parse(typedDataJson) : typedDataJson;
        const { EIP712Domain, ...types } = typed.types ?? {};
        return signer.signTypedData(typed.domain ?? {}, types, typed.message ?? {});
      }
      case 'personal_sign': {
        const [msg] = params;
        const bytes = typeof msg === 'string' && msg.startsWith('0x')
          ? ethers.getBytes(msg)
          : ethers.toUtf8Bytes(String(msg ?? ''));
        return signer.signMessage(bytes);
      }
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain':
        return null; // single-chain shim; the adapter switches chains itself
      default:
        throw new Error(`bridge-e2e shim: unsupported method ${method}`);
    }
  };
  // viem's custom transport calls provider.request(...)
  return { request: send };
}
// __PART2__

// ── Funding preflight (read-only) ────────────────────────────────────────────
async function preflight() {
  const client = createPublicClient({ transport: http(ARB_RPC, { timeout: 20000, retryCount: 2 }) });
  const [native, usdcRaw] = await Promise.all([
    client.getBalance({ address: source.address }),
    client.readContract({
      address: USDC,
      abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
      functionName: 'balanceOf',
      args: [source.address],
    }).catch(() => 0n),
  ]);
  const nativeEth = Number(formatUnits(native, 18));
  const usdcHuman = Number(formatUnits(usdcRaw, 6));
  console.log(`[preflight] source ${source.address}`);
  console.log(`[preflight] ${SOURCE_CHAIN_LABEL} native=${nativeEth.toFixed(6)} USDC=${usdcHuman.toFixed(6)}`);
  if (usdcRaw < parseUnits(AMOUNT, 6)) {
    console.error(`[preflight] BLOCKED: need >= ${AMOUNT} USDC on ${SOURCE_CHAIN_LABEL} for ${source.address}`);
    process.exit(1);
  }
  if (native < 1_000_000_000_000_000n) {
    console.error(
      `[preflight] NOTICE: source wallet has ~no ${SOURCE_CHAIN_LABEL} gas for ${source.address}.\n` +
      `  The run can still prove how far the flow proceeds (nothing can move without gas),\n` +
      `  but a MINED signature needs gas: fund any small amount of ${SOURCE_CHAIN_LABEL} native\n` +
      `  (chain 421614) to ${source.address} and re-run.`
    );
  }
  return { native, usdcRaw };
}

async function main() {
  console.log(`[run] mode=${NEGATIVE_CONTROL ? 'NEGATIVE-CONTROL (old buggy shape with address)' : 'FIXED (shipped shape, no address)'}`);
  console.log(`[run] bridge ${AMOUNT} USDC ${SOURCE_CHAIN} -> Arc_Testnet, recipient (forwarder) ${destination}`);
  const { native } = await preflight();

  const provider = eip1193FromEthers(source, ARB_RPC);
  const adapter = await createViemAdapterFromProvider({ provider });
  const kit = new BridgeKit();

  // Prove the user-controlled adapter resolves the address from the
  // connected wallet by itself (this is the behavior the fix relies on).
  const resolved = await adapter.getAddress(ArbitrumSepolia);
  console.log(`[adapter] auto-resolved source address: ${resolved}`);
  if (resolved.toLowerCase() !== source.address.toLowerCase()) {
    console.error('[adapter] MISMATCH between adapter-resolved address and signer — aborting');
    process.exit(1);
  }

  // EXACTLY the component's shape (ExternalBridge.tsx runBridgeFlow):
  //   from: { adapter, chain: source.id [, address: sessionLower] }  // OLD had address
  //   to:   { chain: 'Arc_Testnet', recipientAddress: destination, useForwarder: true }
  //   amount
  const fromCtx = NEGATIVE_CONTROL
    ? { adapter, chain: SOURCE_CHAIN, address: source.address } // OLD (production bug)
    : { adapter, chain: SOURCE_CHAIN }; // FIXED

  console.log('[kit.bridge] calling…');
  try {
    const result = await Promise.race([
      kit.bridge({
        from: fromCtx,
        to: { chain: 'Arc_Testnet', recipientAddress: destination, useForwarder: true },
        amount: AMOUNT,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('e2e: overall timeout (5 min)')), 300_000)),
    ]);
    console.log('[kit.bridge] returned');
    console.log(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    const steps = result?.steps ?? [];
    for (const s of steps) console.log(`[step] ${s?.name} -> ${s?.state} ${s?.txHash ?? ''}`);
    if (!NEGATIVE_CONTROL) {
      const approve = steps.find((s) => (s?.name ?? '').toLowerCase().includes('approve'));
      if (approve?.state === 'success' && approve?.txHash) {
        console.log('[CONFIRMED] approve SIGNATURE REQUESTED AND MINED — the signing step proceeded past the address error.');
      } else if (approve?.txHash) {
        console.log('[CONFIRMED] approve signature REQUESTED (wallet signed; tx broadcast submitted) — signing step proceeded.');
      } else {
        console.log('[RESULT] no approve signature yet; inspect the result above.');
      }
    }
  } catch (e) {
    console.log('[kit.bridge] THREW');
    console.log(JSON.stringify({
      name: e?.name ?? null,
      code: e?.code ?? null,
      type: e?.type ?? null,
      shortMessage: e?.shortMessage ?? null,
      message: String(e?.message ?? e).slice(0, 500),
    }, null, 2));
    const msg = String(e?.message ?? e);
    if (msg.includes('Address should not be provided for user-controlled adapters')) {
      if (NEGATIVE_CONTROL) {
        console.log('[CONFIRMED-NEGATIVE-CONTROL] exact production error reproduced with the old shape — diagnosis proven.');
        process.exit(3);
      }
      console.error('[FAIL] the production address error is STILL present with the fixed shape');
      process.exit(2);
    }
    if (!NEGATIVE_CONTROL) {
      if (e?.type === 'BALANCE' || /INSUFFICIENT_GAS|INSUFFICIENT_TOKEN|INSUFFICIENT_ALLOWANCE/i.test(msg)) {
        console.log('[PROCEEDED] address error gone; kit.bridge advanced to the funding/allowance pre-flight ' +
          '(source wallet has no gas — fund it per the preflight notice to reach the mined signature).');
        process.exit(1);
      }
      if (/shim: unsupported method/.test(msg)) {
        console.log('[GAP] flow reached a wallet method the shim lacks — extend the shim and re-run.');
        process.exit(1);
      }
      // Any error AFTER address resolution (e.g. broadcast rejection for no
      // gas) still proves the flow advanced past the original failure point.
      console.log(`[PROCEEDED] address error gone; flow advanced and threw at a LATER stage: ${e?.name ?? ''} ${e?.code ?? ''}`);
      process.exit(1);
    }
    throw e;
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('[e2e] unexpected failure:', e);
  process.exit(1);
});