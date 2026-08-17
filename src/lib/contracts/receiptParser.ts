/**
 * receiptParser.ts
 *
 * ONE shared helper for extracting a value from an on-chain event in a
 * transaction receipt. Replaces the four duplicated `extractXFromReceipt`
 * stubs that previously existed across job escrow, payroll, nanopayments,
 * and swap — each of those now calls this instead of maintaining its own
 * copy of the same event-log parsing loop.
 *
 * Works for both indexed and non-indexed event fields (parseLog returns
 * every input by name regardless of `indexed`), so it covers jobId
 * (indexed), batchId (indexed), streamId (indexed) and amountOut
 * (non-indexed) uniformly.
 *
 * Uses the ethers v6 pattern already established in src/lib/arcEngine.ts
 * (`iface.parseLog({ topics, data })`).
 */

import { Interface } from "ethers";

export interface ParsableReceipt {
  logs: ReadonlyArray<{
    topics: readonly string[];
    data: string;
  }>;
}

/**
 * Scans `receipt.logs`, finds the first log matching `eventName` in `abi`,
 * and returns the `fieldName` value from it as a bigint.
 *
 * Throws if no matching event is found (so callers can't silently get a
 * wrong/zero value), or if the event is found but the field is missing.
 */
export function parseEventValue(
  receipt: ParsableReceipt,
  abi: readonly string[],
  eventName: string,
  fieldName: string
): bigint {
  const iface = new Interface(abi);

  for (const log of receipt.logs) {
    let parsed;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue; // log doesn't belong to this ABI — skip and keep scanning
    }

    if (!parsed || parsed.name !== eventName) continue;

    const value = parsed.args[fieldName];
    if (value === undefined || value === null) {
      throw new Error(`event ${eventName} found in receipt but field '${fieldName}' is missing`);
    }
    return BigInt(value);
  }

  throw new Error(`${eventName} event not found in receipt (looking for field '${fieldName}')`);
}