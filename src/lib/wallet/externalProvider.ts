// src/lib/wallet/externalProvider.ts
//
// Shared by MetaMask, WalletConnect, and Coinbase Wallet — they're all
// standard EIP-1193 signers, so one implementation backs all three
// `walletProvider` values. Safe (multisig) and Delegated Session will need
// their own classes later (different signing/quorum logic entirely), which
// is exactly why `kind` stays a distinct value per brand even though the
// implementation is shared today — swapping one of them out later doesn't
// touch this file or the interface.
//
// Every write action here can't complete synchronously — there's no private
// key on the server, only an address. So every action creates a
// WalletSignatureRequest and returns "pending_signature"; the actual
// completion happens when the connected wallet posts its signed payload
// back to /api/merchant/wallet/sign-requests/[id].

import { prisma } from "@/lib/prisma";
import { WalletProvider, WalletExecutionResult, ContractCallParams, Eip712TypedDataPayload } from "./provider";

const SIGNATURE_REQUEST_TTL_MS = 15 * 60 * 1000; // 15 minutes to approve

export class ExternalWalletProvider implements WalletProvider {
  constructor(
    public readonly kind: string, // "METAMASK" | "WALLETCONNECT" | "COINBASE"
    private merchantId: string,
    private walletAddress: string
  ) {}

  async getAddress(): Promise<string> {
    return this.walletAddress;
  }

  private async queueSignatureRequest(
    action: string,
    actionRefId: string,
    payload: unknown
  ): Promise<WalletExecutionResult> {
    const request = await (prisma as any).walletSignatureRequest.create({
      data: {
        merchantId: this.merchantId,
        action,
        actionRefId,
        payload: payload as any,
        expiresAt: new Date(Date.now() + SIGNATURE_REQUEST_TTL_MS),
      },
    });
    return { status: "pending_signature", requestId: request.id, signPayload: payload };
  }

  async transferUSDC(to: string, amount: string, memo?: string): Promise<WalletExecutionResult> {
    return this.queueSignatureRequest("wallet.transferUSDC", `${to}:${amount}`, {
      to,
      amount,
      memo: memo || null,
      from: this.walletAddress,
    });
  }

  async executeContract(params: ContractCallParams): Promise<WalletExecutionResult> {
    return this.queueSignatureRequest("wallet.executeContract", params.contractAddress, params);
  }

  async signTypedData(payload: Eip712TypedDataPayload): Promise<WalletExecutionResult> {
    return this.queueSignatureRequest("wallet.signTypedData", payload.primaryType, payload);
  }
}
