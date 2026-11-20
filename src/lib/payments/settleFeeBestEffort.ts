// Shared 25 bps checkout platform-fee collection. The customer payment is
// already settled before this runs; fee failures never roll it back.

import { createPublicClient, erc20Abi, http } from 'viem';
import { prisma } from '@/lib/prisma';
import { getArcChain, getNetworkConfig } from '@/lib/config/network';
import { settlePlatformFeeOnce, prismaPlatformFeeStore, circleFeePorts, type FeeDecision } from './platformFee';

export interface FeeToken { symbol: 'USDC' | 'EURC'; address: string; decimals: number }

async function readTokenBalance(owner: string, tokenAddress: string): Promise<bigint> {
  const cfg = getNetworkConfig();
  const pc = createPublicClient({ chain: getArcChain(), transport: http(cfg.primaryRpc) });
  return await pc.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [owner as `0x${string}`] }) as bigint;
}

export async function settleFeeBestEffort(payment: any, token: FeeToken): Promise<void> {
  try {
    const feeBps = parseInt(process.env.PLATFORM_FEE_BPS ?? '25', 10);
    const unitsPerToken = 10 ** token.decimals;
    const feeAmount = Math.round((payment.amount * feeBps / 10000) * unitsPerToken) / unitsPerToken;
    const sellerAddress = process.env.SELLER_ADDRESS as string | undefined;
    const merchantRow: any = payment.merchantId ? await (prisma as any).merchant.findUnique({ where: { id: payment.merchantId } }) : null;
    const merchantId = payment.merchantId || merchantRow?.id || 'unknown';
    let decision: FeeDecision;
    if (!merchantRow || merchantRow.walletProvider !== 'CIRCLE' || !merchantRow.circleWalletId) decision = { kind: 'defer', reason: 'non-Circle wallet, cannot auto-debit' };
    else if (feeAmount === 0) decision = { kind: 'defer', reason: 'fee rounds to zero' };
    else if (!sellerAddress) decision = { kind: 'defer', reason: 'fee collector address not configured' };
    else {
      let balance: bigint | null = null;
      try { balance = await readTokenBalance(merchantRow.walletAddress, token.address); } catch {}
      const feeWei = BigInt(Math.round(feeAmount * unitsPerToken));
      decision = balance !== null && balance < feeWei
        ? { kind: 'defer', reason: 'insufficient balance' }
        : { kind: 'collect', walletId: merchantRow.circleWalletId, walletAddress: merchantRow.walletAddress, destinationAddress: sellerAddress, amountStr: feeAmount.toFixed(token.decimals).replace(/\.?0+$/, ''), tokenAddress: token.address, decimals: token.decimals };
    }
    let sellerBefore = 0n;
    if (decision.kind === 'collect' && sellerAddress) try { sellerBefore = await readTokenBalance(sellerAddress, token.address); } catch {}
    await settlePlatformFeeOnce({
      store: prismaPlatformFeeStore(),
      ports: circleFeePorts(async () => {
        if (!sellerAddress) return null;
        try { const delta = await readTokenBalance(sellerAddress, token.address) - sellerBefore; return delta > 0n ? Number(delta) / unitsPerToken : null; } catch { return null; }
      }),
      paymentLogId: payment.id,
      merchantId,
      amountCharged: feeAmount,
      decision,
    });
  } catch (e: any) {
    console.error('Platform fee debit error:', e?.message ?? e);
  }
}
