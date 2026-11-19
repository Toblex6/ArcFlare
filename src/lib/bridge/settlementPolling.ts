// Read-only external-bridge settlement polling shared by current-session and
// rehydrated UI recovery. Its dependency surface has no adapter, provider,
// wallet or signing callback, so polling can never reopen approval/burn.

const TX_HASH_RE = /^0x[0-9a-f]{64}$/i;

export interface BridgeSettlementStatus {
  success?: boolean;
  state?: string;
  error?: string;
  burnTxHash?: string | null;
  mintTxHash?: string | null;
  relayMintTxHash?: string | null;
}

export interface PollBridgeSettlementOptions {
  reference: string;
  rounds: number;
  delayMs: number;
  fetchStatus: (reference: string) => Promise<BridgeSettlementStatus | null>;
  wait?: (delayMs: number) => Promise<void>;
  isActive?: () => boolean;
  onPoll?: () => void;
}

function validHash(value: unknown): string | undefined {
  return typeof value === 'string' && TX_HASH_RE.test(value) ? value : undefined;
}

export async function pollBridgeSettlementStatus({
  reference,
  rounds,
  delayMs,
  fetchStatus,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  isActive = () => true,
  onPoll,
}: PollBridgeSettlementOptions): Promise<{ burnTxHash: string | undefined; mintTxHash: string | undefined }> {
  let burnTxHash: string | undefined;
  let mintTxHash: string | undefined;
  for (let round = 0; round < rounds; round++) {
    if (!isActive()) throw new Error('Bridge interrupted.');
    onPoll?.();
    // The caller supplies an authenticated status GET. No source signing
    // capability is accepted by this helper.
    // eslint-disable-next-line no-await-in-loop
    const status = await fetchStatus(reference);
    if (status?.success) {
      burnTxHash = validHash(status.burnTxHash) ?? burnTxHash;
      mintTxHash = validHash(status.mintTxHash) ?? validHash(status.relayMintTxHash) ?? mintTxHash;
      if (status.state === 'failed') {
        throw Object.assign(new Error(status.error ?? 'This bridge requires recovery. Check wallet activity; do not submit another burn.'), {
          bridgeCopy: true,
        });
      }
      if (mintTxHash || status.state === 'completed') return { burnTxHash, mintTxHash };
    }
    if (round + 1 < rounds) {
      // eslint-disable-next-line no-await-in-loop
      await wait(delayMs);
    }
  }
  return { burnTxHash, mintTxHash };
}
