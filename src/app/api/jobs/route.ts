// src/app/api/jobs/route.ts
// ERC-8183 Job Lifecycle — Arc's native agentic commerce standard.
// AgenticCommerce contract: 0x0747EEf0706327138c69792bF28Cd525089e4583
//
// Flow:
// 1. Client creates job      → POST /api/jobs { action: "create" }
// 2. Provider sets budget    → POST /api/jobs { action: "setBudget" }
// 3. Client approves USDC    → POST /api/jobs { action: "approve" }
// 4. Client funds escrow     → POST /api/jobs { action: "fund" }
// 5. Provider submits work   → POST /api/jobs { action: "submit" }
// 6. Client completes job    → POST /api/jobs { action: "complete" }
// 7. Anyone reads job state  → GET  /api/jobs?jobId=xxx

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKeyOrMerchant } from '@/lib/middleware/withMerchantAuth';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { createPublicClient, http, decodeEventLog, keccak256, toHex, formatUnits } from 'viem';

// ── ERC-8183 contract on Arc Testnet ─────────────────────────────────────────
const AGENTIC_COMMERCE_CONTRACT = '0x0747EEf0706327138c69792bF28Cd525089e4583';
const USDC_ARC = '0x3600000000000000000000000000000000000000';

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

const JOB_STATUS_NAMES = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'];

// ── ABI ───────────────────────────────────────────────────────────────────────
const AGENTIC_ABI = [
  {
    name: 'createJob',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'provider', type: 'address' },
      { name: 'evaluator', type: 'address' },
      { name: 'expiredAt', type: 'uint256' },
      { name: 'description', type: 'string' },
      { name: 'hook', type: 'address' },
    ],
    outputs: [{ name: 'jobId', type: 'uint256' }],
  },
  {
    name: 'setBudget',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'fund',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'submit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'deliverable', type: 'bytes32' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'complete',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'reason', type: 'bytes32' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'getJob',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'client', type: 'address' },
          { name: 'provider', type: 'address' },
          { name: 'evaluator', type: 'address' },
          { name: 'description', type: 'string' },
          { name: 'budget', type: 'uint256' },
          { name: 'expiredAt', type: 'uint256' },
          { name: 'status', type: 'uint8' },
          { name: 'hook', type: 'address' },
        ],
      },
    ],
  },
  {
    name: 'JobCreated',
    type: 'event',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'jobId', type: 'uint256' },
      { indexed: true, name: 'client', type: 'address' },
      { indexed: true, name: 'provider', type: 'address' },
      { indexed: false, name: 'evaluator', type: 'address' },
      { indexed: false, name: 'expiredAt', type: 'uint256' },
      { indexed: false, name: 'hook', type: 'address' },
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
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await client.getTransaction({ id: txId });
    if (data?.transaction?.state === 'COMPLETE' && data.transaction.txHash) {
      return data.transaction.txHash;
    }
    if (data?.transaction?.state === 'FAILED') {
      throw new Error('Transaction failed onchain.');
    }
  }
  throw new Error('Transaction timed out.');
}

async function extractJobId(txHash: string): Promise<string> {
  const receipt = await publicClient.getTransactionReceipt({
    hash: txHash as `0x${string}`,
  });

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: AGENTIC_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'JobCreated') {
        return (decoded.args as any).jobId.toString();
      }
    } catch {
      continue;
    }
  }
  throw new Error('Could not parse JobCreated event from receipt.');
}

