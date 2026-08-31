// src/app/api/payments/stream/withdraw/route.ts
//
// SECURITY FIX: previously had NO party-membership check at all (didn't even
// verify receiverSCA matched stream.receiverSCA) and no ownership
// verification — any caller with a valid internal API key could withdraw
// from any stream by naming any receiverSCA. Both fixed below.

import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/middleware/withApiKey';
import { resolveWalletProvider } from '@/lib/wallet/resolve';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { queueExternalSignatureRequest } from '@/lib/wallet/signatureQueue';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { createPublicClient, http } from 'viem';

const STREAM_CONTRACT = process.env.ARCFLARE_STREAM_CONTRACT_ADDRESS || '';

const arcTestnet = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.arc.network'] },
    public: { http: ['https://rpc.testnet.arc.network'] },
  },
} as const;

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http('https://rpc.testnet.arc.network'),
});

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
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await client.getTransaction({ id: txId });
    if (data?.transaction?.state === 'COMPLETE' && data.transaction.txHash) {
      return data.transaction.txHash;
    }
    if (data?.transaction?.state === 'FAILED') {
      throw new Error('Withdraw transaction failed onchain.');
    }
  }
  throw new Error('Withdraw transaction timed out.');
}

// ── Same streamId extraction logic as stop route ──────────────────────────────
async function getStreamIdFromReceipt(txHash: string): Promise<`0x${string}`> {
  console.log(`🔍 Fetching receipt for tx: ${txHash}`);

  const receipt = await publicClient.getTransactionReceipt({
    hash: txHash as `0x${string}`,
  });

  console.log(`📋 Receipt has ${receipt.logs.length} logs`);

  receipt.logs.forEach((log, i) => {
    console.log(`Log ${i}: address=${log.address}, topics=${JSON.stringify(log.topics)}`);
  });

  const contractAddress = STREAM_CONTRACT.toLowerCase();

  // First try: match by contract address + 4 topics
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contractAddress) continue;
    if (log.topics.length !== 4) continue;
    const streamId = log.topics[1] as `0x${string}`;
    console.log(`✅ Found streamId: ${streamId}`);
    return streamId;
  }

  // Fallback: any log with 4 topics
  for (const log of receipt.logs) {
    if (log.topics.length === 4) {
      const streamId = log.topics[1] as `0x${string}`;
      console.log(`⚠️ Fallback streamId: ${streamId}`);
      return streamId;
    }
  }

  throw new Error(
    `Could not find StreamCreated event in tx ${txHash}. ` +
      `Contract: ${STREAM_CONTRACT}. Logs: ${receipt.logs.length}.`
  );
}

