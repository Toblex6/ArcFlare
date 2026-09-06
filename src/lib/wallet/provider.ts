// src/lib/wallet/provider.ts
//
// The one interface every payment-executing route should call through,
// regardless of whether the merchant is on a Circle-managed wallet or a
// connected external signer (MetaMask, WalletConnect, Coinbase, ...).
//
// The "pending_signature" branch exists from day one, not bolted on later:
// Circle is instant/custodial (always resolves "completed" or "failed").
// External signers require a human to approve in their own wallet, so any
// write action can legitimately return "pending_signature" and the caller
// (an escrow release, a payroll run, a scheduled payment) has to be able to
// pause and resume, not assume synchronous completion.

export type WalletExecutionResult =
  | { status: "completed"; txHash: string }
  | { status: "pending_signature"; requestId: string; signPayload: unknown }
  | { status: "failed"; error: string };

export interface ContractCallParams {
  contractAddress: string;
  abiFunctionSignature: string; // e.g. "transfer(address,uint256)"
  args: unknown[];
}

export interface Eip712TypedDataPayload {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface WalletProvider {
  /** Stable identifier — matches Merchant.walletProvider, e.g. "CIRCLE", "METAMASK". */
  readonly kind: string;

  getAddress(): Promise<string>;

  transferUSDC(to: string, amount: string, memo?: string): Promise<WalletExecutionResult>;

  /**
   * Phase 2C multicurrency: move the caller's canonical token (USDC or EURC)
   * instead of hardcoded USDC. `tokenAddress` MUST be a supported token
   * (resolve via resolveCurrency before calling); `decimals` MUST come from
   * the same resolution. Implementations must never convert — USDC means
   * USDC, EURC means EURC. transferUSDC remains as the USDC-default wrapper.
   */
  transferToken(to: string, amount: string, tokenAddress: string, decimals: number, memo?: string): Promise<WalletExecutionResult>;

  executeContract(params: ContractCallParams): Promise<WalletExecutionResult>;

  signTypedData(payload: Eip712TypedDataPayload): Promise<WalletExecutionResult>;
}
