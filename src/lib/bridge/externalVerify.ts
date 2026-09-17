// src/lib/bridge/externalVerify.ts
//
// SERVER-ONLY verification for EXTERNAL (browser-signed) bridges.
//
// The browser wallet signs the source-chain approve/burn via Circle
// BridgeKit; the server never signs and never broadcasts. These helpers
// prove, from authoritative on-chain receipts, that:
//
//   burn   (verifyExternalBurn):
//     1. the burn tx mined SUCCESSFULLY on the expected source chain,
//     2. it was sent FROM the session's EXTERNAL wallet (no arbitrary hash),
//     3. canonical source-chain USDC debited that wallet for EXACTLY the
//        intent amount (Transfer sum, bigint compare — no floats),
//     4. (best-effort strict) when the receipt carries a decodable CCTP V2
//        DepositForBurn from the known TokenMessenger, its amount,
//        destination domain (Arc), and mint recipient must match the intent
//        exactly — otherwise fail closed. When the event is absent or
//        undecodable the burn still counts as transfer-verified but
//        destinationBound=false, and completion still requires the
//        destination-credit proof below (so a burn paying someone else can
//        never be recorded as this intent's success).
//   mint   (verifyArcMint):
//     1. the mint tx mined SUCCESSFULLY on Arc,
//     2. canonical Arc USDC credited the server-resolved destination
//        (Transfer to destination, amount > 0 — the recorded actual).
//
// Expected failures return { ok: false, reason } (mapped to friendly UI
// copy by callers); only programmer/config errors throw. RPC reads retry
// with backoff — source Sepolia/Amoy endpoints are flaky.

import { createPublicClient, http, decodeEventLog, pad, type Hex } from 'viem';
import { getNetworkConfig, getRpcUrls } from '@/lib/config/network';
import {
  getBridgeSourceChain,
  type BridgeSourceChain,
} from '@/lib/bridge/sourceChains';
import { sourceViemChainFor } from '@/lib/bridge/sourceViemChains';
// TokenMessenger addresses are BridgeKit's own deployment facts (same
// package the browser flow bridges through), not invented constants.
import {
  ArbitrumSepolia,
  BaseSepolia,
  OptimismSepolia,
  EthereumSepolia,
  PolygonAmoy,
} from '@circle-fin/bridge-kit/chains';

const ERC20_TRANSFER_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

// CCTP V2 DepositForBurn (same shape as V1: only nonce indexed). If Circle
// changes the indexing, decode throws and the caller falls back to
// transfer-verified + destinationBound=false — never a false binding.
const DEPOSIT_FOR_BURN_ABI = [
  {
    type: 'event',
    name: 'DepositForBurn',
    inputs: [
      { name: 'nonce', type: 'uint64', indexed: true },
      { name: 'burnToken', type: 'address', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'depositor', type: 'address', indexed: false },
      { name: 'mintRecipient', type: 'bytes32', indexed: false },
      { name: 'destinationDomain', type: 'uint32', indexed: false },
      { name: 'destinationTokenMessenger', type: 'address', indexed: false },
      { name: 'destinationCaller', type: 'bytes32', indexed: false },
    ],
  },
] as const;

function tokenMessengerV2(sourceId: string): string | null {
  const defs: Record<string, any> = {
    Arbitrum_Sepolia: ArbitrumSepolia,
    Base_Sepolia: BaseSepolia,
    Optimism_Sepolia: OptimismSepolia,
    Ethereum_Sepolia: EthereumSepolia,
    Polygon_Amoy_Testnet: PolygonAmoy,
  };
  const def = defs[sourceId];
  const addr = def?.cctp?.contracts?.v2?.tokenMessenger;
  return typeof addr === 'string' && addr ? addr : null;
}

async function withRpcRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  console.error(`[external-bridge-verify] ${label} failed after ${attempts} attempts:`, last);
  throw last;
}

