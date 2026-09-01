// src/lib/wallet/externalProvider.ts
//
// Shared by MetaMask, WalletConnect, and Coinbase Wallet — they're all
// standard EIP-1193 signers, so one implementation backs all three
// `walletProvider` values.
//
// External wallets CANNOT complete server-initiated writes synchronously:
// there is no private key on the server, only an address. Unlike the old
// model (which queued an EIP-191 personal_sign and then FABRICATED a tx hash
// server-side), the supported external-wallet flow is:
//
//   route creates a TRANSACTION request (server-authoritative intent)
//     -> frontend broadcasts the REAL transaction with the connected wallet
//     -> frontend submits the REAL txHash
//     -> server verifies the receipt + on-chain effect before any state change
//
// See signatureQueue.ts / transactionVerification.ts / transactionResume.ts.
//
// These write methods therefore do NOT queue "sign this message" rows — a
// personal_sign cannot move funds. They fail closed; callers must route
// external-wallet writes through the transaction-request flow.

import { WalletProvider, WalletExecutionResult, ContractCallParams, Eip712TypedDataPayload } from "./provider";

export class ExternalWalletProvider implements WalletProvider {
  constructor(
    public readonly kind: string, // "METAMASK" | "WALLETCONNECT" | "COINBASE"
    private merchantId: string,
    private walletAddress: string
  ) {}

  async getAddress(): Promise<string> {
    return this.walletAddress;
  }

  async transferUSDC(_to: string, _amount: string, _memo?: string): Promise<WalletExecutionResult> {
    throw new Error(
      "External-wallet transfers must be broadcast by the connected wallet and verified on-chain. Retry the action so FlareHQ creates a real transaction request."
    );
  }

  async executeContract(_params: ContractCallParams): Promise<WalletExecutionResult> {
    throw new Error(
      "External-wallet contract calls must be broadcast by the connected wallet and verified on-chain. Retry the action so FlareHQ creates a real transaction request."
    );
  }

  async signTypedData(_payload: Eip712TypedDataPayload): Promise<WalletExecutionResult> {
    throw new Error(
      "External-wallet actions require a real wallet transaction, not a typed-data signature. Retry the action so FlareHQ creates a real transaction request."
    );
  }
}
