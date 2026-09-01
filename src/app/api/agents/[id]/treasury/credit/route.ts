// src/app/api/agents/[id]/treasury/credit/route.ts
// POST — fund an agent's treasury with real USDC.
//
// Why this exists: the procurement hire gate (evaluatePolicyForSpend) checks
// the hiring agent's LEDGER treasury (revenue - costs from AgentLedgerEntry),
// not just the on-chain wallet. A freshly provisioned agent has treasury 0, so
// hire fails with "insufficient available balance" even when the merchant has
// USDC. This endpoint closes that gap truthfully:
//
//   merchant Circle wallet -> real USDC -> agent Circle wallet
//   -> ADJUSTMENT CREDIT ledger entry (measured received delta)
//   -> treasury gate passes -> the later on-chain fund() also passes
//
// SECURITY: both wallets are derived SERVER-SIDE from authenticated identities.
// The request body carries ONLY { amountUSDC } — never a source/destination
// wallet id or address. Source = the authenticated merchant's own Circle wallet;
// destination = the agent's Circle wallet (must resolve to agent.scaAddress,
// fail-closed, same pattern as the accept/fund routes). The caller must control
// the agent (merchant owns it).
//
// The ledger entry uses type ADJUSTMENT (not REVENUE) deliberately — a treasury
// top-up is liquidity, not earned revenue, so it must never inflate the agent's
// trust/reputation signals.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { withApiKeyOrAnySession, resolveMerchant } from '@/lib/middleware/withMerchantAuth';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { getCircleClient } from '@/lib/circle/client';
import { transferUsdc } from '@/lib/circle/transfers';
import { recordLedgerEntry } from '@/lib/ledger/ledgerService';
import { computeTreasuryView } from '@/lib/ledger/treasuryService';
import { createPublicClient, http, erc20Abi } from 'viem';
import { arcTestnet } from 'viem/chains';

const USDC_ARC = '0x3600000000000000000000000000000000000000';
const AMOUNT_RE = /^\d+(\.\d{1,6})?$/;

async function readUsdcBalance(owner: string): Promise<bigint> {
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network') });
  return (await publicClient.readContract({
    address: USDC_ARC as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner as `0x${string}`],
  })) as bigint;
}

