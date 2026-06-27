// src/app/api/x402/pay/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKey } from "@/lib/middleware/withApiKey";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";

const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";

const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
} as const;

function buildAuthorizationTypedData(params: {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}) {
  return {
    domain: {
      name: "USDC",                // ✅ Arc Testnet USDC
      version: "2",
      chainId: 5042002,
      verifyingContract: ARC_TESTNET_USDC as `0x${string}`,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization" as const,
    message: params,
  };
}

function randomNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

async function payWithEoaHandler(request: Request) {
  try {
    const { resourceUrl, eoaAddress } = await request.json();

    if (!resourceUrl || !eoaAddress) {
      return NextResponse.json(
        { success: false, error: "resourceUrl and eoaAddress are required." },
        { status: 400 }
      );
    }

    const walletRecord = await prisma.x402EoaWallet.findUnique({ where: { address: eoaAddress } });
    if (!walletRecord) {
      return NextResponse.json(
        { success: false, error: `No stored EOA wallet for ${eoaAddress}.` },
        { status: 404 }
      );
    }

    const account = privateKeyToAccount(walletRecord.privateKey as `0x${string}`);
    const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http("https://rpc.testnet.arc.network") });

    // 1. Probe the resource
    const probeRes = await fetch(resourceUrl, { method: "POST" });

    if (probeRes.status !== 402) {
      return NextResponse.json(
        { success: false, error: `Expected 402, got ${probeRes.status}` },
        { status: 502 }
      );
    }

    // 2. Read PAYMENT-REQUIRED header
    const paymentRequiredHeader = probeRes.headers.get("payment-required");
    if (!paymentRequiredHeader) {
      return NextResponse.json(
        { success: false, error: "Missing PAYMENT-REQUIRED header." },
        { status: 502 }
      );
    }

    let paymentRequirements;
    try {
      const decoded = Buffer.from(paymentRequiredHeader, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);
      paymentRequirements = parsed.accepts?.[0];
    } catch (e) {
      return NextResponse.json(
        { success: false, error: "Failed to parse PAYMENT-REQUIRED header." },
        { status: 502 }
      );
    }

    if (!paymentRequirements) {
      return NextResponse.json(
        { success: false, error: "No payment requirements found in PAYMENT-REQUIRED header." },
        { status: 502 }
      );
    }

    // 3. Sign authorization
    const now = Math.floor(Date.now() / 1000);
    const authParams = {
      from: account.address,
      to: paymentRequirements.payTo as `0x${string}`,
      value: paymentRequirements.amount,
      validAfter: now.toString(),
      validBefore: (now + 300).toString(),
      nonce: randomNonce(),
    };

    const typedData = buildAuthorizationTypedData(authParams);
    const signature = await walletClient.signTypedData({
      account,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });

    // 4. Build and encode payment payload
    const paymentPayload = {
      x402Version: 2,
      payload: { authorization: authParams, signature },
      accepted: paymentRequirements,
      resource: { url: resourceUrl },
    };

    const encodedSignature = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

    // 5. Retry request with signed header
    const payRes = await fetch(resourceUrl, {
      method: "POST",
      headers: { "payment-signature": encodedSignature },
    });

    const payData = await payRes.json();

    if (!payRes.ok) {
      return NextResponse.json(
        { success: false, error: "Payment rejected.", details: payData },
        { status: payRes.status }
      );
    }

    return NextResponse.json({
      success: true,
      paidWith: account.address,
      amountUSDC: (parseInt(paymentRequirements.amount) / 1_000_000).toFixed(6),
      resourceData: payData,
      message: `Paid ${(parseInt(paymentRequirements.amount) / 1_000_000).toFixed(6)} USDC for ${resourceUrl}`,
    });
  } catch (error: any) {
    console.error("❌ x402 payment error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(payWithEoaHandler);