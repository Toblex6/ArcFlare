// Shared actor resolution for FlareHQ Jobs. Every identity-sensitive action
// still passes through the repository's single ownership gate.

import type { NextRequest } from "next/server";
import { verifyCallerControlsAddress, type ControllingActor } from "@/lib/wallet/verifyCallerControlsAddress";
import { validJobAddress } from "./flarehqJob";

export async function requireFlareHQJobActor(
  req: NextRequest,
  claimedAddress: unknown
): Promise<{ actor: ControllingActor; address: string } | null> {
  if (!validJobAddress(claimedAddress)) return null;
  const actor = await verifyCallerControlsAddress(req, claimedAddress);
  return actor ? { actor, address: claimedAddress } : null;
}