function sourceClient(source: BridgeSourceChain) {
  const chain = sourceViemChainFor(source.chainId);
  if (!chain) throw new Error(`No viem chain for source ${source.id}`);
  return createPublicClient({ chain, transport: http() });
}

export type BurnVerifyFailure =
  | 'NOT_FOUND'
  | 'NOT_MINED'
  | 'REVERTED'
  | 'WRONG_SENDER'
  | 'AMOUNT_MISMATCH'
  | 'BINDING_MISMATCH'
  | 'RPC_UNAVAILABLE';

export interface BurnVerifyOk {
  ok: true;
  /** True when DepositForBurn provably names this destination+domain. */
  destinationBound: boolean;
  burnTxHash: Hex;
}

export async function verifyExternalBurn(params: {
  sourceId: string;
  sourceAddress: string;
  amountBaseUnits: bigint;
  destination: string;
  burnTxHash: string;
}): Promise<BurnVerifyOk | { ok: false; reason: BurnVerifyFailure; detail?: string }> {
  const { sourceId, sourceAddress, amountBaseUnits, destination, burnTxHash } = params;
  const source = getBridgeSourceChain(sourceId);
  if (!source) return { ok: false, reason: 'BINDING_MISMATCH', detail: 'Unknown source chain.' };
  if (!/^0x[0-9a-fA-F]{64}$/.test(burnTxHash)) {
    return { ok: false, reason: 'NOT_FOUND', detail: 'Not a transaction hash.' };
  }
  const hash = burnTxHash as Hex;
  const expectedFrom = sourceAddress.toLowerCase();
  const usdc = source.usdcAddress.toLowerCase();

  let receipt: any;
  try {
    const client = sourceClient(source);
    receipt = await withRpcRetry('source receipt', () =>
      client.getTransactionReceipt({ hash })
    );
  } catch {
    return { ok: false, reason: 'RPC_UNAVAILABLE', detail: 'Source chain RPC did not respond.' };
  }
  if (!receipt) return { ok: false, reason: 'NOT_MINED', detail: 'Transaction not found on the source chain.' };
  if (receipt.status !== 'success') {
    return { ok: false, reason: 'REVERTED', detail: 'Source transaction reverted on-chain.' };
  }

  // Prove the sender: fetch the transaction and compare `from`.
  try {
    const client = sourceClient(source);
    const tx = await withRpcRetry('source transaction', () => client.getTransaction({ hash }));
    if (!tx || (tx.from as string).toLowerCase() !== expectedFrom) {
      return { ok: false, reason: 'WRONG_SENDER', detail: 'Transaction was not sent by the connected wallet.' };
    }
  } catch {
    return { ok: false, reason: 'RPC_UNAVAILABLE', detail: 'Source chain RPC did not respond.' };
  }

  // Canonical-USDC debit proof: sum Transfer(from == source) on the source
  // USDC contract inside THIS receipt. Must equal the intent amount exactly.
  let debited = 0n;
  for (const log of receipt.logs ?? []) {
    if ((log.address as string).toLowerCase() !== usdc) continue;
    try {
      const decoded = decodeEventLog({
        abi: ERC20_TRANSFER_ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== 'Transfer') continue;
      const { from, value } = decoded.args as unknown as { from: string; value: bigint };
      if (from.toLowerCase() === expectedFrom) debited += BigInt(value);
    } catch {
      // Non-Transfer logs on the USDC contract — ignore.
    }
  }
  if (debited !== amountBaseUnits) {
    return {
      ok: false,
      reason: 'AMOUNT_MISMATCH',
      detail: `Source USDC debit (${debited}) does not equal the bridge amount (${amountBaseUnits}).`,
    };
  }

  // Best-effort strict binding: DepositForBurn from the known TokenMessenger.
  const messenger = tokenMessengerV2(sourceId);
  if (messenger) {
    for (const log of receipt.logs ?? []) {
      if ((log.address as string).toLowerCase() !== messenger.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: DEPOSIT_FOR_BURN_ABI,
          data: log.data as Hex,
          topics: log.topics as [Hex, ...Hex[]],
        });
        if (decoded.eventName !== 'DepositForBurn') continue;
        const args = decoded.args as unknown as {
          amount: bigint;
          depositor: string;
          mintRecipient: string;
          destinationDomain: number;
        };
        const net = getNetworkConfig();
        const expectedRecipient = pad(destination as Hex, { size: 32 }).toLowerCase();
        if (
          BigInt(args.amount) === amountBaseUnits &&
          (args.depositor as string).toLowerCase() === expectedFrom &&
          (args.mintRecipient as string).toLowerCase() === expectedRecipient &&
          Number(args.destinationDomain) === net.cctpDomain
        ) {
          return { ok: true, destinationBound: true, burnTxHash: hash };
        }
        // A decodable DepositForBurn that names a different amount/
        // depositor/recipient/domain is proof AGAINST this intent.
        return { ok: false, reason: 'BINDING_MISMATCH', detail: 'Burn receipt names a different recipient, amount, or destination domain.' };
      } catch {
        // Undecodable with this ABI shape — keep scanning / fall through.
      }
    }
  }

  return { ok: true, destinationBound: false, burnTxHash: hash };
}

