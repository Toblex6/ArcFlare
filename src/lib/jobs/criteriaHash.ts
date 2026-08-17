import { keccak256, toUtf8Bytes } from "ethers"; // adjust to viem's keccak256/toBytes if that's your existing lib

/**
 * Produces the on-chain criteriaHash for a job, matching
 * ArcFlareJobEscrow.fundJob(token, budget, criteriaHash).
 *
 * IMPORTANT: hash a CANONICAL, stable serialization of the criteria — not
 * whatever JSON.stringify happens to produce, since key order isn't
 * guaranteed. Sort keys before hashing so re-hashing the same criteria
 * later (e.g. for review) always produces the same hash.
 */
export interface AcceptanceCriteria {
  jobId: string; // your internal DB job id, for cross-reference — not the on-chain jobId
  description: string;
  requirements: string[]; // each a discrete, checkable requirement
  deadlineUnix: number;
}

export function canonicalizeCriteria(criteria: AcceptanceCriteria): string {
  return JSON.stringify({
    jobId: criteria.jobId,
    description: criteria.description,
    requirements: [...criteria.requirements].sort(),
    deadlineUnix: criteria.deadlineUnix,
  });
}

export function hashCriteria(criteria: AcceptanceCriteria): `0x${string}` {
  const canonical = canonicalizeCriteria(criteria);
  return keccak256(toUtf8Bytes(canonical)) as `0x${string}`;
}

/**
 * Call this at review time to confirm the criteria being reviewed against
 * are the SAME ones committed on-chain at funding time — i.e. nobody edited
 * the brief after the fact. Compare against Job.criteriaHash read from the
 * contract (see getJob() in ArcFlareJobEscrow.sol).
 */
export function verifyCriteriaUnchanged(
  criteria: AcceptanceCriteria,
  onChainHash: string
): boolean {
  return hashCriteria(criteria).toLowerCase() === onChainHash.toLowerCase();
}
