// src/app/api/escrow/create/route.ts
// REAL onchain escrow — actually calls ArcFlareEscrow.sol
// Previously only wrote to DB. Now approves + deposits USDC into contract.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/middleware/withApiKey';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { parseUnits } from 'viem';

const ESCROW_CONTRACT = process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS || '';
const USDC_ARC = '0x3600000000000000000000000000000000000000';

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
}

async function waitForCircleTx(
  client: ReturnType<typeof getCircleClient>,
  txId: string
): Promise<string> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await client.getTransaction({ id: txId });
    const state = data?.transaction?.state;
    if (state === 'COMPLETE' && data.transaction?.txHash) {
      return data.transaction.txHash;
    }
    if (state === 'FAILED') {
      throw new Error(`Escrow transaction failed onchain.`);
    }
    console.log(`⏳ Escrow tx polling... attempt ${i + 1}`);
  }
  throw new Error('Escrow transaction timed out.');
}

async function createEscrowHandler(request: Request) {
  try {
    const {
      depositorSCA, // Depositor Circle SCA wallet address
      depositorWalletId, // Circle wallet ID of depositor (for signing)
      beneficiarySCA, // Beneficiary SCA address
      amount, // USDC amount e.g. "5.00"
      deadlineHours = 24,
      condition,
      webhookUrl,
    } = await request.json();

    if (!depositorSCA || !depositorWalletId || !beneficiarySCA || !amount) {
      return NextResponse.json(
        {
          success: false,
          error: 'depositorSCA, depositorWalletId, beneficiarySCA and amount are required.',
          hint: 'depositorWalletId is the Circle wallet UUID — get it from GET /api/agent/status',
        },
        { status: 400 }
      );
    }

    const amountFloat = parseFloat(amount);
    const amountWei = parseUnits(amountFloat.toFixed(6), 6);
    const deadlineTimestamp = Math.floor(Date.now() / 1000) + deadlineHours * 3600;
    const reference = `escrow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const deadlineDate = new Date(Date.now() + deadlineHours * 3600 * 1000);

    console.log(`🔒 Creating escrow: ${amount} USDC`);
    console.log(`   Depositor: ${depositorSCA}`);
    console.log(`   Beneficiary: ${beneficiarySCA}`);
    console.log(`   Deadline: ${deadlineDate.toISOString()}`);

    const circleClient = getCircleClient();

    // ── Step 1: Approve escrow contract to spend USDC ────────────────────────
    console.log('⏳ Step 1/2: Approving USDC for escrow contract...');

    const approveTx = await circleClient.createContractExecutionTransaction({
      walletAddress: depositorSCA,
      blockchain: 'ARC-TESTNET' as any,
      contractAddress: USDC_ARC,
      abiFunctionSignature: 'approve(address,uint256)',
      abiParameters: [ESCROW_CONTRACT, amountWei.toString()],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    if (!approveTx.data?.id) throw new Error('Approval tx returned no ID.');
    await waitForCircleTx(circleClient, approveTx.data.id);
    console.log('✅ USDC approval confirmed');

    // ── Step 2: Create escrow on ArcFlareEscrow.sol ──────────────────────────
    console.log('⏳ Step 2/2: Creating escrow on Arc...');

    const escrowTx = await circleClient.createContractExecutionTransaction({
      walletAddress: depositorSCA,
      blockchain: 'ARC-TESTNET' as any,
      contractAddress: ESCROW_CONTRACT,
      abiFunctionSignature: 'createEscrow(address,uint256,uint256,string)',
      abiParameters: [
        beneficiarySCA,
        amountWei.toString(),
        deadlineTimestamp.toString(),
        condition || 'No condition set',
      ],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    if (!escrowTx.data?.id) throw new Error('Escrow tx returned no ID.');
    const txHash = await waitForCircleTx(circleClient, escrowTx.data.id);
    console.log(`✅ Escrow created on Arc. TxHash: ${txHash}`);

    // ── Step 3: Save to Postgres ─────────────────────────────────────────────
    const escrowRecord = await prisma.escrow.create({
      data: {
        reference,
        amount: amountFloat,
        currency: 'USDC',
        depositorSCA,
        beneficiarySCA,
        contractAddress: ESCROW_CONTRACT,
        status: 'ACTIVE',
        condition: condition || null,
        deadline: deadlineDate,
        txHash,
        webhookUrl: webhookUrl || null,
      },
    });

    // ── Step 4: Fire webhook ─────────────────────────────────────────────────
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'escrow.created',
          reference,
          depositorSCA,
          beneficiarySCA,
          amount: amountFloat,
          currency: 'USDC',
          condition: condition || null,
          deadline: deadlineDate.toISOString(),
          txHash,
          explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
          createdAt: new Date().toISOString(),
        }),
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      escrow: escrowRecord,
      txHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      contractAddress: ESCROW_CONTRACT,
      message: `${amount} USDC locked in ArcFlareEscrow contract on Arc Testnet. Both parties must confirm to release.`,
      nextSteps: {
        release: `POST /api/escrow/release { reference: "${reference}", callerSCA: "depositorOrBeneficiarySCA" }`,
        dispute: `POST /api/escrow/dispute { reference: "${reference}", callerSCA: "...", reason: "..." }`,
        status: `GET /api/escrow/status?reference=${reference}`,
      },
    });
  } catch (error: any) {
    console.error('❌ Escrow create error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message,
        hint:
          error.message.includes('balance') || error.message.includes('insufficient')
            ? 'The depositor SCA wallet needs USDC. Fund at https://faucet.circle.com — select ARC-TESTNET.'
            : undefined,
      },
      { status: 500 }
    );
  }
}

export const POST = withApiKey(createEscrowHandler);
