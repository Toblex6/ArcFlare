// Missing/malformed optional server-bridge configuration is a feature outage,
// not an application startup dependency or a generic internal-server error.
import { NextResponse } from "next/server";

export class CctpUnavailableError extends Error {
  readonly code = "cctp_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "CctpUnavailableError";
  }
}

export function cctpUnavailableResponse(error: unknown): NextResponse | null {
  if (!(error instanceof CctpUnavailableError)) return null;
  return NextResponse.json(
    { success: false, error: "CCTP bridge is unavailable", code: error.code, message: error.message },
    { status: 503 }
  );
}
