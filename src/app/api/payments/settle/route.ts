// src/app/api/payments/settle/route.ts
// 🔀 MERGED SETTLEMENT ROUTE (CCTP Bridge + On-chain SCA Transfer)
// Production‑ready: State-aware transaction resumption, stale lock recovery, and pristine strings.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { createWalletClient, createPublicClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from 'viem/chains';
import { withApiKeyOrAnySession, resolveMerchant } from '@/lib/middleware/withMerchantAuth';
import { resolveConsumerSession } from '@/lib/middleware/withConsumerAuth';
import { checkRateLimit } from '@/lib/ratelimit';
import { parseBody, SettleSchema } from '@/lib/validation';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

// ── Constants & Config ───────────────────────────────────────────────────────
const MESSAGE_TRANSMITTER_V2 = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275';
const IRIS_API = 'https://iris-api-sandbox.circle.com/v2';
const USDC_ARC = '0x3600000000000000000000000000000000000000';

// SCA Defaults
const DEFAULT_PAYER_SCA = '0x7a8214dad7630a7a39054e0121acdbc7a65821c9';
const DEFAULT_PAYER_WALLET_ID = '58ab0223-cad0-5128-896e-a88d6f217b43';
const DEFAULT_MERCHANT_SCA =
  process.env.MERCHANT_SCA_ADDRESS || '0x902C565bE31c146a79350387C1f77d6896814B58';

const MESSAGE_TRANSMITTER_ABI = [
  {
    name: 'receiveMessage',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'message', type: 'bytes' },
      { name: 'attestation', type: 'bytes' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
] as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
}

async function pollForAttestation(messageHash: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const res = await fetch(`${IRIS_API}/attestations/${messageHash}`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'complete' && data.attestation) {
          return { message: data.message, attestation: data.attestation };
        }
      }
    } catch (_) { }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('CCTP Attestation timed out after 90 seconds.');
}

async function waitForCircleTx(client: any, txId: string) {
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

async function fireWebhook(url: string, payload: object) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err: any) {
    console.error('Webhook delivery failed:', err.message);
  }
}

// ── Main Handler ─────────────────────────────────────────────────────────────

