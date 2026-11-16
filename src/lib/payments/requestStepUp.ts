// UX policy only. The server's canonical step-up gate remains authoritative.
export function requestNeedsStepUp(action: unknown, recipient: unknown, ownWallet: unknown): boolean {
  if (action === 'send' || action === 'save') return true;
  if (action !== 'request' || recipient == null || recipient === '') return false;
  return typeof recipient !== 'string' || typeof ownWallet !== 'string' ||
    !/^0x[a-fA-F0-9]{40}$/.test(ownWallet) || recipient.toLowerCase() !== ownWallet.toLowerCase();
}
