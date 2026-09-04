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
import { withApiKeyOrAnySession } from '@/lib/middleware/withMerchantAuth';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { createPublicClient, http, decodeEventLog, keccak256, toHex, formatUnits, erc20Abi } from 'viem';

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
      // Surface Circle's actual revert reason — "Transaction failed
      // onchain." alone gave callers no way to tell insufficient-balance
      // from wrong-state from bad-actor reverts.
      const reason =
        data.transaction.errorReason ||
        (data.transaction.errorDetails ? JSON.stringify(data.transaction.errorDetails) : '') ||
        'no revert reason reported';
      throw new Error(`Transaction failed onchain: ${reason}`);
    }
  }
  throw new Error('Transaction timed out.');
}

// ── On-chain preflight helpers ────────────────────────────────────────────────
// Catch the common revert causes BEFORE creating a Circle transaction.
// Every failure below used to cost real gas + ~100s of polling and came
// back as the generic "Transaction failed onchain." string.

class PreflightError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

function usdc(n: bigint): string {
  return formatUnits(n, 6);
}

async function requireJob(jobId: string | number): Promise<any> {
  try {
    return (await publicClient.readContract({
      address: AGENTIC_COMMERCE_CONTRACT,
      abi: AGENTIC_ABI,
      functionName: 'getJob',
      args: [BigInt(jobId)],
    })) as any;
  } catch (e: any) {
    const notFound = /revert|execution/i.test(e?.message || '');
    throw new PreflightError(
      notFound ? 404 : 502,
      notFound
        ? `Job #${jobId} does not exist on the ERC-8183 contract (${AGENTIC_COMMERCE_CONTRACT}) — check the jobId.`
        : `Could not read job #${jobId} state from Arc Testnet RPC: ${e.message}`
    );
  }
}

async function readUsdcBalance(owner: string): Promise<bigint> {
  return (await publicClient.readContract({
    address: USDC_ARC as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner as `0x${string}`],
  })) as bigint;
}

async function readUsdcAllowance(owner: string, spender: string): Promise<bigint> {
  return (await publicClient.readContract({
    address: USDC_ARC as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner as `0x${string}`, spender as `0x${string}`],
  })) as bigint;
}

