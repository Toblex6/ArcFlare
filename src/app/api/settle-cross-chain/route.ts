import { NextResponse } from 'next/server';
import { createWalletClient, http, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { resolveRowCurrency } from '@/src/lib/tokens/resolveCurrency';
import { getArcChain, getNetworkConfig } from '@/lib/config/network';

// Circle Iris API + Arc chain flow from the authoritative network config
// (were hardcoded sandbox URL + testnet chain literal). Mainnet without
// ARC_MAINNET_CCTP_IRIS_URL fails closed at call time.
function circleIrisApi(): string {
  return `${getNetworkConfig().irisApiUrl.replace(/\/v2\/?$/, '')}/v1/attestations`;
}

// Explicitly defining the Arc chain for Viem to satisfy type matrix conditions
const arcTestnet = getArcChain() as any;

// Minimal ABI snippet required to call Circle's MessageTransmitter on target chain
const TRANSMITTER_ABI = [
  {
    name: 'receiveMessage',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'message', type: 'bytes' },
      { name: 'attestation', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

// Internal-service-only: this endpoint fires real CCTP attestation
// redemption transactions with the admin key and mutates payment rows,
// so it must NOT be callable by the public web (it was previously
// completely unauthenticated). Callers must present an ACTIVE internal
// service API key (the same pool the settle route's internal bypass
// uses), and the key is checked against the DB rather than env.
async function isInternalServiceCall(request: Request) {
  const key = request.headers.get('x-api-key');
  if (!key) return false;
  const record = await (prisma as any).apiKey.findUnique({ where: { key } });
  return !!record && record.active === true;
}

export async function POST(request: Request) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(request as any, 'payments');
    if (!allowed) return limitResponse;

    if (!(await isInternalServiceCall(request))) {
      return NextResponse.json(
        { success: false, error: 'Internal service endpoint. Active API key required.' },
        { status: 401 }
      );
    }

    // 1. Ingest payment reference, target hash, and raw source event message bytes
    const { reference, messageHash, rawMessage } = await request.json();

    if (!reference || !messageHash || !rawMessage) {
      return NextResponse.json(
        {
          success: false,
          error: 'Missing parameters: reference, messageHash, and rawMessage are all required.',
        },
        { status: 400 }
      );
    }

    // 1b. EURC SAFETY GATE (Phase 1). Resolve the referenced payment row's
    // token identity FROM THE DB — never from a client-supplied override (the
    // request body carries no currency field and we never read one). This CCTP
    // redemption mints USDC only, so an EURC-labelled row must be rejected
    // BEFORE any settlement/mint work.
    const paymentRow = await prisma.paymentLog.findUnique({ where: { reference } });
    if (!paymentRow) {
      return NextResponse.json({ success: false, error: 'Payment reference not found.' }, { status: 404 });
    }
    let rowToken: { symbol: 'USDC' | 'EURC' };
    try {
      rowToken = resolveRowCurrency(paymentRow);
    } catch {
      return NextResponse.json(
        {
          success: false,
          error:
            'Unsupported or mismatched token identity on this payment row. This cross-chain settle route is USDC-only; EURC is coming in Phase 2.',
        },
        { status: 400 }
      );
    }
    if (rowToken.symbol !== 'USDC') {
      return NextResponse.json(
        {
          success: false,
          error:
            'EURC settlement is not yet supported. This cross-chain settle route is USDC-only; EURC is coming in Phase 2.',
        },
        { status: 400 }
      );
    }

    // 2. Transition database row state using your exact lowercase 'paymentLog' model
    await prisma.paymentLog.update({
      where: { reference },
      data: { status: 'POLLING_CIRCLE_TESTNET_IRIS_API' },
    });

    let attestationBytes = '';
    let attempts = 0;
    const maxAttempts = 30; // 5 minutes of polling headroom (10s intervals)

    // 3. Poll Circle's Attestation Matrix until signatures compile
    while (attempts < maxAttempts) {
      console.log(`Polling Iris API for Message Hash: ${messageHash} (Attempt ${attempts + 1})`);

      const irisResponse = await fetch(`${circleIrisApi()}/${messageHash}`);

      if (irisResponse.ok) {
        const data = await irisResponse.json();
        if (data.status === 'complete' && data.attestation) {
          attestationBytes = data.attestation;
          break; // Proof signature captured successfully!
        }
      }

      attempts++;
      await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds between iterations
    }

    if (!attestationBytes) {
      throw new Error(
        'Circle CCTP attestation timeline exceeded without returning a valid signature payload.'
      );
    }

    // 4. Extract admin key injected by Render environment configuration
    const privateKey = process.env.ARC_ADMIN_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error(
        'ARC_ADMIN_PRIVATE_KEY context is missing inside active production runtime variables.'
      );
    }

    const account = privateKeyToAccount(privateKey as `0x${string}`);

    // 5. Initialize WalletClient with explicit chain binding to satisfy Viem type rules
    const client = createWalletClient({
      account,
      chain: arcTestnet,
      transport: http(getNetworkConfig().primaryRpc),
    }).extend(publicActions);

    console.log('Broadcasting verification payload to Arc Message Transmitter contract...');

    // Execute contract interaction using administrative gas allowance
    // (transmitter address from the authoritative network config).
    const txHash = await client.writeContract({
      address: getNetworkConfig().cctpMessageTransmitter as `0x${string}`,
      chain: arcTestnet,
      abi: TRANSMITTER_ABI,
      functionName: 'receiveMessage',
      args: [rawMessage as `0x${string}`, attestationBytes as `0x${string}`],
    });

    // 6. Await block finalization via the Malachite consensus engine
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status !== 'success') {
      throw new Error('Arc L1 consensus engine reverted the mint execution payload.');
    }

    // 7. Commit definitive completion telemetry and store the on-chain hash
    const completedTx = await prisma.paymentLog.update({
      where: { reference },
      data: {
        status: 'REDEEMED_AND_MINTED',
        arcTxHash: txHash,
      },
    });

    return NextResponse.json({ success: true, transaction: completedTx });
  } catch (error: any) {
    console.error('Cross-chain routing core exception:', error);

    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to parse cross-chain settlement pipeline parameters.',
      },
      { status: 500 }
    );
  }
}
