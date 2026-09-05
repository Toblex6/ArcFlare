// src/app/api/agent/validation/route.ts
// Handles ERC-8004 ValidationRegistry — two-step request/response flow.
// Step 1 (POST /request): Agent owner requests validation from a validator
// Step 2 (POST /respond): Validator submits response (100 = passed, 0 = failed)
// Step 3 (GET /status): Anyone reads validation status onchain

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKeyOrAnySession } from '@/lib/middleware/withMerchantAuth';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { notifyValidator } from '@/lib/notifyValidator';
import {
  syncJobValidationResponseByRequestHash,
  resolveResponseValidator,
} from '@/lib/jobs/jobValidationPolicy';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { createPublicClient, http, keccak256, toHex } from 'viem';

const VALIDATION_REGISTRY = '0x8004Cb1BF31DAf7788923b405b754f57acEB4272';

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

const VALIDATION_ABI = [
  {
    name: 'validationRequest',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'validator', type: 'address' },
      { name: 'agentId', type: 'uint256' },
      { name: 'requestURI', type: 'string' },
      { name: 'requestHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'validationResponse',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'requestHash', type: 'bytes32' },
      { name: 'response', type: 'uint8' },
      { name: 'responseURI', type: 'string' },
      { name: 'responseHash', type: 'bytes32' },
      { name: 'tag', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'getValidationStatus',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'requestHash', type: 'bytes32' }],
    outputs: [
      { name: 'validatorAddress', type: 'address' },
      { name: 'agentId', type: 'uint256' },
      { name: 'response', type: 'uint8' },
      { name: 'responseHash', type: 'bytes32' },
      { name: 'tag', type: 'string' },
      { name: 'lastUpdate', type: 'uint256' },
    ],
  },
] as const;

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
}

async function waitForTx(
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
      throw new Error('Validation transaction failed onchain.');
    }
  }
  throw new Error('Validation transaction timed out.');
}