async function mergedSettleHandler(request: NextRequest) {
  let fallbackReference: string | undefined;
  let partialCircleTxId: string | undefined;

  try {
    // 1. Rate Limiting
    const { allowed, response: limitResponse } = await checkRateLimit(request, 'payments');
    if (!allowed) return limitResponse;

    // 2. Input Validation
    const body = await request.json().catch(() => ({}));
    const { data, error: validationError } = parseBody(SettleSchema, body);
    if (validationError) return validationError;

    const { reference, messageHash } = data;
    fallbackReference = reference;

    // 3. Atomic Lock with Stale Lock Recovery (5 minutes) across ALL transient states
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const lock = await prisma.paymentLog.updateMany({
      where: {
        reference,
        OR: [
          {
            status: {
              notIn: [
                'SUCCESS',
                'REDEEMED_AND_MINTED',
                'PROCESSING_ONCHAIN',
                'POLLING_CIRCLE_TESTNET_IRIS_API',
                'REDEEMING_ON_ARC',
              ],
            },
          },
          {
            // Recover locks abandoned by crashed workers in ANY transient state
            status: {
              in: ['PROCESSING_ONCHAIN', 'POLLING_CIRCLE_TESTNET_IRIS_API', 'REDEEMING_ON_ARC'],
            },
            updatedAt: { lt: fiveMinutesAgo },
          },
        ],
      },
      data: { status: 'PROCESSING_ONCHAIN', updatedAt: new Date() },
    });

    if (lock.count === 0) {
      const existing = await prisma.paymentLog.findUnique({ where: { reference } });
      return NextResponse.json(
        {
          success: false,
          error: 'Payment already processing or settled.',
          status: existing?.status,
        },
        { status: 409 }
      );
    }

    // 4. Fetch Payment Data & Expiry Check
    const payment = await prisma.paymentLog.findUnique({ where: { reference } });
    if (!payment) throw new Error('Payment not found after lock');

    // ── SECURITY: ownership guard — added because withApiKeyOrAnySession
    // only checks "is this a valid credential," never "does this credential
    // own THIS payment." Any authenticated merchant or consumer could
    // previously settle any OTHER party's payment just by knowing its
    // reference. Internal service ApiKey calls (agent-to-agent automation)
    // are still allowed through unrestricted — that's a legitimate,
    // trusted pattern, not the gap being closed here.
    const internalApiKey = request.headers.get('x-api-key');
    const isInternalServiceCall = internalApiKey
      ? !!(await (prisma as any).apiKey.findUnique({ where: { key: internalApiKey } }))
      : false;

    if (!isInternalServiceCall) {
      const callerMerchant = await resolveMerchant(request).catch(() => null);
      const callerConsumerWallet = await resolveConsumerSession(request).catch(() => null);

      const merchantOwnsIt = callerMerchant && payment.merchantId === callerMerchant.id;
      const consumerOwnsIt =
        callerConsumerWallet &&
        payment.senderEmail?.toLowerCase() === callerConsumerWallet.toLowerCase();

      if (!merchantOwnsIt && !consumerOwnsIt) {
        // Not attempting to restore the pre-lock status here — it wasn't
        // captured before the lock ran. Left in PROCESSING_ONCHAIN
        // deliberately: this file's own stale-lock recovery (5 minutes,
        // see step 3 above) already reclaims exactly this state, so this
        // self-heals via existing logic rather than needing a new path.
        return NextResponse.json(
          { success: false, error: 'You are not a party to this payment.' },
          { status: 403 }
        );
      }
    }

    if (payment.expiresAt && new Date() > payment.expiresAt) {
      await prisma.paymentLog.update({ where: { reference }, data: { status: 'EXPIRED' } });
      return NextResponse.json(
        { success: false, error: 'Payment reference has expired.' },
        { status: 400 }
      );
    }

    // ── PATH A: CROSS-CHAIN CCTP SETTLEMENT ─────────────────────────────────
    if (messageHash) {
      console.log(`🌉 Initiating CCTP Bridge Settlement for ${reference}`);
      await prisma.paymentLog.update({
        where: { reference },
        data: { status: 'POLLING_CIRCLE_TESTNET_IRIS_API' },
      });

      const { message, attestation } = await pollForAttestation(messageHash);

      await prisma.paymentLog.update({
        where: { reference },
        data: { status: 'REDEEMING_ON_ARC' },
      });

      const adminKey = process.env.ARC_ADMIN_PRIVATE_KEY;
      if (!adminKey) throw new Error('ARC_ADMIN_PRIVATE_KEY missing.');

      const account = privateKeyToAccount(adminKey as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: arcTestnet,
        transport: http('https://rpc.testnet.arc.network'),
      });
      const publicClient = createPublicClient({
        chain: arcTestnet,
        transport: http('https://rpc.testnet.arc.network'),
      });

      const txHash = await walletClient.writeContract({
        address: MESSAGE_TRANSMITTER_V2,
        abi: MESSAGE_TRANSMITTER_ABI,
        functionName: 'receiveMessage',
        args: [message as `0x${string}`, attestation as `0x${string}`],
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        throw new Error('Arc redemption transaction reverted.');
      }

      const updated = await prisma.paymentLog.update({
        where: { reference },
        data: { status: 'REDEEMED_AND_MINTED', arcTxHash: txHash },
      });

      if (updated.webhookUrl) {
        await fireWebhook(updated.webhookUrl, {
          event: 'payment.settled',
          reference: updated.reference,
          amount: updated.amount,
          status: 'SUCCESS',
          settlementType: 'CCTP_BRIDGE',
          arcTxHash: txHash,
          explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        });
      }

      return NextResponse.json({
        success: true,
        settlementType: 'CCTP_BRIDGE',
        transaction: updated,
        arcTxHash: txHash,
      });
    }

    // ── PATH B: ON-CHAIN USDC TRANSFER (M2M / SCA) ──────────────────────────
    console.log(`💸 Processing On-chain SCA Settlement for ${reference}`);

    const payerSCA = payment.senderEmail?.startsWith('0x')
      ? payment.senderEmail
      : DEFAULT_PAYER_SCA;
    let payerWalletId = DEFAULT_PAYER_WALLET_ID;

    // Resolve which Circle wallet actually signs for this address.
    // Order of precedence:
    //   1. ConsumerAccount — this is where Flow's "created wallet" consumers
    //      are registered with their real per-user circleWalletId. This was
    //      previously skipped entirely, so every consumer payment silently
    //      settled from one shared DEFAULT_PAYER_WALLET_ID regardless of
    //      who was actually paying.
    //   2. AgentRegistry — AI-agent (M2M) wallets, a separate feature.
    //   3. DEFAULT_PAYER_WALLET_ID — legacy/demo fallback only.
    const consumerAccount = await (prisma as any).consumerAccount.findUnique({
      where: { walletAddress: payerSCA },
    });

    if (consumerAccount) {
      if (consumerAccount.walletType === 'EXTERNAL') {
        // This is a bring-your-own wallet. We never held its key, so there
        // is no Circle wallet ID to sign with — this can only be settled by
        // having the wallet sign the transaction itself client-side (not
        // yet implemented), not by any server-side fallback.
        throw new Error(
          `Wallet ${payerSCA} is an external (non-custodial) wallet — ArcFlare does not hold its private key and cannot sign transactions on its behalf. This wallet must sign and submit the transfer itself.`
        );
      }
      if (consumerAccount.circleWalletId) {
        payerWalletId = consumerAccount.circleWalletId;
      }
    } else {
      const agentRecord = await (prisma as any).agentRegistry.findFirst({
        where: { scaAddress: payerSCA },
      });
      if (agentRecord?.circleWalletId) payerWalletId = agentRecord.circleWalletId;
    }

    // Resolve the real merchant payout wallet. Falls back to the platform
    // default ONLY for legacy/test payments with no merchantId attached —
    // any real merchant payment link must have merchantSCA set already.
    let merchantSCA = payment.merchantSCA || DEFAULT_MERCHANT_SCA;
    if (payment.merchantId) {
      const merchantRecord = await (prisma as any).merchant.findUnique({
        where: { id: payment.merchantId },
      });
      if (!merchantRecord?.walletAddress) {
        throw new Error(
          `Merchant ${payment.merchantId} has no payout wallet configured. Cannot settle.`
        );
      }
      merchantSCA = merchantRecord.walletAddress;
    }
    const circleClient = getCircleClient();

    let arcTxHash: string;
    let circleTxId: string | undefined = payment.circleTxId || undefined;

    // Resumption Logic: Check if existing circleTxId is structurally sound
    if (circleTxId) {
      try {
        const tx = await circleClient.getTransaction({ id: circleTxId });
        if (tx.data?.transaction?.state === 'FAILED') {
          console.warn(
            `⚠️ Previous Circle Transaction (${circleTxId}) FAILED. Discarding and creating a new transfer.`
          );
          circleTxId = undefined; // Nullify to force creation below
        } else {
          console.log(`♻️ Resuming tracking for existing Circle Transaction ID: ${circleTxId}`);
        }
      } catch (err: any) {
        console.error(`Failed to verify existing transaction state: ${err.message}`);
        // If we cannot fetch it, we let it proceed to tracking, which will throw safely if invalid.
      }
    }

    // Creation Logic: Only fires if circleTxId is undefined (new or discarded)
    if (!circleTxId) {
      // STEP 1: Attempt native Circle transfer initialization
      try {
        const transferTx = await circleClient.createTransaction({
          walletId: payerWalletId,
          blockchain: 'ARC-TESTNET' as any,
          tokenAddress: USDC_ARC,
          destinationAddress: merchantSCA,
          amounts: [payment.amount.toFixed(6)],
          fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
        } as any);
        circleTxId = transferTx.data?.id;
      } catch (nativeInitError: any) {
        console.warn(
          'Native Circle transfer initialization failed, trying fallback:',
          nativeInitError.message
        );
      }

      // STEP 2: Fallback to ERC‑20 contract execution ONLY if no transaction ID was generated
      if (!circleTxId) {
        try {
          console.log('Executing fallback ERC-20 transfer via contract execution...');
          const contractTx = await circleClient.createContractExecutionTransaction({
            walletAddress: payerSCA,
            blockchain: 'ARC-TESTNET',
            contractAddress: USDC_ARC,
            abiFunctionSignature: 'transfer(address,uint256)',
            abiParameters: [merchantSCA, parseUnits(payment.amount.toFixed(6), 6).toString()],
            fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
          });
          circleTxId = contractTx.data?.id;
          if (!circleTxId)
            throw new Error('Fallback ERC-20 transfer failed to generate a Transaction ID.');
        } catch (fallbackError: any) {
          throw new Error(
            `Both native and fallback initialization failed. Error: ${fallbackError.message}`
          );
        }
      }
    }

    // Capture the generated/resumed ID for the catch block telemetry
    partialCircleTxId = circleTxId;

    // STEP 3: Poll/Wait for finality.
    try {
      arcTxHash = await waitForCircleTx(circleClient, circleTxId!);
    } catch (pollingError: any) {
      // Save the circleTxId so it can be resumed on the next retry
      await prisma.paymentLog
        .update({
          where: { reference },
          data: { circleTxId, status: 'SETTLEMENT_ERROR' },
        })
        .catch(() => { });

      throw new Error(
        `Transaction tracked (ID: ${circleTxId}), but network finality timed out or failed: ${pollingError.message}`
      );
    }

    // Final success update
    const settled = await prisma.paymentLog.update({
      where: { reference },
      data: {
        status: 'SUCCESS',
        arcTxHash,
        chain: 'Arc Testnet (On-chain Transfer)',
        circleTxId: circleTxId,
      },
    });

    if (settled.webhookUrl) {
      await fireWebhook(settled.webhookUrl, {
        event: 'payment.settled',
        reference,
        amount: settled.amount,
        status: 'SUCCESS',
        settlementType: 'ONCHAIN_SCA_TRANSFER',
        arcTxHash,
        circleTxId,
        explorerUrl: `https://testnet.arcscan.app/tx/${arcTxHash}`,
      });
    }

    return NextResponse.json({
      success: true,
      settlementType: 'ONCHAIN_SCA_TRANSFER',
      transaction: settled,
      arcTxHash,
      circleTxId,
    });
  } catch (error: any) {
    console.error('Settlement Error:', error.message);
    if (fallbackReference) {
      // Preserve the transaction ID if it was generated before the error occurred
      const updateData: any = { status: 'SETTLEMENT_ERROR' };
      if (partialCircleTxId) updateData.circleTxId = partialCircleTxId;

      await prisma.paymentLog
        .update({
          where: { reference: fallbackReference },
          data: updateData,
        })
        .catch(() => { });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKeyOrAnySession(mergedSettleHandler as any);
export async function GET() {
  return NextResponse.json({ success: true, message: 'FlareHQ Merged Settlement Engine Active.' });
}