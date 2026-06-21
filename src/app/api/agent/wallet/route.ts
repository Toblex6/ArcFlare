// src/app/api/agent/wallet/route.ts
// Circle Agent Wallets — permissionless, policy-controlled wallets from
// Circle's Agent Stack. This is distinct from your existing Developer-
// Controlled Wallets used in /api/agent/deploy.
//
// Use this when you want agents to have spending GUARDRAILS baked in —
// e.g. a max daily spend, an allowlist of contracts they can call,
// or a per-transaction cap — enforced by Circle, not by your own code.
//
// Requires Circle CLI installed in your deploy environment, or calling
// Circle's Agent Wallets REST endpoints directly (shown below using
// plain fetch so it works from any Next.js route without a CLI dependency).

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/middleware/withApiKey';

const CIRCLE_API_BASE = 'https://api.circle.com/v1/w3s';

function circleHeaders() {
  return {
    Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

// ── POST /api/agent/wallet — create a policy-controlled Agent Wallet ─────────
async function createAgentWalletHandler(request: Request) {
  try {
    const {
      agentName,
      dailySpendLimitUSDC, // e.g. "10.00" — max USDC the agent can spend per day
      allowedContracts, // e.g. ["0x24DAB3...", "0xc9BbeD..."] — contract allowlist
    } = await request.json();

    if (!agentName) {
      return NextResponse.json(
        { success: false, error: 'agentName is required.' },
        { status: 400 }
      );
    }

    // ── Step 1: Create the Agent Wallet on Arc Testnet ──────────────────────
    const createRes = await fetch(`${CIRCLE_API_BASE}/agent-wallets`, {
      method: 'POST',
      headers: circleHeaders(),
      body: JSON.stringify({
        chain: 'ARC-TESTNET',
        accountType: 'SCA',
        metadata: { name: agentName, source: 'arcflare' },
      }),
    });

    const walletData = await createRes.json();

    if (!createRes.ok) {
      throw new Error(walletData.message || 'Failed to create Agent Wallet.');
    }

    const walletAddress = walletData.data?.address;
    const walletId = walletData.data?.id;

    // ── Step 2: Attach a spending policy if limits were provided ────────────
    let policyApplied = null;

    if (dailySpendLimitUSDC || allowedContracts) {
      const policyRes = await fetch(`${CIRCLE_API_BASE}/agent-wallets/${walletId}/policy`, {
        method: 'POST',
        headers: circleHeaders(),
        body: JSON.stringify({
          rules: {
            ...(dailySpendLimitUSDC && {
              dailySpendLimit: { token: 'USDC', amount: dailySpendLimitUSDC },
            }),
            ...(allowedContracts && {
              contractAllowlist: allowedContracts,
            }),
          },
        }),
      });

      policyApplied = await policyRes.json();
    }

    // ── Step 3: Save reference in ArcFlare's own registry ───────────────────
    await (prisma as any).agentRegistry
      .create({
        data: {
          name: agentName,
          tokenId: `agentwallet_${walletId}`, // not an ERC-8004 token — distinct namespace
          scaAddress: walletAddress,
          circleWalletId: walletId,
          ownerNode: 'circle-agent-stack',
          status: 'ACTIVE_AGENT_WALLET',
        },
      })
      .catch(() => {});

    return NextResponse.json({
      success: true,
      agentWallet: {
        name: agentName,
        address: walletAddress,
        walletId,
        chain: 'ARC-TESTNET',
      },
      policy: policyApplied
        ? {
            dailySpendLimitUSDC: dailySpendLimitUSDC || null,
            allowedContracts: allowedContracts || null,
          }
        : null,
      message: `Agent Wallet created on Arc Testnet${policyApplied ? ' with spending policy applied' : ''}.`,
    });
  } catch (error: any) {
    console.error('❌ Agent Wallet creation error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(createAgentWalletHandler);

// ── GET /api/agent/wallet?address=0x... — check wallet + policy + balance ────
async function getAgentWalletHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const address = searchParams.get('address');
    const walletId = searchParams.get('walletId');

    if (!address && !walletId) {
      return NextResponse.json(
        { success: false, error: 'address or walletId query param required.' },
        { status: 400 }
      );
    }

    const lookupId = walletId || address;

    const [walletRes, balanceRes] = await Promise.all([
      fetch(`${CIRCLE_API_BASE}/agent-wallets/${lookupId}`, { headers: circleHeaders() }),
      fetch(`${CIRCLE_API_BASE}/agent-wallets/${lookupId}/balances`, { headers: circleHeaders() }),
    ]);

    const wallet = await walletRes.json();
    const balances = await balanceRes.json();

    return NextResponse.json({
      success: true,
      wallet: wallet.data,
      balances: balances.data,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const GET = withApiKey(getAgentWalletHandler);
