// src/app/api/x402/seller/balance/route.ts
//
// Seller Gateway balance check — REBUILT to match the exact pattern from
// circlefin/arc-nanopayments's real production route (confirmed from the
// actual repo code you provided), not a guessed implementation.
//
// Calls Circle's Gateway API directly by domain, exactly as the reference
// app does, with the same balance-parsing logic (handles both decimal
// string and atomic-unit responses).

import { NextResponse } from "next/server";
import { formatUnits } from "viem";
import { withApiKeyOrMerchant } from "@/lib/middleware/withMerchantAuth";

const GATEWAY_API = "https://gateway-api-testnet.circle.com/v1/balances";
const ARC_TESTNET_DOMAIN = 26; // confirmed from CHAIN_CONFIGS / GATEWAY_DOMAINS earlier

async function getWalletUsdcBalance(address: `0x${string}`): Promise<string> {
  // Reads the wallet's raw USDC balance onchain (separate from Gateway balance)
  const { createPublicClient, http } = await import("viem");
  const arcTestnet = {
    id: 5042002,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  } as const;

  const client = createPublicClient({ chain: arcTestnet, transport: http("https://rpc.testnet.arc.network") });

  const balance = await client.readContract({
    address: "0x3600000000000000000000000000000000000000",
    abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf",
    args: [address],
  }) as bigint;

  return formatUnits(balance, 6);
}

async function getBalanceHandler(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("sellerAddress") || process.env.SELLER_WALLET_ADDRESS;

  if (!address) {
    return NextResponse.json({ error: "sellerAddress not provided and SELLER_WALLET_ADDRESS not configured" }, { status: 500 });
  }

  const sellerAddress = address as `0x${string}`;

  try {
    const [gatewayResponse, walletBalance] = await Promise.all([
      fetch(GATEWAY_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          token: "USDC",
          sources: [{ domain: ARC_TESTNET_DOMAIN, depositor: sellerAddress }],
        }),
      }),
      getWalletUsdcBalance(sellerAddress),
    ]);

    if (!gatewayResponse.ok) {
      const text = await gatewayResponse.text();
      console.error("Gateway API error:", gatewayResponse.status, text);
      return NextResponse.json({
        wallet: { balance: walletBalance },
        gateway: { total: "0", available: "0", withdrawing: "0", withdrawable: "0" },
      });
    }

    const data = await gatewayResponse.json();
    const bal = data.balances?.find((b: { domain: number }) => b.domain === ARC_TESTNET_DOMAIN);

    const raw = bal?.balance ?? "0";
    const withdrawingRaw = bal?.withdrawing ?? "0";
    const withdrawableRaw = bal?.withdrawable ?? "0";

    // Gateway API may return balance as decimal string or atomic units —
    // same dual-format handling as the real reference app.
    const parse = (v: string) => (v.includes(".") ? v : formatUnits(BigInt(v), 6));

    const available = parse(raw);
    const withdrawing = parse(withdrawingRaw);
    const withdrawable = parse(withdrawableRaw);
    const total = (parseFloat(available) + parseFloat(withdrawing)).toFixed(6);

    return NextResponse.json({
      wallet: { balance: walletBalance },
      gateway: { total, available, withdrawing, withdrawable },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Balance fetch error:", message);
    return NextResponse.json({
      wallet: { balance: "0" },
      gateway: { total: "0", available: "0", withdrawing: "0", withdrawable: "0" },
    });
  }
}

export const GET = withApiKeyOrMerchant(getBalanceHandler);