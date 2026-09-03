// src/lib/notifyValidator.ts
//
// SUBTASK D — Validation request notification (receiver workflow, part 1:
// notify; inbox is docs-only, see gap note below).
//
// When a validation request succeeds on-chain, the selected validator gets no
// signal and has no pending inbox. This helper closes the first half: it maps
// the AUTHORITATIVE validator address (the exact `validator` argument sent to
// ValidationRegistry.validationRequest — i.e. the agent route's `validatorSCA`
// body field, or the job route's stored `policy.validatorSCA`) to a notifiable
// actor via the existing read-only resolveBeneficiary() classifier, then fans
// out over EXISTING channels only (central notify() / Telegram DM / shareable
// respond hint — same channel matrix as notifyBeneficiary.ts).
//
// Identity notes (invariants):
//   - Agent id vs tokenId vs scaAddress are NOT interchangeable. The validator
//     here is keyed ONLY by wallet address (scaAddress semantics); we never
//     guess a registry id or tokenId for the validator.
//   - No private info is ever exposed: the payload carries only the validator's
//     own address, the public agent tokenId/name, the request tag/hashes, the
//     explorer URL, and respond instructions. No emails, keys, or balances.
//   - No payer/wallet resolution happens here at all — there is no
//     default-payer fallback to reintroduce; the caller passes the already
//     authorized on-chain values straight through.
//
// Failure semantics: NEVER throws. A notification failure must not invalidate
// a successful on-chain request — errors are caught, logged, and reported as
// { notified: false }. Callers additionally wrap the call in try/catch.
//
// ── RECEIVER / INBOX GAP (docs, not code) ────────────────────────────────────
// There is still no validator-side pending inbox: no ValidationRequest table
// exists (the respond path notes this too), nothing indexes
// ValidationRegistry request events, and the /agents dashboard validation tab
// is manual requestHash entry (request → paste hash → respond → status). A
// real inbox needs a persisted request record (validatorSCA, requestHash,
// agentTokenId, status) written at request time plus a query route scoped by
// verifyCallerControlsAddress — a schema + UI change deliberately left out of
// this subtask to avoid a broad redesign. Until then the validator discovers
// pending work via this notification (which carries the requestHash) and
// responds via POST /api/agent/validation { action: "respond", ... }.

import { prisma } from "@/lib/prisma";
import { resolveBeneficiary } from "@/lib/escrow/resolveBeneficiary";
import { notify } from "@/lib/notifications";
import { sendTelegramMessage } from "@/lib/telegram/sendTelegramMessage";

export interface ValidationNotifyInput {
  /** Authoritative validator wallet = the on-chain `validator` arg. Echoed, never re-derived. */
  validatorSCA: string;
  agentTokenId: string;
  agentName?: string | null;
  requestTag: string;
  /** Authoritative requestHash returned to the caller. Echoed, never regenerated. */
  requestHash: string;
  requestURI: string;
  txHash: string;
  /** Set for the job-validation path; null for the direct agent path. */
  jobId?: string | number | null;
}

export interface ValidationNotifyResult {
  notified: boolean;
  channel?: string;
  reason?: string;
  validatorKind?: string;
}

/** Side-effect boundary — defaults are the real implementations; tests inject mocks. */
export interface NotifyValidatorDeps {
  resolveBeneficiaryFn?: typeof resolveBeneficiary;
  notifyFn?: typeof notify;
  sendTelegramMessageFn?: typeof sendTelegramMessage;
  findConsumerTelegramFn?: (actorId: string) => Promise<string | null>;
  findAgentOwnerMerchantFn?: (actorId: string) => Promise<string | null>;
}

async function defaultFindConsumerTelegram(actorId: string): Promise<string | null> {
  const consumer = await (prisma as any).consumerAccount.findFirst({
    where: { id: actorId },
    select: { telegramUserId: true },
  });
  return consumer?.telegramUserId ? String(consumer.telegramUserId) : null;
}

async function defaultFindAgentOwnerMerchant(actorId: string): Promise<string | null> {
  const agent = await (prisma as any).agentRegistry.findUnique({
    where: { id: Number(actorId) },
    select: { merchantId: true },
  });
  return agent?.merchantId ?? null;
}