async function withdrawHandler(request: NextRequest) {
  try {
    const { reference, receiverSCA } = await request.json();

    if (!reference || !receiverSCA) {
      return NextResponse.json(
        { success: false, error: 'reference and receiverSCA are required.' },
        { status: 400 }
      );
    }

    if (!STREAM_CONTRACT) {
      return NextResponse.json(
        { success: false, error: 'ARCFLARE_STREAM_CONTRACT_ADDRESS not set.' },
        { status: 500 }
      );
    }

    const stream = await prisma.stream.findUnique({ where: { reference } });
    if (!stream) {
      return NextResponse.json({ success: false, error: 'Stream not found.' }, { status: 404 });
    }
    if (stream.status !== 'ACTIVE') {
      return NextResponse.json(
        { success: false, error: `Stream is ${stream.status}.` },
        { status: 400 }
      );
    }
    if (!stream.txHash) {
      return NextResponse.json({ success: false, error: 'Stream has no txHash.' }, { status: 400 });
    }

    // ── Membership check — was completely missing before ───────────────────
    if (receiverSCA.toLowerCase() !== stream.receiverSCA.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: 'receiverSCA is not the receiver of this stream.' },
        { status: 403 }
      );
    }

    // ── Ownership check — proves the caller actually controls receiverSCA ──
    const actor = await verifyCallerControlsAddress(request, receiverSCA);
    if (!actor) {
      return NextResponse.json(
        { success: false, error: 'You do not control the wallet named in receiverSCA.' },
        { status: 403 }
      );
    }

    // Calculate available
    const now = Date.now();
    const elapsedSeconds = (now - new Date(stream.startedAt).getTime()) / 1000;
    const totalEarned = Math.min(stream.ratePerSecond * elapsedSeconds, stream.totalDeposited);
    const available = Math.max(0, totalEarned - stream.totalStreamed);

    if (available <= 0) {
      return NextResponse.json(
        { success: false, error: 'No USDC available to withdraw yet.' },
        { status: 400 }
      );
    }

    // Get bytes32 streamId
    const contractStreamId = await getStreamIdFromReceipt(stream.txHash);

    let txHash: string;
    if (actor.type === 'merchant') {
      const walletProvider = await resolveWalletProvider(actor.id);
      if (walletProvider.kind !== "CIRCLE") {
        const req = await queueExternalSignatureRequest({
          merchantId: actor.id,
          action: "stream.withdraw",
          actionRefId: reference,
          payload: {
            reference,
            contractStreamId,
            contractAddress: STREAM_CONTRACT,
            receiverSCA,
          },
        });
        return NextResponse.json({
          success: true,
          pendingSignature: true,
          requestId: req.id,
          message: 'Your wallet needs to approve this withdrawal — check /api/merchant/wallet/sign-requests.',
        });
      }
      const result = await walletProvider.executeContract({
        contractAddress: STREAM_CONTRACT,
        abiFunctionSignature: 'withdraw(bytes32)',
        args: [contractStreamId],
      });
      if (result.status === 'failed') {
        return NextResponse.json({ success: false, error: result.error }, { status: 500 });
      }
      if (result.status === 'pending_signature') {
        return NextResponse.json({
          success: true,
          pendingSignature: true,
          requestId: result.requestId,
          message: 'Your wallet needs to approve this withdrawal — check /api/merchant/wallet/sign-requests.',
        });
      }
      txHash = result.txHash;
    } else {
      const circleClient = getCircleClient();
      const withdrawTx = await circleClient.createContractExecutionTransaction({
        walletAddress: receiverSCA,
        blockchain: 'ARC-TESTNET' as any,
        contractAddress: STREAM_CONTRACT,
        abiFunctionSignature: 'withdraw(bytes32)',
        abiParameters: [contractStreamId],
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      });
      if (!withdrawTx.data?.id) {
        throw new Error('Circle withdraw transaction returned no ID.');
      }
      txHash = await waitForCircleTx(circleClient, withdrawTx.data.id);
    }

    const newTotalStreamed = stream.totalStreamed + available;
    const isCompleted = newTotalStreamed >= stream.totalDeposited;

    const updated = await prisma.stream.update({
      where: { reference },
      data: {
        totalStreamed: parseFloat(newTotalStreamed.toFixed(6)),
        status: isCompleted ? 'COMPLETED' : 'ACTIVE',
        stoppedAt: isCompleted ? new Date() : null,
      },
    });

    if (stream.webhookUrl) {
      fetch(stream.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: isCompleted ? 'stream.completed' : 'stream.withdrawn',
          reference,
          receiverSCA,
          amountWithdrawn: parseFloat(available.toFixed(6)),
          totalStreamed: parseFloat(newTotalStreamed.toFixed(6)),
          txHash,
          withdrawnAt: new Date().toISOString(),
          explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        }),
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      stream: updated,
      txHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      amountWithdrawn: parseFloat(available.toFixed(6)),
      totalStreamed: parseFloat(newTotalStreamed.toFixed(6)),
      completed: isCompleted,
      message: `${available.toFixed(6)} USDC withdrawn from stream.`,
    });
  } catch (error: any) {
    console.error('❌ Withdraw error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(withdrawHandler);