// ─── POST /api/agent/validation ───────────────────────────────────────────────
// Handles both request and respond actions via "action" field
async function validationHandler(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    if (!action || !['request', 'respond'].includes(action)) {
      return NextResponse.json(
        {
          success: false,
          error: "action must be 'request' or 'respond'.",
          usage: {
            request: {
              action: 'request',
              agentId: '68210',
              ownerSCA: '0xOwnerWalletAddress',
              validatorSCA: '0xValidatorWalletAddress',
              requestTag: 'kyc_verification',
            },
            respond: {
              action: 'respond',
              validatorSCA: '0xValidatorWalletAddress',
              requestHash: '0xTheRequestHash',
              passed: true,
              tag: 'kyc_verified',
            },
          },
        },
        { status: 400 }
      );
    }

    const circleClient = getCircleClient();

    // ── ACTION: REQUEST ───────────────────────────────────────────────────────
    if (action === 'request') {
      const { agentId, ownerSCA, validatorSCA, requestTag } = body;

      if (!agentId || !ownerSCA || !validatorSCA || !requestTag) {
        return NextResponse.json(
          { success: false, error: 'agentId, ownerSCA, validatorSCA and requestTag are required.' },
          { status: 400 }
        );
      }

      // Verify agent exists
      const agent = await (prisma as any).agentRegistry.findFirst({
        where: { tokenId: agentId.toString() },
      });

      if (!agent) {
        return NextResponse.json(
          { success: false, error: `Agent ${agentId} not found in registry.` },
          { status: 404 }
        );
      }

      // Ensure owner is making the request
      if (ownerSCA.toLowerCase() !== agent.scaAddress.toLowerCase()) {
        return NextResponse.json(
          {
            success: false,
            error: 'Only the agent owner SCA can request validation.',
          },
          { status: 403 }
        );
      }

      // Ownership check — caller must actually control ownerSCA.
      const requestActor = await verifyCallerControlsAddress(request, ownerSCA);
      if (!requestActor) {
        return NextResponse.json(
          { success: false, error: 'You do not control the wallet named in ownerSCA.' },
          { status: 403 }
        );
      }

      const requestURI = `ipfs://arcflare-validation-${agentId}-${requestTag}`;
      const requestHash = keccak256(
        toHex(`flarehq_validation_agent_${agentId}_${requestTag}_${Date.now()}`)
      ) as `0x${string}`;

      const tx = await circleClient.createContractExecutionTransaction({
        walletAddress: ownerSCA,
        blockchain: 'ARC-TESTNET' as any,
        contractAddress: VALIDATION_REGISTRY,
        abiFunctionSignature: 'validationRequest(address,uint256,string,bytes32)',
        abiParameters: [validatorSCA, agentId.toString(), requestURI, requestHash],
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      });

      if (!tx.data?.id) throw new Error('Circle transaction returned no ID.');

      const txHash = await waitForTx(circleClient, tx.data.id);

      console.log(`✅ Validation requested for agent ${agentId}. RequestHash: ${requestHash}`);

      // SUBTASK D — notify the validator AFTER on-chain success only.
      // validatorSCA here is authoritative: it is the exact `validator`
      // argument sent to ValidationRegistry.validationRequest above.
      // Best-effort: failure must NOT invalidate the successful request.
      // NOTE (receiver gap): there is no validator pending inbox — no
      // ValidationRequest table, no event indexer, and the /agents dashboard
      // validation tab is manual requestHash entry. The validator discovers
      // the pending request via this notification (requestHash included) and
      // responds via action "respond". A real inbox needs a persisted request
      // record + query route — deliberately out of scope here.
      let validatorNotified = { notified: false } as Awaited<ReturnType<typeof notifyValidator>>;
      try {
        validatorNotified = await notifyValidator({
          validatorSCA,
          agentTokenId: agentId.toString(),
          agentName: agent.name ?? null,
          requestTag,
          requestHash,
          requestURI,
          txHash,
        });
      } catch (notifyError: any) {
        console.error('[validation/request] validator notification failed (non-fatal):', notifyError?.message);
        validatorNotified = { notified: false, reason: notifyError?.message || 'notify-failed' };
      }

      return NextResponse.json({
        success: true,
        action: 'request',
        agentId,
        agentName: agent.name,
        validatorSCA,
        requestHash,
        requestURI,
        txHash,
        explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        validatorNotified,
        nextStep: `Call POST /api/agent/validation with action: "respond" and requestHash: "${requestHash}"`,
        message: `Validation requested for agent #${agentId}. Validator ${validatorSCA} must now respond.`,
      });
    }

    // ── ACTION: RESPOND ───────────────────────────────────────────────────────
    if (action === 'respond') {
      const { validatorSCA, requestHash, passed, tag } = body;

      if (!validatorSCA || !requestHash || passed === undefined || !tag) {
        return NextResponse.json(
          {
            success: false,
            error: 'validatorSCA, requestHash, passed (boolean) and tag are required.',
          },
          { status: 400 }
        );
      }

      // AUTHORIZATION — prove this responder IS the designated validator for
      // this requestHash, BEFORE any on-chain interaction.
      //
      // Source of truth: the on-chain ValidationRegistry (getValidationStatus)
      // records the `validator` named by the original validationRequest, so it
      // decides who may respond. The client-supplied validatorSCA is only a
      // hint and MUST equal it (case-insensitively). For job-linked requests
      // resolveResponseValidator also requires the persisted
      // Erc8183JobValidation.validatorSCA to agree with on-chain — on a silent
      // disagreement it fails closed (ok=false) so the DB and the registry can
      // never conflict. A caller controlling some OTHER valid validator wallet
      // cannot answer this request.
      const designated = await resolveResponseValidator(requestHash);
      if (!designated.ok || !designated.validatorAddress) {
        return NextResponse.json(
          {
            success: false,
            error:
              designated.reason ||
              'Cannot authorize this validation response — the designated validator could not be proven.',
          },
          { status: 403 }
        );
      }
      if (validatorSCA.toLowerCase() !== designated.validatorAddress.toLowerCase()) {
        return NextResponse.json(
          {
            success: false,
            error: 'You are not the designated validator for this requestHash.',
          },
          { status: 403 }
        );
      }

      // Ownership check — caller must actually control the (now-verified)
      // designated validator. validatorSCA already equals designated.validatorAddress
      // above, so this proves ownership of the correct wallet. Not weakened.
      const respondActor = await verifyCallerControlsAddress(request, validatorSCA);
      if (!respondActor) {
        return NextResponse.json(
          { success: false, error: 'You do not control the wallet named in validatorSCA.' },
          { status: 403 }
        );
      }

      // 100 = passed, 0 = failed per ERC-8004
      const responseCode = passed ? 100 : 0;
      const responseHash = keccak256(toHex(tag)) as `0x${string}`;

      const tx = await circleClient.createContractExecutionTransaction({
        walletAddress: designated.validatorAddress,
        blockchain: 'ARC-TESTNET' as any,
        contractAddress: VALIDATION_REGISTRY,
        abiFunctionSignature: 'validationResponse(bytes32,uint8,string,bytes32,string)',
        abiParameters: [requestHash, responseCode.toString(), '', `0x${'0'.repeat(64)}`, tag],
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      });

      if (!tx.data?.id) throw new Error('Circle transaction returned no ID.');

      const txHash = await waitForTx(circleClient, tx.data.id);

      console.log(
        `✅ Validation response submitted. Passed: ${passed}. Tag: ${tag}. Tx: ${txHash}`
      );

      // DB sync for JOB-backed validation requests — best-effort ONLY, and ONLY
      // after the on-chain validationResponse tx succeeded (txHash is proof).
      // The on-chain registry (getValidationStatus) remains the authoritative
      // source; this just keeps Erc8183JobValidation.status in sync so the job
      // release gate and status views agree with the chain. A hash that does not
      // map to any job-backed request is a plain ERC-8004 agent validation and is
      // a no-op here. A DB error must NEVER turn the already-successful on-chain
      // response into an HTTP failure — log it server-side and continue.
      try {
        await syncJobValidationResponseByRequestHash(requestHash, txHash, passed, tag);
      } catch (dbSyncError: any) {
        console.error(
          '[validation/respond] job-validation DB sync failed (non-fatal):',
          dbSyncError?.message ?? dbSyncError
        );
      }

      return NextResponse.json({
        success: true,
        action: 'respond',
        requestHash,
        passed,
        responseCode,
        tag,
        validatorSCA,
        txHash,
        explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        nextStep: `Check status via GET /api/agent/validation?requestHash=${requestHash}`,
        message: `Validation response submitted — ${passed ? 'PASSED ✅' : 'FAILED ❌'} (tag: ${tag})`,
      });
    }

    // All valid actions return above — unreachable, keeps the wrapper's
    // Promise<NextResponse> contract honest.
    return NextResponse.json(
      { success: false, error: `action must be one of: create, respond` },
      { status: 400 }
    );
  } catch (error: any) {
    console.error('❌ Validation error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Session-capable wrapper: a logged-in merchant (or consumer) passes the
// outer gate; verifyCallerControlsAddress inside still decides WHO may
// request/respond. The strict withApiKey gate made the /agents dashboard
// validation tab unusable without a raw service key.
export const POST = withApiKeyOrAnySession(validationHandler);

// ─── GET /api/agent/validation?requestHash=0x... ──────────────────────────────
// Reads validation status directly from ValidationRegistry onchain
async function getValidationHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const requestHash = searchParams.get('requestHash');

    if (!requestHash) {
      return NextResponse.json(
        { success: false, error: 'requestHash query param required.' },
        { status: 400 }
      );
    }

    const result = (await publicClient.readContract({
      address: VALIDATION_REGISTRY,
      abi: VALIDATION_ABI,
      functionName: 'getValidationStatus',
      args: [requestHash as `0x${string}`],
    })) as readonly [`0x${string}`, bigint, number, `0x${string}`, string, bigint];

    const [validatorAddress, agentId, response, responseHash, tag, lastUpdate] = result;

    const passed = response === 100;
    const pending = validatorAddress === '0x0000000000000000000000000000000000000000';

    return NextResponse.json({
      success: true,
      requestHash,
      validation: {
        validatorAddress,
        agentId: agentId.toString(),
        response,
        passed,
        pending,
        tag,
        lastUpdate: lastUpdate.toString(),
        lastUpdatedAt: lastUpdate > 0n ? new Date(Number(lastUpdate) * 1000).toISOString() : null,
      },
      validationRegistryAddress: VALIDATION_REGISTRY,
      arcScanUrl: `https://testnet.arcscan.app/address/${VALIDATION_REGISTRY}`,
      message: pending
        ? 'Validation request pending — validator has not responded yet.'
        : `Validation ${passed ? 'PASSED ✅' : 'FAILED ❌'} — tag: ${tag}`,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const GET = withApiKeyOrAnySession(getValidationHandler);
