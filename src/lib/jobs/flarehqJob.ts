// src/lib/jobs/flarehqJob.ts
//
// Pure/shared helpers for FlareHQ Jobs. This feature is backed by
// FlareHQEscrow and is deliberately NOT ERC-8183.

import { isAddress, keccak256, toBytes } from "viem";

export const FLAREHQ_JOB_STATUSES = [
  "OPEN",
  "SELECTED",
  "FUNDED",
  "SUBMITTED",
  "COMPLETED",
  "DISPUTED",
  "REFUNDED",
  "CANCELLED",
] as const;

export type FlareHQJobStatus = (typeof FLAREHQ_JOB_STATUSES)[number];

export function parseJobUnits(value: unknown): bigint {
  const raw = String(value ?? "").trim();
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) {
    throw new Error("budget must be a positive USDC amount with at most 6 decimals");
  }
  const [whole, fraction = ""] = raw.split(".");
  const units = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (units <= 0n || units > 10_000_000n * 1_000_000n) {
    throw new Error("budget must be greater than zero and no more than 10,000,000 USDC");
  }
  return units;
}

export function formatJobUnits(units: bigint): string {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

export function flareHQJobEscrowReference(jobId: string): string {
  return `flarehq-job-${jobId}`;
}

export function flareHQJobEscrowId(jobId: string): `0x${string}` {
  return keccak256(toBytes(flareHQJobEscrowReference(jobId)));
}

export function validJobAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && isAddress(value);
}

export function serializeFlareHQJob(job: any) {
  return {
    ...job,
    product: "FlareHQ Jobs",
    protocol: "FlareHQEscrow",
    erc8183: false,
    jobNumber: job.seq == null ? null : `job${job.seq}`,
    budgetUSDC: job.budget == null ? null : formatJobUnits(BigInt(job.budget)),
  };
}