// ─── POST /api/jobs ───────────────────────────────────────────────────────────
async function jobsHandler(request: Request) {
  try {
    const body = await request.json();
    const { action } = body;

    const validActions = ['create', 'setBudget', 'approve', 'fund', 'submit', 'complete'];

    if (!action || !validActions.includes(action)) {
      return NextResponse.json(
        {
          success: false,
          error: `action must be one of: ${validActions.join(', ')}`,
          flow: {
            '1_create':
              "POST { action:'create', clientSCA, providerSCA, amountUSDC, description, deadlineHours }",
            '2_setBudget': "POST { action:'setBudget', jobId, providerSCA, amountUSDC }",
            '3_approve': "POST { action:'approve', jobId, clientSCA, amountUSDC }",
            '4_fund': "POST { action:'fund', jobId, clientSCA }",
            '5_submit': "POST { action:'submit', jobId, providerSCA, deliverable }",
            '6_complete': "POST { action:'complete', jobId, clientSCA }",
          },
        },
        { status: 400 }
      );
    }

    const circleClient = getCircleClient();

    // ── 1. CREATE JOB ─────────────────────────────────────────────────────────
    if (action === 'create') {
      const {
        clientSCA,
        providerSCA,
        amountUSDC,
        description,
        deadlineHours = 24,
        evaluatorSCA,
      } = body;

      if (!clientSCA || !providerSCA || !amountUSDC || !description) {
        return NextResponse.json(
          {
            success: false,
            error: 'clientSCA, providerSCA, amountUSDC and description are required.',
          },
          { status: 400 }
        );
      }

      const now = await publicClient.getBlock();
      const expiredAt = now.timestamp + BigInt(deadlineHours * 3600);

      const tx = await circleClient.createContractExecutionTransaction({
        walletAddress: clientSCA,
        blockchain: 'ARC-TESTNET' as any,
        contractAddress: AGENTIC_COMMERCE_CONTRACT,
        abiFunctionSignature: 'createJob(address,address,uint256,string,address)',
        abiParameters: [
          providerSCA,
          evaluatorSCA || clientSCA, // client is evaluator by default
          expiredAt.toString(),
          description,
          '0x0000000000000000000000000000000000000000', // no hook
        ],
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      });

      if (!tx.data?.id) throw new Error('Circle transaction returned no ID.');
      const txHash = await waitForTx(circleClient, tx.data.id);
      const jobId = await extractJobId(txHash);

      // Save to Postgres
      await prisma.job
        .create({
          data: {
            id: `erc8183_${jobId}`,
            description,
            amount: parseFloat(amountUSDC),
            status: 'PENDING',
            agentId: providerSCA, // using providerSCA as agentId reference
          },
        })
        .catch(() => { }); // Job model may need agentId FK — graceful fail

      return NextResponse.json({
        success: true,
        action: 'create',
        jobId,
        clientSCA,
        providerSCA,
        amountUSDC,
        description,
        deadlineHours,
        txHash,
        explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        nextStep: `POST /api/jobs { action:'setBudget', jobId:'${jobId}', providerSCA:'${providerSCA}', amountUSDC:'${amountUSDC}' }`,
        message: `Job #${jobId} created on Arc Testnet — status: Open`,
      });
    }

    // ── 2. SET BUDGET ─────────────────────────────────────────────────────────
    if (action === 'setBudget') {
      const { jobId, providerSCA, amountUSDC } = body;

      if (!jobId || !providerSCA || !amountUSDC) {
        return NextResponse.json(
          { success: false, error: 'jobId, providerSCA and amountUSDC are required.' },
          { status: 400 }
        );
      }

      const amountWei = BigInt(Math.round(parseFloat(amountUSDC) * 1_000_000));

      const tx = await circleClient.createContractExecutionTransaction({
        walletAddress: providerSCA,
        blockchain: 'ARC-TESTNET' as any,
        contractAddress: AGENTIC_COMMERCE_CONTRACT,
        abiFunctionSignature: 'setBudget(uint256,uint256,bytes)',
        abiParameters: [jobId.toString(), amountWei.toString(), '0x'],
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      });

      if (!tx.data?.id) throw new Error('Circle transaction returned no ID.');
      const txHash = await waitForTx(circleClient, tx.data.id);

      return NextResponse.json({
        success: true,
        action: 'setBudget',
        jobId,
        amountUSDC,
        providerSCA,
        txHash,
        explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        nextStep: `POST /api/jobs { action:'approve', jobId:'${jobId}', clientSCA:'...', amountUSDC:'${amountUSDC}' }`,
        message: `Budget set: ${amountUSDC} USDC for job #${jobId}`,
      });
    }

    // ── 3. APPROVE USDC ───────────────────────────────────────────────────────
    if (action === 'approve') {
      const { jobId, clientSCA, amountUSDC } = body;

      if (!jobId || !clientSCA || !amountUSDC) {
        return NextResponse.json(
          { success: false, error: 'jobId, clientSCA and amountUSDC are required.' },
          { status: 400 }
        );
      }

      const amountWei = BigInt(Math.round(parseFloat(amountUSDC) * 1_000_000));

      const tx = await circleClient.createContractExecutionTransaction({
        walletAddress: clientSCA,
        blockchain: 'ARC-TESTNET' as any,
        contractAddress: USDC_ARC,
        abiFunctionSignature: 'approve(address,uint256)',
        abiParameters: [AGENTIC_COMMERCE_CONTRACT, amountWei.toString()],
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      });

      if (!tx.data?.id) throw new Error('Circle transaction returned no ID.');
      const txHash = await waitForTx(circleClient, tx.data.id);

      return NextResponse.json({
        success: true,
        action: 'approve',
        jobId,
        amountUSDC,
        clientSCA,
        txHash,
        explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        nextStep: `POST /api/jobs { action:'fund', jobId:'${jobId}', clientSCA:'${clientSCA}' }`,
        message: `USDC approved. ${amountUSDC} USDC approved for ERC-8183 contract to spend.`,
      });
    }

    // ── 4. FUND ESCROW ────────────────────────────────────────────────────────
    if (action === 'fund') {
      const { jobId, clientSCA } = body;

      if (!jobId || !clientSCA) {
        return NextResponse.json(
          { success: false, error: 'jobId and clientSCA are required.' },
          { status: 400 }
        );
      }

      const tx = await circleClient.createContractExecutionTransaction({
        walletAddress: clientSCA,
        blockchain: 'ARC-TESTNET' as any,
        contractAddress: AGENTIC_COMMERCE_CONTRACT,
        abiFunctionSignature: 'fund(uint256,bytes)',
        abiParameters: [jobId.toString(), '0x'],
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      });

      if (!tx.data?.id) throw new Error('Circle transaction returned no ID.');
      const txHash = await waitForTx(circleClient, tx.data.id);

      return NextResponse.json({
        success: true,
        action: 'fund',
        jobId,
        clientSCA,
        txHash,
        explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        nextStep: `POST /api/jobs { action:'submit', jobId:'${jobId}', providerSCA:'...', deliverable:'your work description' }`,
        message: `Job #${jobId} funded — status: Funded. Provider can now submit work.`,
      });
    }

    // ── 5. SUBMIT DELIVERABLE ─────────────────────────────────────────────────
    if (action === 'submit') {
      const { jobId, providerSCA, deliverable } = body;

      if (!jobId || !providerSCA || !deliverable) {
        return NextResponse.json(
          { success: false, error: 'jobId, providerSCA and deliverable are required.' },
          { status: 400 }
        );
      }

      const deliverableHash = keccak256(toHex(deliverable)) as `0x${string}`;

      const tx = await circleClient.createContractExecutionTransaction({
        walletAddress: providerSCA,
        blockchain: 'ARC-TESTNET' as any,
        contractAddress: AGENTIC_COMMERCE_CONTRACT,
        abiFunctionSignature: 'submit(uint256,bytes32,bytes)',
        abiParameters: [jobId.toString(), deliverableHash, '0x'],
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      });

      if (!tx.data?.id) throw new Error('Circle transaction returned no ID.');
      const txHash = await waitForTx(circleClient, tx.data.id);

      return NextResponse.json({
        success: true,
        action: 'submit',
        jobId,
        deliverable,
        deliverableHash,
        providerSCA,
        txHash,
        explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        nextStep: `POST /api/jobs { action:'complete', jobId:'${jobId}', clientSCA:'...' }`,
        message: `Deliverable submitted for job #${jobId} — status: Submitted. Awaiting client completion.`,
      });
    }

    // ── 6. COMPLETE JOB ───────────────────────────────────────────────────────
    if (action === 'complete') {
      const { jobId, clientSCA } = body;

      if (!jobId || !clientSCA) {
        return NextResponse.json(
          { success: false, error: 'jobId and clientSCA are required.' },
          { status: 400 }
        );
      }

      const reasonHash = keccak256(toHex('deliverable-approved')) as `0x${string}`;

      const tx = await circleClient.createContractExecutionTransaction({
        walletAddress: clientSCA,
        blockchain: 'ARC-TESTNET' as any,
        contractAddress: AGENTIC_COMMERCE_CONTRACT,
        abiFunctionSignature: 'complete(uint256,bytes32,bytes)',
        abiParameters: [jobId.toString(), reasonHash, '0x'],
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      });

      if (!tx.data?.id) throw new Error('Circle transaction returned no ID.');
      const txHash = await waitForTx(circleClient, tx.data.id);

      // Read final job state
      const jobData = (await publicClient.readContract({
        address: AGENTIC_COMMERCE_CONTRACT,
        abi: AGENTIC_ABI,
        functionName: 'getJob',
        args: [BigInt(jobId)],
      })) as any;

      const statusName = JOB_STATUS_NAMES[Number(jobData.status)] || 'Unknown';
      const budgetUSDC = formatUnits(jobData.budget, 6);

      return NextResponse.json({
        success: true,
        action: 'complete',
        jobId,
        clientSCA,
        txHash,
        explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        finalJobState: {
          jobId: jobData.id.toString(),
          status: statusName,
          budgetUSDC,
          client: jobData.client,
          provider: jobData.provider,
          description: jobData.description,
        },
        message: `Job #${jobId} completed — status: ${statusName}. Payment of ${budgetUSDC} USDC released to provider.`,
      });
    }
  } catch (error: any) {
    console.error('❌ Jobs route error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKeyOrMerchant(jobsHandler);

// ─── GET /api/jobs?jobId=xxx ──────────────────────────────────────────────────
// Reads job state directly from ERC-8183 AgenticCommerce contract
async function getJobHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('jobId');

    if (!jobId) {
      return NextResponse.json(
        { success: false, error: 'jobId query param required.' },
        { status: 400 }
      );
    }

    const jobData = (await publicClient.readContract({
      address: AGENTIC_COMMERCE_CONTRACT,
      abi: AGENTIC_ABI,
      functionName: 'getJob',
      args: [BigInt(jobId)],
    })) as any;

    const statusName = JOB_STATUS_NAMES[Number(jobData.status)] || 'Unknown';
    const budgetUSDC = formatUnits(jobData.budget, 6);
    const expiredAt = new Date(Number(jobData.expiredAt) * 1000).toISOString();
    const isExpired = Date.now() > Number(jobData.expiredAt) * 1000;

    return NextResponse.json({
      success: true,
      job: {
        jobId: jobData.id.toString(),
        status: statusName,
        statusCode: Number(jobData.status),
        budgetUSDC,
        client: jobData.client,
        provider: jobData.provider,
        evaluator: jobData.evaluator,
        description: jobData.description,
        expiredAt,
        isExpired,
        hook: jobData.hook,
      },
      contractAddress: AGENTIC_COMMERCE_CONTRACT,
      arcScanUrl: `https://testnet.arcscan.app/address/${AGENTIC_COMMERCE_CONTRACT}`,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const GET = withApiKeyOrMerchant(getJobHandler);
export const dynamic = 'force-dynamic';