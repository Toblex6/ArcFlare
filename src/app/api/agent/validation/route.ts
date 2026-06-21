// src/app/api/agent/validation/route.ts
// Handles ERC-8004 ValidationRegistry — two-step request/response flow.
// Step 1 (POST /request): Agent owner requests validation from a validator
// Step 2 (POST /respond): Validator submits response (100 = passed, 0 = failed)
// Step 3 (GET /status): Anyone reads validation status onchain

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/middleware/withApiKey';
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
async function validationHandler(request: Request) {
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

      const requestURI = `ipfs://arcflare-validation-${agentId}-${requestTag}`;
      const requestHash = keccak256(
        toHex(`arcflare_validation_agent_${agentId}_${requestTag}_${Date.now()}`)
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

      // 100 = passed, 0 = failed per ERC-8004
      const responseCode = passed ? 100 : 0;
      const responseHash = keccak256(toHex(tag)) as `0x${string}`;

      const tx = await circleClient.createContractExecutionTransaction({
        walletAddress: validatorSCA,
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
  } catch (error: any) {
    console.error('❌ Validation error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(validationHandler);

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

export const GET = withApiKey(getValidationHandler);