async function postHandler(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const agentId = Number(id);
  if (!Number.isInteger(agentId) || agentId <= 0) {
    return NextResponse.json({ error: 'invalid agent id' }, { status: 400 });
  }

  // Amount from the body — the ONLY thing the caller may supply.
  const body = await req.json().catch(() => ({}));
  const amountInput = body.amountUSDC;
  if (amountInput === undefined || amountInput === null || amountInput === '') {
    return NextResponse.json({ error: 'amountUSDC is required, e.g. { "amountUSDC": "5.00" }' }, { status: 400 });
  }
  const amountStr = String(amountInput).trim();
  if (!AMOUNT_RE.test(amountStr) || Number(amountStr) <= 0) {
    return NextResponse.json({ error: 'invalid amountUSDC — use a positive number with up to 6 decimals' }, { status: 400 });
  }

  // Auth: the caller must be a merchant who owns this agent.
  const merchant = await resolveMerchant(req).catch(() => null);
  if (!merchant?.id) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }
  const merchantRecord = await (prisma as any).merchant.findUnique({ where: { id: merchant.id } });
  if (!merchantRecord) {
    return NextResponse.json({ error: 'Merchant not found.' }, { status: 401 });
  }

  const agent = await (prisma as any).agentRegistry.findUnique({ where: { id: agentId } });
  if (!agent) return NextResponse.json({ error: 'agent not found' }, { status: 404 });
  const actor = await verifyCallerControlsAddress(req, agent.scaAddress ?? '');
  if (!actor) return NextResponse.json({ error: 'You do not control this agent.' }, { status: 403 });

  // Source wallet — the merchant's own Circle wallet. Never caller-supplied.
  if (merchantRecord.walletProvider !== 'CIRCLE' || !merchantRecord.circleWalletId || !merchantRecord.walletAddress) {
    return NextResponse.json(
      { error: 'Treasury funding requires the merchant to hold a Circle wallet (this merchant does not).' },
      { status: 400 }
    );
  }
  const sourceWalletId: string = merchantRecord.circleWalletId;
  const sourceAddress: string = merchantRecord.walletAddress;

  // Destination wallet — the agent's Circle wallet, must resolve to scaAddress.
  if (!agent.circleWalletId || !agent.scaAddress) {
    return NextResponse.json({ error: 'agent has no Circle wallet to receive funds' }, { status: 400 });
  }
  const circleClient = getCircleClient();
  let destAddress: string;
  try {
    const w = await circleClient.getWallet({ id: agent.circleWalletId });
    destAddress = w.data?.wallet?.address as string;
    if (!destAddress) throw new Error('no address');
  } catch {
    return NextResponse.json({ error: 'agent Circle wallet not resolvable' }, { status: 400 });
  }
  if (destAddress.toLowerCase() !== agent.scaAddress.toLowerCase()) {
    return NextResponse.json({ error: 'agent Circle wallet does not match agent scaAddress' }, { status: 403 });
  }

  // Preflight: the merchant wallet must actually hold the USDC.
  let sourceBalance = 0n;
  try {
    sourceBalance = await readUsdcBalance(sourceAddress);
  } catch (e: any) {
    return NextResponse.json({ error: `could not read source USDC balance: ${e.message}` }, { status: 502 });
  }
  const amountWei = BigInt(Math.round(parseFloat(amountStr) * 1_000_000));
  if (sourceBalance < amountWei) {
    return NextResponse.json(
      { error: `Insufficient USDC in merchant wallet ${sourceAddress.slice(0, 10)}…: has ${(Number(sourceBalance) / 1e6).toFixed(4)}, needs ${amountStr}.` },
      { status: 400 }
    );
  }

  // Measure the destination's actual received delta (the Arc network applies a
  // per-transfer fee on top of the amount, so the ledger records what truly
  // arrived — never assume).
  let destBefore = 0n;
  try {
    destBefore = await readUsdcBalance(destAddress);
  } catch {}

  let arcTxHash: string;
  try {
    const result = await transferUsdc({
      walletId: sourceWalletId,
      walletAddress: sourceAddress,
      destinationAddress: destAddress,
      amount: amountStr,
    });
    arcTxHash = result.arcTxHash;
  } catch (e: any) {
    return NextResponse.json({ error: `transfer failed: ${e.message}` }, { status: 500 });
  }

  let receivedWei = amountWei;
  try {
    const destAfter = await readUsdcBalance(destAddress);
    const delta = destAfter - destBefore;
    if (delta > 0n) receivedWei = delta;
  } catch {
    // RPC hiccup — fall back to the nominal amount; the transfer itself already
    // succeeded, so failing the whole request here would leave money moved but
    // no ledger record. Record nominal and note it.
  }

  // Ledger: ADJUSTMENT CREDIT deduped by txHash (idempotent retry-safe).
  await recordLedgerEntry({
    agentRegistryId: agentId,
    type: 'ADJUSTMENT',
    amount: receivedWei,
    token: 'USDC',
    direction: 'CREDIT',
    txHash: arcTxHash,
    description: `treasury fund top-up ${amountStr} USDC from merchant wallet`,
    metadata: { requested: amountStr, sourceWalletId, purpose: 'treasury-fund' },
  });

  const treasury = await computeTreasuryView(agentId);
  return NextResponse.json({
    success: true,
    agentId,
    requested: amountStr,
    receivedUsdc: (Number(receivedWei) / 1e6).toFixed(6),
    txHash: arcTxHash,
    treasury,
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiKeyOrAnySession((inner: NextRequest) => postHandler(inner, ctx))(req);
}
