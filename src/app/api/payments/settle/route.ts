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

    // ── 3. Load the row and authorize the caller BEFORE taking the lock ──────
    // An unauthorized caller gets an early 403 and the row stays exactly as
    // it was. (Previously the guard ran AFTER the atomic lock, so every
    // rejected call parked the row in PROCESSING_ONCHAIN and burned its
    // 5-minute stale-lock window — a rolling denial of settlement.)
    const preflight = await prisma.paymentLog.findUnique({ where: { reference } });
    if (!preflight) {
      return NextResponse.json(
        { success: false, error: 'Payment reference not found.' },
        { status: 404 }
      );
    }

    // ── SECURITY: unconditional payer-control guard ──────────────────────────
    // withApiKeyOrAnySession (above) only proves "is this a valid credential,"
    // never "does this credential own THIS payment." This guard runs for
    // EVERY caller — internal service keys included:
    //   - merchant: must own the row AND control its payer (their own payout
    //     wallet or a registered agent). A merchant naming a stranger's
    //     wallet as payer gets 403 — the "merchant names a victim as payer"
    //     drain. A merchant settling their OWN row whose payer is not a real
    //     0x address ('pending@checkout' link rows) also gets 403: those rows
    //     are finalized only by the customer paying on-chain and
    //     /api/payments/verify-onchain, never by settle debiting a shared
    //     platform default wallet.
    //   - consumer: must be the payer themselves (senderEmail == their wallet).
    //   - internal service key (agent/brain): may only settle a payment whose
    //     payer is the platform's own agent (AGENT_OWNER_WALLET_ADDRESS).
    //     The public checkout trigger is gone (deleted 2026-08-19 — the
    //     checkout UI settles from the customer's own wallet via
    //     verify-onchain), so no unauthenticated call can name ANY payer and
    //     debit DEFAULT_PAYER_WALLET_ID or any agent's custodial wallet.
    const internalApiKey = request.headers.get('x-api-key');
    const serviceKey = internalApiKey
      ? await (prisma as any).apiKey.findUnique({ where: { key: internalApiKey } })
      : null;
    // Active check: a revoked key must not satisfy this branch (M5).
    const isInternalServiceCall = !!(serviceKey && serviceKey.active);

    const callerMerchant = isInternalServiceCall
      ? null
      : await resolveMerchant(request).catch(() => null);
    const callerConsumerWallet = isInternalServiceCall
      ? null
      : await resolveConsumerSession(request).catch(() => null);

    const merchantOwnsIt = callerMerchant && preflight.merchantId === callerMerchant.id;
    const consumerOwnsIt =
      callerConsumerWallet &&
      preflight.senderEmail?.toLowerCase() === callerConsumerWallet.toLowerCase();

    const payerIsAddress =
      !!preflight.senderEmail?.startsWith('0x') &&
      preflight.senderEmail.toLowerCase() !== 'pending@checkout';

    let payerAuthorized = false;

    if (isInternalServiceCall) {
      // The internal key may only ever debit the platform's own agent wallet
      // (agent/brain pays from AGENT_OWNER_WALLET_ADDRESS). Any other payer —
      // a consumer wallet, a third-party agent SCA, or the platform-default
      // fallback wallets — is rejected: none of them authorized the debit.
      const platformAgent = (process.env.AGENT_OWNER_WALLET_ADDRESS || '').toLowerCase();
      payerAuthorized =
        !!platformAgent && payerIsAddress && preflight.senderEmail.toLowerCase() === platformAgent;
    } else if (payerIsAddress) {
      // Consumer: they ARE the payer — settling their own send is legitimate.
      if (consumerOwnsIt) {
        payerAuthorized = true;
      } else if (callerMerchant && merchantOwnsIt) {
        // Merchant: the payer must be their own payout wallet or one of
        // their registered agents. Same rule as before, now structured so
        // every caller class is held to it.
        const merchantRecord = await (prisma as any).merchant.findUnique({
          where: { id: callerMerchant.id },
        });
        const controlsPayer =
          merchantRecord?.walletAddress?.toLowerCase() === preflight.senderEmail?.toLowerCase();
        const ownsPayerAgent =
          !controlsPayer &&
          (await (prisma as any).agentRegistry.findFirst({
            where: {
              merchantId: callerMerchant.id,
              scaAddress: { equals: preflight.senderEmail, mode: 'insensitive' },
            },
          }));
        payerAuthorized = controlsPayer || !!ownsPayerAgent;
      }
    }
    // NOTE: there is deliberately no branch for a merchant settling their own
    // row whose payer is NOT a real address. 'pending@checkout' rows used to
    // be settleable by the owning merchant, which let a self-registered
    // merchant create a link row and settle it against the shared platform
    // default-payer wallet (a drain: the audit's C1 escape hatch). No
    // legitimate caller needed it — the real checkout path is customer-pays-
    // onchain → verify-onchain, which marks rows SUCCESS without settle.

    if (!payerAuthorized) {
      return NextResponse.json(
        {
          success: false,
          error:
            'You are not a party to this payment: its payer is a wallet you do not control.',
        },
        { status: 403 }
      );
    }

    if (preflight.expiresAt && new Date() > preflight.expiresAt) {
      await prisma.paymentLog.update({
        where: { reference },
        data: { status: 'EXPIRED' },
      });
      return NextResponse.json(
        { success: false, error: 'Payment reference has expired.' },
        { status: 400 }
      );
    }

    // ── 4. Atomic Lock with Stale Lock Recovery (5 minutes) across ALL transient states
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

    // 5. Fetch Payment Data (post-lock — the lock may have reclaimed a stale
    // transient state, so re-read the authoritative row).
    const payment = await prisma.paymentLog.findUnique({ where: { reference } });
    if (!payment) throw new Error('Payment not found after lock');

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

    // The payer-control guard above guarantees this is a real 0x address the
    // caller is authorized to debit — never 'pending@checkout', never a
    // merchant-named stranger, never an arbitrary agent SCA.
    const payerSCA = payment.senderEmail;
    if (!payerSCA?.startsWith('0x')) {
      throw new Error(
        `Payment ${reference} has no on-chain payer — refusing to debit a shared default wallet.`
      );
    }

    // Resolve which Circle wallet actually signs for this address.
    // Order of precedence:
    //   1. ConsumerAccount — where Flow's "created wallet" consumers are
    //      registered with their real per-user circleWalletId.
    //   2. AgentRegistry — AI-agent (M2M) wallets, a separate feature.
    //   3. Platform default — ONLY for the platform's own agent
    //      (AGENT_OWNER_WALLET_ADDRESS): that agent IS the platform default
    //      wallet's signer (brain agent_pay_agent / A2A payments). Any other
    //      payer with no bound wallet fails closed instead of silently
    //      debiting a shared pool — that silent debit was the class of bug
    //      behind the C1 merchant drain and the agent-without-wallet cases.
    let payerWalletId: string | undefined;

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

    if (!payerWalletId) {
      const platformAgent = (process.env.AGENT_OWNER_WALLET_ADDRESS || '').toLowerCase();
      if (payerSCA.toLowerCase() !== platformAgent) {
        throw new Error(
          `No Circle wallet is bound to payer ${payerSCA} — refusing to debit a shared default wallet.`
        );
      }
      payerWalletId = DEFAULT_PAYER_WALLET_ID;
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