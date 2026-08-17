// src/lib/wallet/circleProvider.ts
//
// Wraps the existing, already-working circle/client.ts logic — no behavior
// change for any merchant currently on a Circle wallet. Circle is custodial,
// so every action here resolves "completed" or "failed", never
// "pending_signature" — there's no human to wait on.

import { createContractTransaction } from "@/lib/circle/client";
import { WalletProvider, WalletExecutionResult, ContractCallParams, Eip712TypedDataPayload } from "./provider";
import { getUsdcAddress } from "@/lib/tokens/supportedTokens";

const USDC_CONTRACT = getUsdcAddress(); // Arc Testnet USDC (ERC-20 interface) — centralized in supportedTokens.ts

export class CircleWalletProvider implements WalletProvider {
  readonly kind = "CIRCLE";

  constructor(private walletAddress: string) {}

  async getAddress(): Promise<string> {
    return this.walletAddress;
  }

  async transferUSDC(to: string, amount: string, memo?: string): Promise<WalletExecutionResult> {
    try {
      const amountUnits = Math.round(parseFloat(amount) * 1_000_000).toString(); // USDC has 6 decimals
      const txHash = await createContractTransaction(
        this.walletAddress,
        USDC_CONTRACT,
        "transfer(address,uint256)",
        [to, amountUnits],
        memo || "USDC transfer"
      );
      return { status: "completed", txHash };
    } catch (err: any) {
      return { status: "failed", error: err.message };
    }
  }

  async executeContract(params: ContractCallParams): Promise<WalletExecutionResult> {
    try {
      const txHash = await createContractTransaction(
        this.walletAddress,
        params.contractAddress,
        params.abiFunctionSignature,
        params.args,
        params.abiFunctionSignature
      );
      return { status: "completed", txHash };
    } catch (err: any) {
      return { status: "failed", error: err.message };
    }
  }

  async signTypedData(_payload: Eip712TypedDataPayload): Promise<WalletExecutionResult> {
    // Circle wallets don't do client-side EIP-712 signing in this codebase's
    // current usage (that's specific to external-signer flows like x402's
    // EOA requirement) — nothing calls this today, present for interface
    // completeness. Fails clearly rather than pretending to support it.
    return { status: "failed", error: "CircleWalletProvider does not support signTypedData." };
  }
}
