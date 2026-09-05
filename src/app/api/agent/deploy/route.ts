// /api/agent/deploy/route.ts
import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { createPublicClient, http, parseAbiItem, decodeEventLog } from 'viem';
import { arcTestnet } from 'viem/chains';
import { withMerchantAuth, AuthedMerchant } from '@/src/lib/middleware/withMerchantAuth';
import {
  checkAgentDeployAllowed,
  releaseAgentDeployClaim,
  normalizeAgentDeployIdempotencyKey,
} from '@/src/lib/agent-deploy-guard';

const prisma = new PrismaClient();

// Use environment variable with a fallback for local testing
const IDENTITY_REGISTRY =
  process.env.IDENTITY_REGISTRY_ADDRESS || '0x8004A818BFB912233c491871b3d84c89A494BD9e';

// ─── Internal Route Handler Logic ─────────────────────────────────────────────
async function deployAgentHandler(request: Request, merchant: AuthedMerchant) {
  try {
    const body = await request.json().catch(() => ({}));
    const metadataUri =
      body.metadataUri || 'ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei';
    const agentName = body.agentName || 'FlareHQ Autonomous Agent';
    const ownerNode = body.ownerNode || '0xAgenticNodeOperatorDefaultAddress';
    // Gap A fix: populate skills/pricing/description from existing supported input
    // Accepts body.skills (string[] or {name,description}[]), body.pricing ({pricePerRequest|pricePerJob}), body.description
    let skillsInput: any = body.skills ?? body.capabilities ?? null;
    let pricingInput: any = body.pricing ?? null;
    let descriptionInput: string | null = typeof body.description === 'string' ? body.description : null;
    // Normalize skills to array of strings/objects
    if (skillsInput && !Array.isArray(skillsInput)) skillsInput = [skillsInput];
    if (pricingInput && typeof pricingInput === 'string') {
      try { pricingInput = JSON.parse(pricingInput); } catch { pricingInput = { pricePerRequest: pricingInput }; }
    }
    // Infer pricePerRequest if not provided but pricePerJob exists elsewhere
    if (body.pricePerRequest && !pricingInput) pricingInput = { pricePerRequest: body.pricePerRequest };
    if (body.pricePerJob && !pricingInput) pricingInput = { pricePerJob: body.pricePerJob };

    // 0. Cost-control gate (SUBTASK F): keyed by the AUTHORITATIVE merchant id
    // resolved by withMerchantAuth — never client-supplied merchantId. Runs
    // BEFORE any Circle wallet provisioning or on-chain register so a flood
    // cannot mint wallets or burn gas. 10/min per merchant, keyless burst
    // throttle, replayed idempotency keys → 409, budget exhausted → 429.
    // No "max 1 agent" cap: distinct idempotency keys always allow legitimate
    // repeated deployment (multiple agents per merchant) up to the budget.
    const idempotencyKey =
      typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : undefined;
    // Normalized form persisted on the deploy-intent row (same convention as the
    // guard: trim + 120-char cap). The DB-level uniqueness below complements the
    // guard's in-memory claim across instances/restarts.
    const normalizedIdempotencyKey = idempotencyKey
      ? normalizeAgentDeployIdempotencyKey(idempotencyKey)
      : undefined;
    const deployGate = checkAgentDeployAllowed(merchant.id, idempotencyKey);
    if (!deployGate.allowed) {
      if (deployGate.reason === 'duplicate') {
        // Same-instance replay of an in-progress/completed deploy. Surface the
        // underlying intent when present so a PENDING registration points the
        // merchant at recovery instead of a dead-end 409.
        let replayBody: Record<string, unknown> = {
          error: 'Duplicate agent deploy — replay of an in-progress request.',
          replayed: true,
        };
        if (normalizedIdempotencyKey) {
          const existingIntent = await (prisma as any).agentDeployIntent
            .findFirst({
              where: { merchantId: merchant.id, idempotencyKey: normalizedIdempotencyKey },
              select: { status: true, registerTxHash: true },
            })
            .catch(() => null);
          if (existingIntent?.registerTxHash) replayBody.txHash = existingIntent.registerTxHash;
          if (existingIntent?.status === 'PENDING_IDENTITY_CONFIRMATION') {
            replayBody.error =
              'Duplicate agent deploy — this idempotency key has a pending on-chain registration. Recover it via POST /api/agent/deploy/recover with the txHash.';
            replayBody.hint = 'POST /api/agent/deploy/recover';
          }
        }
        return NextResponse.json(replayBody, { status: 409 });
      }
      return NextResponse.json(
        {
          error:
            deployGate.reason === 'unauthenticated'
              ? 'Merchant identity could not be resolved for deploy throttling.'
              : 'Agent deploy throttled — slow down and retry.',
          retryAfterMs: deployGate.retryAfterMs ?? null,
        },
        {
          status: 429,
          headers: deployGate.retryAfterMs
            ? { 'Retry-After': String(Math.ceil(deployGate.retryAfterMs / 1000)) }
            : undefined,
        }
      );
    }

    // 0b. DB-level idempotency backstop (the guard above is in-memory, so two
    // concurrent instances / a restart can both pass it for the same key). A
    // persisted intent proves this key already progressed past wallet
    // provisioning — refuse BEFORE creating another Circle wallet set. This is
    // the deploy-side half of "no second wallet set / no duplicate register";
    // the recovery endpoint never provisions anything.
    if (normalizedIdempotencyKey) {
      const existingIntent = await (prisma as any).agentDeployIntent.findFirst({
        where: { merchantId: merchant.id, idempotencyKey: normalizedIdempotencyKey },
        select: { id: true, status: true, registerTxHash: true },
      });
      if (existingIntent) {
        const replayBody: Record<string, unknown> = {
          error:
            existingIntent.status === 'COMPLETED'
              ? 'Duplicate agent deploy — this idempotency key already completed.'
              : 'Duplicate agent deploy — replay of an in-progress request.',
          replayed: true,
        };
        if (existingIntent.registerTxHash) replayBody.txHash = existingIntent.registerTxHash;
        return NextResponse.json(replayBody, { status: 409 });
      }
    }

    // 1. Initialize Circle Client
    if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET) {
      // Terminal failure BEFORE any wallet or on-chain side effect — free the
      // claim so the client can retry with the same idempotency key.
      releaseAgentDeployClaim(merchant.id, idempotencyKey);
      throw new Error('Circle infrastructure variables missing from environment configurations.');
    }
    const circleClient = initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY!,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
    });

    // 2. Provision Wallet Set
    const walletSet = await circleClient.createWalletSet({
      name: `${agentName} Wallet Set`,
    });

    const walletSetId = walletSet.data?.walletSet?.id;
    if (!walletSetId) {
      // No wallets or on-chain side effects yet — free the idempotency claim
      // so a retry with the same key is not treated as a replay.
      releaseAgentDeployClaim(merchant.id, idempotencyKey);
      return NextResponse.json(
        { error: 'Failed to initialize Circle Wallet Set' },
        { status: 500 }
      );
    }

    // 3. Create SCA Wallets
    const walletsResponse = await circleClient.createWallets({
      blockchains: ['ARC-TESTNET' as any],
      count: 2,
      walletSetId: walletSetId,
      accountType: 'SCA',
    });

    const ownerWallet = walletsResponse.data?.wallets?.[0];
    const validatorWallet = walletsResponse.data?.wallets?.[1];

    if (!ownerWallet || !validatorWallet || !ownerWallet.address) {
      // Wallets may have been provisioned but none is usable; nothing moved
      // on-chain. Free the claim so a retry with the same key is possible
      // (retry provisions a fresh wallet set — pre-existing behavior).
      releaseAgentDeployClaim(merchant.id, idempotencyKey);
      return NextResponse.json({ error: 'Failed to provision SCA wallets' }, { status: 500 });
    }

    // 3.5 Persist the SERVER-SIDE DEPLOY INTENT BEFORE the on-chain register.
    // Every field is server-derived (authenticated merchantId + the Circle
    // responses above) — never client-supplied. This is the authoritative
    // merchant → wallet-set → SCA binding that lets /api/agent/deploy/recover
    // later prove ownership of an orphaned registration WITHOUT trusting a
    // client-supplied walletSetId/ownerAddress/tokenId and WITHOUT weakening
    // getCallerControlledAddresses(). The row stays recoverable even if the
    // register response is lost or token extraction later fails.
    let deployIntentId: string;
    try {
      const deployIntent = await (prisma as any).agentDeployIntent.create({
        data: {
          merchantId: merchant.id,
          walletSetId: walletSetId,
          ownerSca: ownerWallet.address,
          validatorSca: validatorWallet.address,
          circleWalletId: ownerWallet.id ?? null,
          ...(normalizedIdempotencyKey
            ? { idempotencyKey: normalizedIdempotencyKey }
            : {}),
          status: 'PROVISIONING',
        },
      });
      deployIntentId = deployIntent.id;
    } catch (e: any) {
      if (e?.code === 'P2002') {
        // A concurrent instance created the intent first (the guard is
        // in-memory) — refuse rather than provision a second wallet set.
        return NextResponse.json(
          { error: 'Duplicate agent deploy — replay of an in-progress request.', replayed: true },
          { status: 409 }
        );
      }
      throw e;
    }
    const markIntent = (patch: Record<string, unknown>) =>
      (prisma as any).agentDeployIntent
        .update({ where: { id: deployIntentId }, data: patch })
        .catch(() => {});

    // 4. Register identity via Contract Execution using Circle's SDK engine
    const registerTx = await circleClient.createContractExecutionTransaction({
      walletAddress: ownerWallet.address!,
      blockchain: 'ARC-TESTNET' as any,
      contractAddress: IDENTITY_REGISTRY as `0x${string}`,
      abiFunctionSignature: 'register(string)',
      abiParameters: [metadataUri],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    const txId = registerTx.data?.id;
    if (!txId) {
      // Circle never accepted a registration for this intent — no on-chain tx
      // exists to recover, so the intent is terminal (still safely preserved,
      // never re-provisioned by a same-key retry).
      await markIntent({ status: 'FAILED' });
      return NextResponse.json(
        { error: 'Identity registration failed to initiate' },
        { status: 500 }
      );
    }

    // 5. Polling Circle for Completion
    let txHash: string | undefined;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const { data } = await circleClient.getTransaction({ id: txId });

      if (data?.transaction?.state === 'COMPLETE') {
        txHash = data.transaction.txHash;
        break;
      }
      if (data?.transaction?.state === 'FAILED') {
        // On-chain revert is terminal: no identity was minted to recover.
        await markIntent({
          status: 'FAILED',
          ...(data.transaction.txHash
            ? { registerTxHash: data.transaction.txHash }
            : {}),
        });
        return NextResponse.json({ error: 'On-chain registration reverted' }, { status: 502 });
      }
    }

    if (!txHash) {
      return NextResponse.json({ error: 'Transaction polling timed out' }, { status: 408 });
    }

    // 5b. Circle confirmed the on-chain register: bind the txHash to the intent
    // now (before token extraction) so a later extraction failure leaves a fully
    // recoverable PENDING intent instead of an anonymous orphan.
    await markIntent({ registerTxHash: txHash });

    // 6. Indexing via Viem — recover the REAL ERC-8004 tokenId minted by THIS tx.
    // Failure modes handled here: Transfer log parse errors, receipt absence, and RPC
    // flakiness (endpoints are intermittently out-of-sync — retry, don't assume failure).
    // NEVER synthesize a fallback identity: persisting a fake tokenId as ACTIVE would
    // violate real ERC-8004 identity meaning (id vs tokenId vs scaAddress are NOT
    // interchangeable), so a missing log yields a truthful pending state, not ACTIVE.
    const publicClient = createPublicClient({
      chain: arcTestnet,
      transport: http(),
    });

    const transferEvent = parseAbiItem(
      'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
    );
    const registryAddress = (IDENTITY_REGISTRY as string).toLowerCase();
    const ownerAddress = (ownerWallet.address as string).toLowerCase();
    const txHashLower = (txHash as string).toLowerCase();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    let tokenId: string | null = null;
    for (let attempt = 1; attempt <= 3 && !tokenId; attempt++) {
      try {
        // (a) Precise path: parse THIS tx's receipt — ties the tokenId to our register() call.
        // Receipt may be absent while RPC nodes are out of sync → retry, don't assume failure.
        const receipt = await publicClient.getTransactionReceipt({
          hash: txHash as `0x${string}`,
        });
        if (receipt) {
          for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== registryAddress) continue;
            let decoded: { args?: { to?: string; tokenId?: bigint } };
            try {
              decoded = decodeEventLog({
                abi: [transferEvent],
                data: log.data,
                topics: log.topics as any,
              }) as any;
            } catch {
              continue; // Not a Transfer log — keep scanning.
            }
            if (
              decoded.args?.to?.toLowerCase() === ownerAddress &&
              decoded.args.tokenId != null
            ) {
              tokenId = decoded.args.tokenId.toString();
              break;
            }
          }
          if (tokenId) break;
        }
        // (b) Fallback path: windowed log search for nodes that serve logs but not receipts.
        // Prefer logs from OUR txHash so we never attribute someone else's mint.
        const latestBlock = await publicClient.getBlockNumber();
        const searchWindow = BigInt(500);
        const fromBlock = latestBlock > searchWindow ? latestBlock - searchWindow : BigInt(0);

        const transferLogs = await publicClient.getLogs({
          address: IDENTITY_REGISTRY as `0x${string}`,
          event: transferEvent,
          args: { to: ownerWallet.address as `0x${string}` },
          fromBlock,
          toBlock: latestBlock,
        });
        const ownLogs = transferLogs.filter(
          (l) => (l.transactionHash ?? '').toLowerCase() === txHashLower
        );
        const pool = ownLogs.length > 0 ? ownLogs : transferLogs;
        if (pool.length > 0 && pool[pool.length - 1].args.tokenId != null) {
          tokenId = pool[pool.length - 1].args.tokenId!.toString();
        }
      } catch {
        // Transient RPC failure (TLS bad-record-MAC, ECONNRESET, out-of-sync node) — retry below.
      }
      if (!tokenId && attempt < 3) await sleep(1500 * attempt);
    }

    if (!tokenId) {
      // Truthful pending state: on-chain register() confirmed (txHash exists) but the
      // Transfer log could not be recovered, so the real tokenId is UNKNOWN.
      // - Do NOT persist an AgentRegistry row: any placeholder would be a fake ERC-8004
      //   identity, and the agent must NOT be marked ACTIVE/provisioned.
      // - Do NOT delete the Circle wallets: they are preserved for operator retry/recovery.
      // - The deploy intent stays recoverable: POST /api/agent/deploy/recover can later
      //   prove this merchant owns this wallet set + SCA and persist the real identity.
      // - Surface txHash + inspection info so the operator can retry or inspect on explorer.
      // - Retry-safe: nothing was written, so a retry can never collide on a fake tokenId
      //   (@unique) and never orphans wallet references.
      await markIntent({ status: 'PENDING_IDENTITY_CONFIRMATION' });
      return NextResponse.json(
        {
          error:
            'Identity Transfer log not recovered — agent NOT provisioned. On-chain registration may have succeeded; inspect txHash and retry.',
          status: 'PENDING_IDENTITY_CONFIRMATION',
          retryable: true,
          txHash,
          explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
          wallets: {
            owner: ownerWallet.address,
            validator: validatorWallet.address,
          },
          registry: IDENTITY_REGISTRY,
          ownerAddress: ownerWallet.address,
          hint: 'Re-run POST /api/agent/deploy or inspect the tx receipt Transfer logs to recover the real tokenId; no fallback identity was persisted and no wallet was deleted.',
        },
        { status: 502 }
      );
    }

    // 7. ✅ PERSIST DATA: reachable ONLY with a real on-chain tokenId recovered above.
    // Explicit escape hatch used here to bypass cached client types
    let registeredAgent: any;
    try {
      registeredAgent = await (prisma as any).agentRegistry.create({
        data: {
          name: agentName,
          tokenId: tokenId,
          scaAddress: ownerWallet.address,
          circleWalletId: ownerWallet.id,
          walletSetId: walletSetId,
          validatorSca: validatorWallet.address,
          ownerNode: ownerNode,
          metadataURI: metadataUri,
          status: 'ACTIVE_AGENT_PROVISIONED',
          merchantId: merchant.id,
          ...(descriptionInput ? { description: descriptionInput } : {}),
          ...(skillsInput ? { skills: skillsInput } : {}),
          ...(pricingInput ? { pricing: pricingInput } : {}),
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        // A concurrent recovery/deploy already persisted this identity
        // (@unique tokenId / scaAddress) — return the existing row if it is
        // this merchant's, never a duplicate.
        const after = await (prisma as any).agentRegistry.findFirst({
          where: {
            OR: [{ tokenId: tokenId }, { scaAddress: ownerWallet.address }],
          },
        });
        if (after && (!after.merchantId || after.merchantId === merchant.id)) {
          await markIntent({ status: 'COMPLETED' });
          return NextResponse.json({
            success: true,
            replayed: true,
            agent: after,
            txHash,
            explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
            wallets: {
              owner: ownerWallet.address,
              validator: validatorWallet.address,
            },
          });
        }
        return NextResponse.json(
          { error: 'This ERC-8004 identity was already claimed by another merchant.' },
          { status: 409 }
        );
      }
      throw e;
    }
    await markIntent({ status: 'COMPLETED' });

    return NextResponse.json({
      success: true,
      agent: registeredAgent,
      txHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      wallets: {
        owner: ownerWallet.address,
        validator: validatorWallet.address,
      },
    });
  } catch (error: any) {
    console.error('❌ API Error [FlareHQ Deploy]:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}

// ─── Protected Export Gateway ──────────────────────────────────────────────────
// Wraps your advanced deployment logic safely within your API key middleware
export const POST = withMerchantAuth(deployAgentHandler as any);