export type MintVerifyFailure =
  | 'NOT_FOUND'
  | 'REVERTED'
  | 'NO_DESTINATION_CREDIT'
  | 'RPC_UNAVAILABLE';

export interface MintVerifyOk {
  ok: true;
  actualAmount: bigint;
  mintTxHash: Hex;
}

export async function verifyArcMint(params: {
  destination: string;
  mintTxHash: string;
}): Promise<MintVerifyOk | { ok: false; reason: MintVerifyFailure; detail?: string }> {
  const { destination, mintTxHash } = params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(mintTxHash)) {
    return { ok: false, reason: 'NOT_FOUND', detail: 'Not a transaction hash.' };
  }
  const hash = mintTxHash as Hex;
  const cfg = getNetworkConfig();
  const usdc = cfg.usdcAddress.toLowerCase();
  const dest = destination.toLowerCase();
  const urls = getRpcUrls();
  const arcChain = {
    id: cfg.chainId,
    name: cfg.name === 'mainnet' ? 'Arc' : 'Arc Testnet',
    nativeCurrency: { name: 'ARC', symbol: 'ARC', decimals: 18 },
    rpcUrls: { default: { http: urls } },
  } as const;

  let receipt: any = null;
  let lastErr: unknown = null;
  for (const url of urls.slice(0, 3)) {
    try {
      const client = createPublicClient({ chain: arcChain, transport: http(url, { timeout: 15_000 }) });
      receipt = await client.getTransactionReceipt({ hash });
      if (receipt) break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!receipt) {
    console.error('[external-bridge-verify] arc receipt unavailable:', lastErr);
    return { ok: false, reason: 'RPC_UNAVAILABLE', detail: 'Arc RPC did not respond.' };
  }
  if (receipt.status !== 'success') {
    return { ok: false, reason: 'REVERTED', detail: 'Destination transaction reverted on-chain.' };
  }

  let credited = 0n;
  for (const log of receipt.logs ?? []) {
    if ((log.address as string).toLowerCase() !== usdc) continue;
    try {
      const decoded = decodeEventLog({
        abi: ERC20_TRANSFER_ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== 'Transfer') continue;
      const { to, value } = decoded.args as unknown as { to: string; value: bigint };
      if (to.toLowerCase() === dest) credited += BigInt(value);
    } catch {
      // ignore non-Transfer logs
    }
  }
  if (credited <= 0n) {
    return { ok: false, reason: 'NO_DESTINATION_CREDIT', detail: 'No USDC credit to the destination in this transaction.' };
  }
  return { ok: true, actualAmount: credited, mintTxHash: hash };
}
