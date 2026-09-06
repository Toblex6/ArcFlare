// src/lib/circle/transfers.ts
// Moving USDC OUT of a Circle Developer-Controlled Wallet — the exact
// pattern used by the settlement engine's Path B
// (src/app/api/payments/settle/route.ts: native createTransaction first,
// ERC-20 transfer(address,uint256) contract-execution fallback, then the
// same 40x2.5s Circle transaction poll). The Telegram /withdraw flow
// reuses this; do not invent a different transfer mechanism.

import { parseUnits } from 'viem';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

const USDC_ARC = '0x3600000000000000000000000000000000000000';

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

export async function transferUsdc({
  walletId,
  walletAddress,
  destinationAddress,
  amount,
  tokenAddress = USDC_ARC,
  decimals = 6,
}: TransferUsdcParams): Promise<{ arcTxHash: string; circleTxId: string }> {
  const client = getCircleClient();
  let circleTxId: string | undefined;

  try {
    const transferTx = await client.createTransaction({
      walletId,
      blockchain: 'ARC-TESTNET' as any,
      tokenAddress,
      destinationAddress,
      amounts: [amount],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    } as any);
    circleTxId = transferTx.data?.id;
  } catch (nativeInitError: any) {
    console.warn('Native Circle transfer initialization failed, trying fallback:', nativeInitError.message);
  }

  if (!circleTxId) {
    try {
      const contractTx = await client.createContractExecutionTransaction({
        walletAddress,
        blockchain: 'ARC-TESTNET',
        contractAddress: tokenAddress,
        abiFunctionSignature: 'transfer(address,uint256)',
        abiParameters: [destinationAddress, parseUnits(amount, decimals).toString()],
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      });
      circleTxId = contractTx.data?.id;
      if (!circleTxId)
        throw new Error('Fallback ERC-20 transfer failed to generate a Transaction ID.');
    } catch (fallbackError: any) {
      throw new Error(`Both native and fallback initialization failed. Error: ${fallbackError.message}`);
    }
  }

  const arcTxHash = await waitForCircleTx(client, circleTxId!);
  return { arcTxHash, circleTxId };
}