export async function notifyValidator(
  input: ValidationNotifyInput,
  deps: NotifyValidatorDeps = {}
): Promise<ValidationNotifyResult> {
  const {
    resolveBeneficiaryFn = resolveBeneficiary,
    notifyFn = notify,
    sendTelegramMessageFn = sendTelegramMessage,
    findConsumerTelegramFn = defaultFindConsumerTelegram,
    findAgentOwnerMerchantFn = defaultFindAgentOwnerMerchant,
  } = deps;

  const agentLabel =
    input.agentName != null && String(input.agentName).trim() !== ""
      ? `${input.agentName} (#${input.agentTokenId})`
      : `agent #${input.agentTokenId}`;
  const subject = input.jobId != null && String(input.jobId) !== ""
    ? `validation requested for job ${input.jobId} (${agentLabel})`
    : `validation requested for ${agentLabel}`;
  const explorerUrl = `https://testnet.arcscan.app/tx/${input.txHash}`;
  const respondHint =
    `Respond: POST /api/agent/validation { "action": "respond", "validatorSCA": "<your wallet>", ` +
    `"requestHash": "${input.requestHash}", "passed": true/false, "tag": "<label>" }. ` +
    `Status: GET /api/agent/validation?requestHash=${input.requestHash}`;

  try {
    // Read-only classification of the authoritative validator address. No
    // private info leaves the DB — only kind + actorId drive the fan-out.
    const beneficiary = await resolveBeneficiaryFn(input.validatorSCA);

    const data = {
      agentTokenId: input.agentTokenId,
      agentName: input.agentName ?? null,
      requestTag: input.requestTag,
      requestHash: input.requestHash,
      requestURI: input.requestURI,
      txHash: input.txHash,
      explorerUrl,
      validatorSCA: input.validatorSCA,
      ...(input.jobId != null && String(input.jobId) !== "" ? { jobId: String(input.jobId) } : {}),
    };

    switch (beneficiary.kind) {
      case "merchant": {
        await notifyFn({
          merchantId: beneficiary.actorId!,
          event: "validation.requested",
          title: "Validation requested",
          message:
            `You were selected as validator — ${subject} (tag: ${input.requestTag}). ` +
            `Request: ${explorerUrl}. ${respondHint}`,
          data,
        });
        return { notified: true, channel: "notify(merchant)", validatorKind: "merchant" };
      }

      case "consumer": {
        const telegramUserId = await findConsumerTelegramFn(beneficiary.actorId!);
        if (telegramUserId) {
          await sendTelegramMessageFn(
            telegramUserId,
            `You were selected as validator — ${subject} (tag: ${input.requestTag}). ` +
              `Request: ${explorerUrl}. ${respondHint}`
          );
        }
        return {
          notified: true,
          channel: telegramUserId ? "telegram" : "no-telegram",
          validatorKind: "consumer",
        };
      }

      case "agent": {
        const ownerMerchantId = await findAgentOwnerMerchantFn(beneficiary.actorId!);
        if (ownerMerchantId) {
          await notifyFn({
            merchantId: ownerMerchantId,
            event: "validation.requested",
            title: "Validation requested (your agent)",
            message:
              `Your agent is the selected validator — ${subject} (tag: ${input.requestTag}). ` +
              `Request: ${explorerUrl}. ${respondHint}`,
            data,
          });
        }
        return {
          notified: true,
          channel: ownerMerchantId ? "notify(owner)" : "no-owner",
          validatorKind: "agent",
        };
      }

      case "external":
      default:
        // No direct channel — the requester holds the shareable respond hint
        // (requestHash + endpoint), returned in the request response.
        return { notified: true, channel: "link-shared", validatorKind: "external" };
    }
  } catch (error: any) {
    // Best-effort: the on-chain request already succeeded — never fail it
    // because a notification transport errored.
    console.error(`[notifyValidator] ${input.requestHash} failed:`, error?.message);
    return { notified: false, reason: error?.message || "transport-failed" };
  }
}
