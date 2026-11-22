// src/lib/jobs/flarehqJobsView.ts
//
// Pure presentation logic for the FlareHQ Jobs workspace. The page renders
// directly from these decisions so role-based visibility is testable without
// a browser, database, wallet or chain. No imports: keep it dependency-free.

export type JobViewerRole = "client" | "provider" | "applicant" | "visitor";
export type StepState = "done" | "current" | "upcoming";

export interface JobApplicationView {
  id: string;
  applicantAddress: string;
  pitch: string;
  proposedAmount?: string | null;
  status?: string | null;
}

export interface JobViewInput {
  status?: string | null;
  clientAddress?: string | null;
  providerAddress?: string | null;
  applications?: JobApplicationView[] | null;
}

export interface LifecycleStep {
  label: string;
  state: StepState;
}

export interface JobView {
  role: JobViewerRole;
  /** The viewer's own application, when they already applied. */
  application: JobApplicationView | null;
  /** True only when a visitor may submit a new application. */
  canApply: boolean;
  /** The Apply box/button is rendered only when this is true. */
  showApplyBox: boolean;
  /** Client-only: render Select provider on each application. */
  showSelectProvider: boolean;
  /** Client-only: render the full applications list. */
  showApplications: boolean;
  /** Role-relevant lifecycle steps; applicants see only the current one. */
  steps: LifecycleStep[];
}

const TERMINAL = new Set(["COMPLETED", "DISPUTED", "REFUNDED", "CANCELLED"]);

export function sameJobAddress(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function shortJobAddress(address?: string | null, head = 6, tail = 4): string {
  const value = String(address ?? "");
  if (!value) return "";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function viewerApplication(
  job: JobViewInput | null | undefined,
  viewer?: string | null
): JobApplicationView | null {
  if (!viewer) return null;
  return (job?.applications ?? []).find((app) => sameJobAddress(app.applicantAddress, viewer)) ?? null;
}

export function jobViewerRole(job: JobViewInput | null | undefined, viewer?: string | null): JobViewerRole {
  if (!job || !viewer) return "visitor";
  if (sameJobAddress(viewer, job.clientAddress)) return "client";
  if (sameJobAddress(viewer, job.providerAddress)) return "provider";
  if (viewerApplication(job, viewer)) return "applicant";
  return "visitor";
}

/** A client can never apply to its own job; an applicant applies once. */
export function canApplyToJob(job: JobViewInput | null | undefined, viewer?: string | null): boolean {
  if (!job || !viewer || job.status !== "OPEN") return false;
  return jobViewerRole(job, viewer) === "visitor";
}

function lifecycleSteps(role: JobViewerRole, status: string, application: JobApplicationView | null): LifecycleStep[] {
  const stateFor = (index: number, current: number): StepState => {
    if (status === "COMPLETED") return "done";
    if (index < current) return "done";
    if (index === current) return "current";
    return "upcoming";
  };

  if (TERMINAL.has(status) && status !== "COMPLETED") {
    const label = status.charAt(0) + status.slice(1).toLowerCase();
    return [{ label, state: "current" }];
  }

  if (role === "applicant") {
    // An applicant does not fund, deliver or release. Show only where they are.
    const label = status === "OPEN"
      ? "Awaiting client selection"
      : application?.status === "SELECTED"
        ? "Selected"
        : "Selection closed";
    return [{ label, state: status === "OPEN" ? "current" : "done" }];
  }

  const labels = role === "client"
    ? ["Select provider", "Fund escrow", "Submit work", "Approve & release"]
    : role === "provider"
      ? ["Fund escrow", "Submit work", "Accept release"]
      : ["Apply", "Provider selected", "Funded", "Deliver & release"];

  const clientCurrent: Record<string, number> = { OPEN: 0, SELECTED: 1, FUNDED: 2, SUBMITTED: 3 };
  const providerCurrent: Record<string, number> = { OPEN: -1, SELECTED: 0, FUNDED: 1, SUBMITTED: 2 };
  const visitorCurrent: Record<string, number> = { OPEN: 0, SELECTED: 1, FUNDED: 2, SUBMITTED: 3 };
  const currentByStatus = role === "client" ? clientCurrent : role === "provider" ? providerCurrent : visitorCurrent;

  const current = currentByStatus[status] ?? -1;
  return labels.map((label, index) => ({ label, state: stateFor(index, current) }));
}

export function jobViewFor(job: JobViewInput | null | undefined, viewer?: string | null): JobView {
  const role = jobViewerRole(job, viewer);
  const application = viewerApplication(job, viewer);
  const status = String(job?.status ?? "");
  const canApply = canApplyToJob(job, viewer);
  return {
    role,
    application,
    canApply,
    showApplyBox: canApply,
    showSelectProvider: role === "client" && status === "OPEN",
    showApplications: role === "client",
    steps: job ? lifecycleSteps(role, status, application) : [],
  };
}

export interface ActorWallet {
  address: string;
}

/**
 * Picks the acting wallet without asking when the answer is unambiguous:
 * keep an explicit valid choice, use the only signed-in wallet, otherwise use
 * the single wallet that matches this job's client/provider/applicant.
 * Returns "" when the choice is genuinely ambiguous (or there are no wallets).
 */
export function resolveDefaultJobActor(
  previous: string | null | undefined,
  wallets: ActorWallet[],
  job?: JobViewInput | null
): string {
  if (!wallets.length) return "";
  const kept = wallets.find((wallet) => sameJobAddress(wallet.address, previous));
  if (kept) return kept.address;
  if (wallets.length === 1) return wallets[0].address;
  const matches = wallets.filter((wallet) =>
    sameJobAddress(wallet.address, job?.clientAddress) ||
    sameJobAddress(wallet.address, job?.providerAddress) ||
    (job?.applications ?? []).some((app) => sameJobAddress(app.applicantAddress, wallet.address))
  );
  return matches.length === 1 ? matches[0].address : "";
}

export interface MyJobs<T> {
  posted: T[];
  applied: T[];
}

/** Splits My Jobs into "jobs I posted" and "jobs I applied to" for one wallet. */
export function partitionMyJobs<T extends JobViewInput>(jobs: T[], viewer?: string | null): MyJobs<T> {
  const posted: T[] = [];
  const applied: T[] = [];
  if (!viewer) return { posted, applied };
  for (const job of jobs) {
    if (sameJobAddress(viewer, job.clientAddress)) posted.push(job);
    else if (
      sameJobAddress(viewer, job.providerAddress) ||
      (job.applications ?? []).some((app) => sameJobAddress(app.applicantAddress, viewer))
    ) applied.push(job);
  }
  return { posted, applied };
}

export function myJobsEmptyMessage(kind: "posted" | "applied", walletCount: number): string {
  if (walletCount === 0) return "Sign in to see the jobs you posted and applied to.";
  return kind === "posted"
    ? "You have not posted any jobs yet."
    : "You have not applied to any jobs yet.";
}
