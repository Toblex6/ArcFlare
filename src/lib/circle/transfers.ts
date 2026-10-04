// src/lib/circle/transfers.ts
// Moving USDC OUT of a Circle Developer-Controlled Wallet — the exact
// pattern used by the settlement engine's Path B
// (src/app/api/payments/settle/route.ts: native createTransaction first,
// ERC-20 transfer(address,uint256) contract-execution fallback, then the
// same 40x2.5s Circle transaction poll). The Telegram /withdraw flow
// reuses this; do not invent a different transfer mechanism.

import { parseUnits } from 'viem';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { getNetworkConfig } from '@/lib/config/network';

// Default transfer token flows from the authoritative network config (was a
// hardcoded testnet USDC literal). Explicit per-call tokenAddress still wins.
// Resolved lazily per call below so mainnet fail-closed happens at call time,
// never at import.
function defaultTokenAddress(): string {
  return getNetworkConfig().usdcAddress;
}

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
}

async function waitForCircleTx(client: any, txId: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await client.getTransaction({ id: txId });
    if (data?.transaction?.state === 'COMPLETE' && data.transaction.txHash)
      return data.transaction.txHash;
    if (data?.transaction?.state === 'FAILED')
      throw new Error(`Circle tx failed: ${data.transaction.errorReason}`);
  }
  throw new Error('Circle transaction timed out.');
}

export interface TransferUsdcParams {
  walletId: string; // Circle wallet id that signs (source)
  walletAddress: string; // on-chain address of that wallet (fallback path signs by address)
  destinationAddress: string;
  amount: string; // decimal token string, e.g. "0.01"
  // Phase 2A multicurrency: optional canonical token identity. Defaults to
  // USDC so every existing caller (Telegram /withdraw, USDC fee debits) is
  // byte-for-byte unchanged. Pass the invoice's resolved token
  // (address + decimals from resolveRowCurrency) to move EURC instead — the
  // caller, never SwapPool, decides the asset, and no conversion happens.
  tokenAddress?: string;
  decimals?: number;
  idempotencyKey?: string; // accepted for callers' accounting; NOT forwarded —
  // Circle's ARC-TESTNET endpoint rejects the idempotencyKey parameter
  // ("API parameter invalid", verified 2026-08-19). Double-withdrawal
  // protection therefore rests on the caller's atomic DB claim (Telegram
  // intents: PENDING→EXECUTING updateMany), which the idempotency key was
  // only ever a belt-and-suspenders layer on top of.
}

export interface CircleTransferInit {
  walletId: string;
  walletAddress: string;
  destinationAddress: string;
  amount: string;
  tokenAddress?: string;
  decimals?: number;
  /**
   * Stable caller-side idempotency key (fee path: `platform-fee:<paymentLogId>`).
   * Forwarded to Circle's createTransaction when the endpoint accepts it; when
   * the endpoint rejects the parameter (verified 2026-08-19 on ARC-TESTNET:
   * "API parameter invalid") creation is retried ONCE without it. Rejection
   * happens before any transfer exists, so the retry cannot double-send.
   */
  idempotencyKey?: string;
}

function isIdempotencyRejection(e: any): boolean {
  const msg = String(e?.message ?? e ?? '');
  return /idempotency/i.test(msg) && /invalid|unknown|unexpected|not (supported|allowed)/i.test(msg);
}

/**
 * Initiate a Circle transfer and return its transaction id WITHOUT waiting
 * for finality. The caller must persist circleTxId BEFORE polling (crash
 * anchor) — see src/lib/payments/platformFee.ts. Throws when neither the
 * native nor the ERC-20 fallback route yields an id.
 */
export async function createCircleTransfer(init: CircleTransferInit): Promise<{ circleTxId: string }> {
  const tokenAddress = init.tokenAddress ?? defaultTokenAddress();
  const decimals = init.decimals ?? 6;
  const client = getCircleClient();
  let circleTxId: string | undefined;

  const nativeArgs = (withKey: boolean) =>
    ({
      walletId: init.walletId,
      blockchain: getNetworkConfig().circleBlockchain as any,
      tokenAddress,
      destinationAddress: init.destinationAddress,
      amounts: [init.amount],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      ...(withKey && init.idempotencyKey ? { idempotencyKey: init.idempotencyKey } : {}),
    }) as any;

  try {
    try {
      const transferTx = await client.createTransaction(nativeArgs(true));
      circleTxId = transferTx.data?.id;
    } catch (nativeInitError: any) {
      if (init.idempotencyKey && isIdempotencyRejection(nativeInitError)) {
        console.warn('Circle rejected idempotencyKey param — retrying creation without it.');
        const transferTx = await client.createTransaction(nativeArgs(false));
        circleTxId = transferTx.data?.id;
      } else {
        throw nativeInitError;
      }
    }
  } catch (nativeInitError: any) {
    console.warn('Native Circle transfer initialization failed, trying fallback:', nativeInitError.message);
  }

  if (!circleTxId) {
    try {
      const contractTx = await client.createContractExecutionTransaction({
        walletAddress: init.walletAddress,
        blockchain: getNetworkConfig().circleBlockchain,
        contractAddress: tokenAddress,
        abiFunctionSignature: 'transfer(address,uint256)',
        abiParameters: [init.destinationAddress, parseUnits(init.amount, decimals).toString()],
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      });
      circleTxId = contractTx.data?.id;
      if (!circleTxId)
        throw new Error('Fallback ERC-20 transfer failed to generate a Transaction ID.');
    } catch (fallbackError: any) {
      throw new Error(`Both native and fallback initialization failed. Error: ${fallbackError.message}`);
    }
  }

  return { circleTxId: circleTxId! };
}

/** Poll a created Circle transfer to finality (same 40x2.5s semantics). */
export async function awaitCircleTx(circleTxId: string): Promise<string> {
  return waitForCircleTx(getCircleClient(), circleTxId);
}

export async function transferUsdc({
  walletId,
  walletAddress,
  destinationAddress,
  amount,
  tokenAddress,
  decimals = 6,
  idempotencyKey,
}: TransferUsdcParams): Promise<{ arcTxHash: string; circleTxId: string }> {
  const { circleTxId } = await createCircleTransfer({
    walletId,
    walletAddress,
    destinationAddress,
    amount,
    tokenAddress,
    decimals,
    idempotencyKey,
  });
  const arcTxHash = await awaitCircleTx(circleTxId);
  return { arcTxHash, circleTxId };
}