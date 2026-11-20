export const checkoutBridgeScope = (reference: string) => ({
  OR: [{ invoiceReference: reference }, { checkoutTopUpReference: reference }],
});

export function checkoutBridgeBelongsTo(intent: {
  invoiceReference: string | null;
  checkoutTopUpReference: string | null;
}, reference: string) {
  return (intent.invoiceReference ?? intent.checkoutTopUpReference) === reference;
}

export async function lockCheckoutBridge(tx: any, reference: string) {
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `checkout-bridge:${reference}`);
}

export async function readCheckoutBridgeCredit(db: any, reference: string): Promise<bigint> {
  const verified: { actualAmount: string }[] = await db.flowBridgeIntent.findMany({
    where: { ...checkoutBridgeScope(reference), status: 'COMPLETED', actualAmount: { not: null }, mintTxHash: { not: null }, cctpNonce: { not: null } },
    select: { actualAmount: true },
  });
  return verified.reduce((total, leg) => total + BigInt(leg.actualAmount), 0n);
}
