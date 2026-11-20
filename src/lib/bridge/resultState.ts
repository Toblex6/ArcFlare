// Pure SDK-result classification. Approval is not a burn. Never auto-retry
// approval/burn errors; only a submitted burn can enter settlement polling.
import { extractBurnTxHash } from './resumeStore';

export function bridgeBurnStep(result: any): any {
  return Array.isArray(result?.steps)
    ? [...result.steps].reverse().find((step) => ['burn', 'depositforburn', 'deposit_for_burn'].includes(String(step?.name ?? '').toLowerCase()))
    : null;
}

export function canPollBridgeSettlement(result: any): boolean {
  const burn = bridgeBurnStep(result);
  return !!extractBurnTxHash(result) && burn?.state === 'success';
}

interface BridgeAttempt {
  result?: any;
  burnTxHash?: string | null;
  mintTxHash?: string | null;
  signingStarted?: boolean;
}

/** Even incomplete evidence of a burn/mint rules out another source spend. */
export function bridgeHasRecoveryEvidence(saved: BridgeAttempt): boolean {
  const mint = Array.isArray(saved.result?.steps)
    ? saved.result.steps.find((step: any) => String(step?.name ?? '').toLowerCase() === 'mint')
    : null;
  return !!saved.burnTxHash || !!saved.mintTxHash || !!extractBurnTxHash(saved.result) ||
    bridgeBurnStep(saved.result)?.state === 'success' || !!mint?.txHash || mint?.state === 'success';
}

/** A retry can ask for source signatures only after an explicit user check. */
export function bridgeNeedsBurnReview(saved: BridgeAttempt): boolean {
  return !bridgeHasRecoveryEvidence(saved) && saved.signingStarted !== false;
}

export function canRetryBridgeBeforeBurn(saved: BridgeAttempt, reviewed: boolean): boolean {
  return !bridgeHasRecoveryEvidence(saved) && (!bridgeNeedsBurnReview(saved) || reviewed);
}

/** A server-bound hash always wins; an editable candidate may replace a typo. */
export function selectBridgeRecoveryHash(bound: string | null | undefined, entered: string, observed: string | null | undefined): string | undefined {
  return bound || entered.trim() || observed || undefined;
}

export function bridgeEventHash(event: any, method: 'burn' | 'mint'): string | null {
  const name = String(event?.method ?? '').toLowerCase();
  const matches = method === 'burn' ? ['burn', 'depositforburn', 'deposit_for_burn'].includes(name) : name === 'mint';
  const hash = event?.values?.txHash;
  return matches && typeof hash === 'string' && /^0x[0-9a-f]{64}$/i.test(hash) ? hash : null;
}

export function bridgeResultFailure(result: any, sourceLabel: string): string {
  const burn = bridgeBurnStep(result);
  if (burn?.state === 'success' && extractBurnTxHash(result)) {
    return 'Your USDC was sent, but it has not arrived on Arc yet. Keep tracking this transfer—do not start it again.';
  }
  if (extractBurnTxHash(result)) {
    return `A transfer was submitted on ${sourceLabel}. Check its status instead of starting another one.`;
  }
  const failed = [...(Array.isArray(result?.steps) ? result.steps : [])].reverse().find((step: any) => step?.state === 'error');
  const parts = [failed?.errorMessage, failed?.error?.message, failed?.error?.cause?.message, result?.error?.message, result?.error?.cause?.message, result?.error];
  const text = parts.map((part) => typeof part === 'string' ? part : '').join(' ').toLowerCase();
  const name = String(failed?.name ?? '').toLowerCase();
  const approval = name === 'approve';
  const stage = approval ? 'Wallet confirmation' : 'Transfer';
  if (/user rejected|user denied|request rejected|user cancelled|action rejected/.test(text)) {
    return `${stage} was cancelled. Check your wallet activity before trying again.`;
  }
  if (/allowance/.test(text)) {
    return 'Your wallet did not allow enough USDC for this transfer. Check your wallet activity, then try this transfer again.';
  }
  if (/insufficient funds|out of funds|insufficient.*gas|gas.*insufficient|intrinsic gas too low|out of gas/.test(text)) {
    return `${stage} could not be sent because there is not enough gas on ${sourceLabel}. Add gas, check your wallet activity, then try again.`;
  }
  return `${stage} did not return a transaction hash. Check your wallet activity before trying again.`;
}