// (withPreflight helper removed — the outer jobsHandler catch converts
// PreflightError into a clean JSON response with its own status code.)

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

      if (!ADDR_RE.test(clientSCA) || !ADDR_RE.test(providerSCA)) {
        return NextResponse.json(
          { success: false, error: 'clientSCA and providerSCA must be valid 0x addresses.' },
          { status: 400 }
        );
      }
      if (evaluatorSCA && !ADDR_RE.test(evaluatorSCA)) {
        return NextResponse.json(
          { success: false, error: 'evaluatorSCA must be a valid 0x address.' },
          { status: 400 }
        );
      }
      // Self-hire guard: same policy as POST /api/agents/[id]/hire — rejected outright, not silently discounted (see trustScore.ts)
      if (String(clientSCA).toLowerCase() === String(providerSCA).toLowerCase()) {
        return NextResponse.json({ success: false, error: 'self-hire not allowed: clientSCA and providerSCA cannot be the same address' }, { status: 400 });
      }

      // Provider must be a known FlareHQ wallet (registered agent or consumer)
      // BEFORE the on-chain createJob — the provider address is immutable after
      // creation, so an unknown address would leave the job unserviceable.
      const providerAgent = await (prisma as any).agentRegistry.findFirst({
        where: { scaAddress: { equals: providerSCA, mode: 'insensitive' } },
        select: { id: true, merchantId: true, status: true, circleWalletId: true },
      });
      if (providerAgent) {
        // Serviceability gate (before any chain interaction): the Direct Hire
        // lifecycle is executed BY the provider — setBudget and submit are
        // signed from the provider's Circle wallet (walletAddress: providerSCA
        // on the Circle contract-execution call). A registered agent that is
        // not fully provisioned, or that has no Circle wallet, can never move
        // the job past Open — reject at create instead of minting a dead job.
        // Same status gate as the validated procurement hire path.
        if (providerAgent.status !== 'ACTIVE_AGENT_PROVISIONED') {
          return NextResponse.json(
            {
              success: false,
              error:
                `providerSCA is a registered agent (registry id ${providerAgent.id}) whose status is '${providerAgent.status}', not ACTIVE_AGENT_PROVISIONED — ` +
                `only fully provisioned agents can service a Direct Hire job, because the provider's wallet must sign setBudget and submit on-chain. ` +
                `Hire a provisioned agent or use the procurement flow instead.`,
            },
            { status: 400 }
          );
        }
        if (!providerAgent.circleWalletId) {
          return NextResponse.json(
            {
              success: false,
              error:
                `providerSCA is a registered agent (registry id ${providerAgent.id}) with no Circle wallet — ` +
                `the Direct Hire lifecycle requires the provider's Circle wallet to sign setBudget and submit on-chain, so this job could never progress past Open. ` +
                `Re-provision the agent's wallet before hiring it directly.`,
            },
            { status: 400 }
          );
        }
      }
      let humanProvider: any = null;
      if (!providerAgent) {
        humanProvider = await (prisma as any).consumerAccount.findFirst({
          where: { walletAddress: { equals: providerSCA, mode: 'insensitive' } },
          select: { id: true, telegramUserId: true, circleWalletId: true },
        });
        if (!humanProvider) {
          return NextResponse.json(
            {
              success: false,
              error:
                'providerSCA is not a registered agent or known wallet — the provider must have an account on FlareHQ before being hired directly. Use Post a Job if you want to hire from open applicants instead.',
            },
            { status: 400 }
          );
        }
        // Serviceability gate (same real supported path as the validated
        // procurement hire route): a known wallet without a usable Circle
        // wallet cannot sign provider-side lifecycle calls — reject at create.
        if (!humanProvider.circleWalletId) {
          return NextResponse.json(
            {
              success: false,
              error:
                'providerSCA is a known wallet but has no Circle wallet attached — ' +
                "the Direct Hire lifecycle requires the provider's Circle wallet to sign setBudget and submit on-chain, so this job could never progress past Open. " +
                'The provider must complete wallet onboarding before being hired directly.',
            },
            { status: 400 }
          );
        }
      }

      // The job's client wallet pays the escrow — the caller must control it.
      if (!(await verifyCallerControlsAddress(request as any, clientSCA))) {
        return NextResponse.json(
          { success: false, error: 'You do not control the clientSCA wallet.' },
          { status: 403 }
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

      // Soft warning (non-blocking): the client will need this much USDC at
      // fund time — flag a shortfall now instead of failing three steps later.
      let balanceWarning: string | null = null;
      try {
        const clientBalance = await readUsdcBalance(clientSCA);
        const neededWei = BigInt(Math.round(parseFloat(amountUSDC) * 1_000_000));
        if (clientBalance < neededWei) {
          balanceWarning =
            `Note: client wallet ${clientSCA} currently holds ${usdc(clientBalance)} USDC but the job budget is ${amountUSDC}. ` +
            `Top up before Fund Escrow or funding will fail.`;
        }
      } catch {
        // RPC hiccup — never block creation on a read-only check.
      }

      // Save to Postgres (best-effort legacy mirror — the Direct Hire lifecycle
      // reads on-chain state via requireJob, and granular routes key on
      // Erc8183Job, so this row is not required downstream; the success
      // response below is preserved regardless).
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
        .catch((dbError) => {
          console.error(`[jobs:create] prisma.job.create failed for on-chain job ${String(jobId)}:`, dbError);
        });

      // Best-effort provider notification — never fails an otherwise successful
      // creation. Reuses the existing Telegram hire nudge (same mechanism as
      // jobs/complete + procurement hire) for ConsumerAccount providers with a
      // linked telegramUserId. AgentRegistry providers have no direct Telegram
      // identity, and owner-merchant notify() has no registered job-hire event
      // — so agent notification is skipped with a log. No new channel invented.
      try {
        const hired = humanProvider
          ? humanProvider
          : await (prisma as any).consumerAccount.findFirst({
              where: { walletAddress: { equals: providerSCA, mode: 'insensitive' } },
              select: { telegramUserId: true },
            });
        if (hired?.telegramUserId) {
          const { sendTelegramMessage } = await import('@/lib/telegram/sendTelegramMessage');
          await sendTelegramMessage(
            String(hired.telegramUserId),
            `✅ You've been directly hired for job #${String(jobId)} (${amountUSDC} USDC): "${String(description).slice(0, 80)}".\nNext: set your budget so the client can fund escrow.`
          );
        } else if (providerAgent) {
          console.log(`[jobs:create] agent provider ${providerSCA} (registry id ${String(providerAgent.id)}) hired for job ${String(jobId)} — no job-hire notify event registered for owner merchant ${String(providerAgent.merchantId ?? 'none')}, skipping owner notify.`);
        }
      } catch (e: any) {
        console.error('[jobs:create] provider notification failed:', e?.message ?? String(e));
      }

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
        ...(balanceWarning ? { warning: balanceWarning } : {}),
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

      // setBudget is signed by the provider — the caller must control it.
      if (!(await verifyCallerControlsAddress(request as any, providerSCA))) {
        return NextResponse.json(
          { success: false, error: 'You do not control the providerSCA wallet.' },
          { status: 403 }
        );
      }

      // ── PREFLIGHT: catch revert causes before spending gas.
      const jobForBudget = await requireJob(jobId);
      const onChainProvider = (jobForBudget.provider || '').toLowerCase();
      if (onChainProvider !== providerSCA.toLowerCase()) {
        throw new PreflightError(
          409,
          `providerSCA ${providerSCA} does not match this job's on-chain provider (${onChainProvider}). ` +
            `Budget can only be set from the provider wallet named when the job was created — ` +
            `if you are self-testing, use that same wallet here.`
        );
      }
      if (Number(jobForBudget.status) !== 0) {
        throw new PreflightError(
          409,
          `Job #${jobId} is ${JOB_STATUS_NAMES[Number(jobForBudget.status)] || 'Unknown'}, not Open — ` +
            `budget can only be set while the job is Open.`
        );
      }
      if (Date.now() > Number(jobForBudget.expiredAt) * 1000) {
        throw new PreflightError(400, `Job #${jobId} has expired — no further actions are possible.`);
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

      // approve spends the client's USDC allowance — caller must control it.
      if (!(await verifyCallerControlsAddress(request as any, clientSCA))) {
        return NextResponse.json(
          { success: false, error: 'You do not control the clientSCA wallet.' },
          { status: 403 }
        );
      }

      const amountWei = BigInt(Math.round(parseFloat(amountUSDC) * 1_000_000));

      // ── PREFLIGHT: skip the tx entirely when the allowance already covers
      // the amount (approve is repeatable by ERC-20 design — it just
      // overwrites — but repeating it burns gas for nothing and confused
      // users into thinking it was a state transition).
      let existingAllowance = 0n;
      try {
        existingAllowance = await readUsdcAllowance(clientSCA, AGENTIC_COMMERCE_CONTRACT);
      } catch { /* RPC hiccup — proceed with the approve */ }
      if (existingAllowance >= amountWei) {
        return NextResponse.json({
          success: true,
          action: 'approve',
          jobId,
          amountUSDC,
          clientSCA,
          alreadyApproved: true,
          currentAllowance: usdc(existingAllowance),
          message: `Allowance already covers this budget (${usdc(existingAllowance)} USDC approved) — no new approval transaction needed. Continue to Fund Escrow.`,
          nextStep: `POST /api/jobs { action:'fund', jobId:'${jobId}', clientSCA:'${clientSCA}' }`,
        });
      }

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

      // fund moves the client's escrowed USDC — caller must control it.
      if (!(await verifyCallerControlsAddress(request as any, clientSCA))) {
        return NextResponse.json(
          { success: false, error: 'You do not control the clientSCA wallet.' },
          { status: 403 }
        );
      }

      // ── PREFLIGHT: the escrow's fund() pulls the on-chain budget via
      // transferFrom, so every failure below used to revert on-chain after
      // the fact. Diagnose it up-front instead.
      const jobToFund = await requireJob(jobId);
      const statusName = JOB_STATUS_NAMES[Number(jobToFund.status)] || 'Unknown';
      if ((jobToFund.client || '').toLowerCase() !== clientSCA.toLowerCase()) {
        throw new PreflightError(
          409,
          `clientSCA ${clientSCA} does not match this job's on-chain client (${jobToFund.client}). ` +
            `Funding must come from the wallet that created the job.`
        );
      }
      const budget = BigInt(jobToFund.budget);
      if (budget === 0n) {
        throw new PreflightError(
          409,
          `Budget for job #${jobId} is 0 — Set Budget never succeeded (its tx likely failed). ` +
            `Re-run Set Budget from the PROVIDER wallet first; funding cannot proceed without an on-chain budget.`
        );
      }
      if (Number(jobToFund.status) === 1) {
        throw new PreflightError(409, `Job #${jobId} is already Funded.`);
      }
      if (Number(jobToFund.status) !== 0) {
        throw new PreflightError(409, `Job #${jobId} is ${statusName} — only Open jobs can be funded.`);
      }
      if (Date.now() > Number(jobToFund.expiredAt) * 1000) {
        throw new PreflightError(400, `Job #${jobId} has expired — no further actions are possible.`);
      }

      let clientBalance = 0n;
      try {
        clientBalance = await readUsdcBalance(clientSCA);
      } catch (e: any) {
        throw new PreflightError(502, `Could not read USDC balance from Arc Testnet RPC: ${e.message}`);
      }
      if (clientBalance < budget) {
        throw new PreflightError(
          400,
          `Insufficient USDC in payer wallet ${clientSCA}: has ${usdc(clientBalance)}, needs ${usdc(budget)} for this job's budget. Top up at faucet.circle.com and retry.`
        );
      }
      let allowance = 0n;
      try {
        allowance = await readUsdcAllowance(clientSCA, AGENTIC_COMMERCE_CONTRACT);
      } catch (e: any) {
        throw new PreflightError(502, `Could not read USDC allowance from Arc Testnet RPC: ${e.message}`);
      }
      if (allowance < budget) {
        throw new PreflightError(
          400,
          `USDC allowance too low: ${usdc(allowance)} approved to the escrow contract, needs ${usdc(budget)}. Re-run Approve USDC with at least the full budget amount.`
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

      // submit is signed by the provider — caller must control it.
      if (!(await verifyCallerControlsAddress(request as any, providerSCA))) {
        return NextResponse.json(
          { success: false, error: 'You do not control the providerSCA wallet.' },
          { status: 403 }
        );
      }

      // ── PREFLIGHT
      const jobToSubmit = await requireJob(jobId);
      if ((jobToSubmit.provider || '').toLowerCase() !== providerSCA.toLowerCase()) {
        throw new PreflightError(
          409,
          `providerSCA ${providerSCA} does not match this job's on-chain provider (${jobToSubmit.provider}).`
        );
      }
      if (Number(jobToSubmit.status) === 0) {
        throw new PreflightError(409, `Job #${jobId} is still Open — it must be funded before work can be submitted.`);
      }
      if (Number(jobToSubmit.status) !== 1) {
        throw new PreflightError(409, `Job #${jobId} is ${JOB_STATUS_NAMES[Number(jobToSubmit.status)]} — only Funded jobs can be submitted against.`);
      }
      if (Date.now() > Number(jobToSubmit.expiredAt) * 1000) {
        throw new PreflightError(400, `Job #${jobId} has expired — no further actions are possible.`);
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

      // complete releases the client's escrowed payment — caller must
      // control the client wallet that posted the job.
      if (!(await verifyCallerControlsAddress(request as any, clientSCA))) {
        return NextResponse.json(
          { success: false, error: 'You do not control the clientSCA wallet.' },
          { status: 403 }
        );
      }

      // ── PREFLIGHT
      const jobToComplete = await requireJob(jobId);
      if ((jobToComplete.evaluator || '').toLowerCase() !== clientSCA.toLowerCase()) {
        throw new PreflightError(
          409,
          `This job's evaluator is ${jobToComplete.evaluator} — completion (release) must be signed by the evaluator wallet, not ${clientSCA}.`
        );
      }
      if (Number(jobToComplete.status) === 3) {
        throw new PreflightError(409, `Job #${jobId} is already Completed.`);
      }
      if (Number(jobToComplete.status) !== 2) {
        throw new PreflightError(
          409,
          `Job #${jobId} is ${JOB_STATUS_NAMES[Number(jobToComplete.status)]} — only Submitted jobs can be completed. The provider must submit first.`
        );
      }
      if (Date.now() > Number(jobToComplete.expiredAt) * 1000) {
        throw new PreflightError(400, `Job #${jobId} has expired — no further actions are possible.`);
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

    // All valid actions return above — unreachable, keeps the wrapper's
    // Promise<NextResponse> contract honest.
    return NextResponse.json(
      { success: false, error: `action must be one of: ${validActions.join(', ')}` },
      { status: 400 }
    );
  } catch (error: any) {
    if (error instanceof PreflightError) {
      // Preflight failures are clean, expected rejections — not server errors.
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error('❌ Jobs route error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKeyOrAnySession(jobsHandler);

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

export const GET = withApiKeyOrAnySession(getJobHandler);
export const dynamic = 'force-dynamic';