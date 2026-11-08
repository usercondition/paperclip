import { createHash } from "node:crypto";

/**
 * Opt-in managed-repair control.
 *
 * Enrollment is a row, not a comment. Comments, quoted instructions, reviewer
 * PASS text, issue status, runs, and coordinator claims never grant scope and
 * never lift a live hold. The same decision is used for direct service calls,
 * HTTP mutations, comment-triggered wakes, and automatic retries.
 *
 * This gate mediates Paperclip issue mutations and heartbeat/wake dispatch
 * only. It does not prevent shell, browser, or other side effects outside
 * that path, and it is not marketplace-wide protection.
 */

export const MANAGED_REPAIR_DISPATCH_GATE_SCOPE =
  "native_paperclip_issue_mutation_and_wake" as const;

export const MANAGED_REPAIR_OUTSIDE_MEDIATION =
  "This gate mediates Paperclip issue mutations and heartbeat/wake dispatch only. It does not prevent shell, browser, or other side effects outside that path, and it is not marketplace-wide protection.";

export const DEFAULT_MANAGED_REPAIR_IDLE_MS = 20 * 60 * 1000;
export const DEFAULT_MANAGED_REPAIR_MAX_FAILURES = 1;

export const MANAGED_REPAIR_STAGES = [
  "staged",
  "reviewed",
  "applied",
  "independently_verified",
  "closed",
] as const;
export type ManagedRepairStage = (typeof MANAGED_REPAIR_STAGES)[number];

export const MANAGED_REPAIR_WAKE_SOURCES = [
  "direct",
  "comment",
  "idle_next_step",
  "automatic",
] as const;
export type ManagedRepairWakeSource = (typeof MANAGED_REPAIR_WAKE_SOURCES)[number];

export const EXPLICIT_BOARD_AUTHORITY_SOURCE = "explicit_board_grant" as const;

export interface ManagedRepairBlocker {
  evidenceRef: string;
  summary: string;
}

export interface ManagedRepairState {
  id: string;
  companyId: string;
  issueId: string;
  enrolled: boolean;
  ownerUserId: string | null;
  ownerAgentId: string | null;
  nextStepId: string | null;
  nextStepText: string | null;
  nextStepUpdatedAt: string | null;
  stage: ManagedRepairStage;
  liveHold: boolean;
  authorizationVersion: number;
  authorizedScope: string[];
  authorizationSource: string | null;
  authorizationGrantedByUserId: string | null;
  savedResultVersion: string | null;
  savedResultEvidenceRef: string | null;
  evidencedBlocker: ManagedRepairBlocker | null;
  idleThresholdMs: number;
  maxDispatchFailures: number;
  dispatchFailureCount: number;
  dispatchHalted: boolean;
  lastDispatchAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedRepairVerdict {
  id: string;
  repairId: string;
  companyId: string;
  reviewerUserId: string | null;
  reviewerAgentId: string | null;
  outcome: "PASS" | "FAIL";
  artifactVersion: string;
  kind: "qa" | "note";
  source: "independent_review" | "monitor";
  createdAt: string;
}

export interface ManagedRepairWakeClaim {
  id: string;
  companyId: string;
  issueId: string;
  repairId: string;
  intentKey: string;
  source: ManagedRepairWakeSource;
  status: "claimed" | "dispatched" | "failed" | "halted";
  failureCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedRepairDecision {
  allowed: boolean;
  enrolled: boolean;
  code: string;
  message: string;
  details: Record<string, unknown>;
  repair: ManagedRepairState | null;
}

export interface AuthorityAttempt {
  authoritySource?: string | null;
  actorType?: string | null;
  actorUserId?: string | null;
  commentBody?: string | null;
  authorType?: string | null;
  reviewerPass?: unknown;
  coordinatorClaim?: unknown;
  issueStatus?: string | null;
  runId?: string | null;
  quotedInstruction?: string | null;
}

export interface ManagedRepairDatabase {
  getRepair(companyId: string, issueId: string): Promise<ManagedRepairState | null>;
  saveRepair(repair: ManagedRepairState): Promise<void>;
  findClaim(companyId: string, issueId: string, intentKey: string): Promise<ManagedRepairWakeClaim | null>;
  insertClaim(claim: ManagedRepairWakeClaim): Promise<ManagedRepairWakeClaim | null>;
  saveClaim(claim: ManagedRepairWakeClaim): Promise<void>;
  listVerdicts(companyId: string, repairId: string): Promise<ManagedRepairVerdict[]>;
  insertVerdict(verdict: ManagedRepairVerdict): Promise<void>;
  transaction<T>(fn: (db: ManagedRepairDatabase) => Promise<T>): Promise<T>;
}

function gateDetails(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dispatchGateScope: MANAGED_REPAIR_DISPATCH_GATE_SCOPE,
    outsideMediation: MANAGED_REPAIR_OUTSIDE_MEDIATION,
    ...extra,
  };
}

function decision(
  repair: ManagedRepairState | null,
  allowed: boolean,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): ManagedRepairDecision {
  return {
    allowed,
    enrolled: Boolean(repair?.enrolled),
    code,
    message,
    details: gateDetails(extra),
    repair,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled managed repair variant: ${String(value)}`);
}

const SYNTHETIC_BOARD_ACTOR_IDS = new Set(["local-board", "local-implicit-board"]);
const AUTHENTICATED_BOARD_SOURCES = new Set(["session", "board_key", "cloud_tenant", "cloud_tenant_auth"]);

export function explicitBoardAuthorityAccepted(attempt: AuthorityAttempt): boolean {
  const actorUserId = attempt.actorUserId?.trim() ?? "";
  const contaminated =
    attempt.commentBody != null ||
    attempt.authorType != null ||
    attempt.reviewerPass != null ||
    attempt.coordinatorClaim != null ||
    attempt.issueStatus != null ||
    attempt.runId != null ||
    attempt.quotedInstruction != null;
  if (contaminated || SYNTHETIC_BOARD_ACTOR_IDS.has(actorUserId)) return false;
  return (
    attempt.authoritySource === EXPLICIT_BOARD_AUTHORITY_SOURCE &&
    attempt.actorType === "user" &&
    actorUserId.length > 0
  );
}

export function boardManagedRepairActor(actor: {
  type?: string | null;
  userId?: string | null;
  source?: string | null;
}): { actorType: "user"; actorUserId: string } | null {
  if (actor.type !== "board") return null;
  if (!actor.source || !AUTHENTICATED_BOARD_SOURCES.has(actor.source)) return null;
  const userId = actor.userId?.trim() ?? "";
  if (!userId || SYNTHETIC_BOARD_ACTOR_IDS.has(userId)) return null;
  return { actorType: "user", actorUserId: userId };
}

export function isExactManagedRepairEvidence(value: string | null | undefined): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value?.trim().toLowerCase() ?? "");
}

function stableManagedRepairJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableManagedRepairJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableManagedRepairJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function managedRepairResultChecksum(result: unknown): string {
  return `sha256:${createHash("sha256").update(stableManagedRepairJson(result)).digest("hex")}`;
}

export function managedRepairTerminalHaltAction(status: string): "halt" | "stop_without_halt" | "none" {
  switch (status) {
    case "failed":
    case "timed_out":
      return "halt";
    case "interrupted":
    case "cancelled":
      return "stop_without_halt";
    default:
      return "none";
  }
}

/**
 * An interrupted enrolled run is not a dispatch failure, and it is not
 * permission to continue. The previous grant and lifted hold stop applying.
 * Shutdown, deferred promotion, conversation continuation, and bounded retry
 * then fail closed until a later explicit board grant.
 */
export function managedRepairInterruptStopsAutomaticResume(
  repair: ManagedRepairState,
  now = new Date().toISOString(),
): ManagedRepairState {
  if (!repair.enrolled) return repair;
  return {
    ...repair,
    authorizationSource: null,
    authorizationGrantedByUserId: null,
    authorizedScope: [],
    liveHold: true,
    updatedAt: now,
  };
}

export function isConcreteNextStep(text: string | null | undefined): boolean {
  const trimmed = text?.trim() ?? "";
  return trimmed.length >= 8 && /\s/.test(trimmed);
}

export function hasDurableOwner(repair: ManagedRepairState): boolean {
  return Boolean(repair.ownerUserId?.trim() || repair.ownerAgentId?.trim());
}

export function hasEvidencedBlocker(repair: ManagedRepairState): boolean {
  return Boolean(repair.evidencedBlocker?.evidenceRef?.trim());
}

export function scopeAllows(
  scope: readonly string[],
  action: "wake" | "status" | "checkout",
): boolean {
  switch (action) {
    case "wake":
      return scope.includes("execute_next_step");
    case "status":
      return scope.includes("mutate_status") || scope.includes("execute_next_step");
    case "checkout":
      return scope.includes("checkout") || scope.includes("execute_next_step");
    default:
      return assertNever(action);
  }
}

export function authorizationIsActive(repair: ManagedRepairState): boolean {
  return (
    repair.authorizationSource === EXPLICIT_BOARD_AUTHORITY_SOURCE &&
    repair.authorizationVersion > 0 &&
    Boolean(repair.authorizationGrantedByUserId?.trim())
  );
}

function startWorkBlocker(
  repair: ManagedRepairState,
  action: "wake" | "status" | "checkout",
): ManagedRepairDecision | null {
  if (!hasDurableOwner(repair)) {
    return decision(repair, false, "managed_repair_missing_owner", "Managed repair requires a durable owner.");
  }
  if (!repair.nextStepId?.trim() || !isConcreteNextStep(repair.nextStepText)) {
    return decision(
      repair,
      false,
      "managed_repair_missing_next_step",
      "Managed repair requires a concrete next step.",
    );
  }
  if (hasEvidencedBlocker(repair)) {
    return decision(
      repair,
      false,
      "managed_repair_evidenced_blocker",
      "Managed repair is blocked by recorded evidence and cannot start work.",
      { evidenceRef: repair.evidencedBlocker?.evidenceRef },
    );
  }
  if (!authorizationIsActive(repair)) {
    return decision(
      repair,
      false,
      "managed_repair_not_accountable",
      "Managed repair needs active authorized work or an evidenced blocker.",
    );
  }
  if (repair.liveHold) {
    return decision(
      repair,
      false,
      "managed_repair_live_hold",
      "A live hold is active. Issue status, comments, and runs do not lift it.",
    );
  }
  if (!scopeAllows(repair.authorizedScope, action)) {
    return decision(
      repair,
      false,
      "managed_repair_scope_denied",
      "The explicit authorization does not include this action.",
      { action },
    );
  }
  if (repair.dispatchHalted) {
    return decision(
      repair,
      false,
      "managed_repair_halted",
      "Managed repair stopped after a dispatch failure. Automatic retry will not continue.",
    );
  }
  return null;
}

function offlineDispatchBlocker(repair: ManagedRepairState): ManagedRepairDecision | null {
  if (!authorizationIsActive(repair)) {
    return decision(
      repair,
      false,
      "managed_repair_not_accountable",
      "Offline dispatch needs an explicit board scope. A live hold does not grant it.",
    );
  }
  const scope = repair.authorizedScope;
  if (!scope.includes("read") && !scope.includes("offline")) {
    return decision(
      repair,
      false,
      "managed_repair_scope_denied",
      "Offline dispatch needs read or offline scope and does not lift a live hold.",
      { action: "offline" },
    );
  }
  return null;
}

export function projectRepairAfterIssueStatusChange(repair: ManagedRepairState): ManagedRepairState {
  return repair;
}

export function decideManagedRepairIssueMutation(
  repair: ManagedRepairState | null,
  input: { fromStatus: string; toStatus: string; action: "status" | "checkout"; humanStop?: boolean },
): ManagedRepairDecision {
  if (!repair?.enrolled) {
    return decision(null, true, "managed_repair_not_enrolled", "Ordinary issue; managed repair is not enrolled.");
  }
  const unchanged = projectRepairAfterIssueStatusChange(repair);
  if (input.action === "status" && input.fromStatus === input.toStatus) {
    return decision(unchanged, true, "managed_repair_read_only", "Non-executing update leaves the hold unchanged.");
  }
  if (input.toStatus === "cancelled" && input.humanStop) {
    return decision(
      unchanged,
      true,
      "managed_repair_human_stop",
      "A board operator cancelled this repair. Saved-result evidence is not required, and the live hold stays unchanged.",
    );
  }
  if (input.toStatus === "done" || input.toStatus === "cancelled") {
    if (unchanged.stage !== "independently_verified" && unchanged.stage !== "closed") {
      return decision(
        unchanged,
        false,
        "managed_repair_staged_as_complete",
        "Staged, reviewed, or applied work cannot be closed without independent verification.",
        { stage: unchanged.stage },
      );
    }
    return decision(unchanged, true, "managed_repair_completion_allowed", "Verified managed repair can close.");
  }
  if (
    input.action === "checkout" ||
    input.toStatus === "todo" ||
    input.toStatus === "in_progress"
  ) {
    const blocked = startWorkBlocker(unchanged, input.action === "checkout" ? "checkout" : "status");
    if (blocked) return blocked;
    return decision(unchanged, true, "managed_repair_work_allowed", "Authorized managed repair work can proceed.");
  }
  return decision(unchanged, true, "managed_repair_non_executing", "This status change does not start or close work.");
}

export function classifyManagedRepairWakeSource(input: {
  reason?: string | null;
  contextSource?: unknown;
  invocationSource?: string | null;
}): ManagedRepairWakeSource {
  const context = typeof input.contextSource === "string" ? input.contextSource : "";
  if (input.reason === "managed_repair_idle_next_step" || context === "managed_repair.idle_next_step") {
    return "idle_next_step";
  }
  if (
    input.reason === "issue_commented" ||
    input.reason === "issue_reopened_via_comment" ||
    context.startsWith("issue.comment")
  ) {
    return "comment";
  }
  if (input.invocationSource === "on_demand" || input.invocationSource === "assignment") return "direct";
  return "automatic";
}

export function resolveManagedRepairWakeTrigger(input: {
  explicit?: string | null;
  commentId?: string | null;
  idempotencyKey?: string | null;
  reason?: string | null;
}): string {
  const explicit = input.explicit?.trim();
  if (explicit) return explicit;
  if (input.commentId?.trim()) return `comment:${input.commentId.trim()}`;
  if (input.idempotencyKey?.trim()) return `idempotency:${input.idempotencyKey.trim()}`;
  return `direct:${input.reason?.trim() || "wake"}`;
}

export function managedRepairIntentKey(input: {
  issueId: string;
  nextStepId: string;
  authorizationVersion: number;
  source: ManagedRepairWakeSource;
  triggerId: string;
  lastDispatchAt?: string | null;
  disposition?: "live" | "offline";
}): string {
  const idleWindow = input.source === "idle_next_step" ? input.lastDispatchAt ?? "none" : "";
  return [
    input.issueId,
    input.nextStepId,
    String(input.authorizationVersion),
    input.source,
    input.triggerId,
    idleWindow,
    input.disposition ?? "live",
  ].join("|");
}

export interface WakeAdmission {
  allowed: boolean;
  enrolled: boolean;
  code: string;
  message: string;
  details: Record<string, unknown>;
  claimId: string | null;
  repair: ManagedRepairState | null;
}

export async function admitManagedRepairWake(
  db: ManagedRepairDatabase,
  input: {
    companyId: string;
    issueId: string;
    source: ManagedRepairWakeSource;
    triggerId: string;
    claimId: string;
    now?: string;
    commentBody?: string | null;
    authorType?: string | null;
    disposition?: "live" | "offline";
  },
): Promise<WakeAdmission> {
  return db.transaction(async (tx) => {
    const repair = await tx.getRepair(input.companyId, input.issueId);
    if (!repair?.enrolled) {
      return {
        allowed: true,
        enrolled: false,
        code: "managed_repair_not_enrolled",
        message: "Ordinary issue; managed repair is not enrolled.",
        details: gateDetails(),
        claimId: null,
        repair: null,
      };
    }
    if (repair.companyId !== input.companyId) {
      return {
        allowed: false,
        enrolled: true,
        code: "managed_repair_company_scope",
        message: "Managed repair belongs to a different company.",
        details: gateDetails(),
        claimId: null,
        repair,
      };
    }
    // Comment text and authorType are never read as authority.
    void input.commentBody;
    void input.authorType;
    const disposition = input.disposition ?? "live";
    const blocked = disposition === "offline" ? offlineDispatchBlocker(repair) : startWorkBlocker(repair, "wake");
    if (blocked) {
      return { ...blocked, claimId: null };
    }
    const now = input.now ?? new Date().toISOString();
    const intentKey = managedRepairIntentKey({
      issueId: repair.issueId,
      nextStepId: repair.nextStepId?.trim() || "offline",
      authorizationVersion: repair.authorizationVersion,
      source: input.source,
      triggerId: input.triggerId,
      lastDispatchAt: repair.lastDispatchAt,
      disposition,
    });
    const inserted = await tx.insertClaim({
      id: input.claimId,
      companyId: repair.companyId,
      issueId: repair.issueId,
      repairId: repair.id,
      intentKey,
      source: input.source,
      status: "dispatched",
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    if (!inserted) {
      const existing = await tx.findClaim(repair.companyId, repair.issueId, intentKey);
      const halted = existing?.status === "halted" || repair.dispatchHalted;
      return {
        allowed: false,
        enrolled: true,
        code: halted ? "managed_repair_halted" : "managed_repair_wake_replay",
        message: halted
          ? "Managed repair stopped after a dispatch failure."
          : "This managed repair wake was already claimed.",
        details: gateDetails({ intentKey }),
        claimId: existing?.id ?? null,
        repair,
      };
    }
    await tx.saveRepair({ ...repair, lastDispatchAt: now, updatedAt: now });
    return {
      allowed: true,
      enrolled: true,
      code: "managed_repair_wake_claimed",
      message: "Managed repair wake claimed.",
      details: gateDetails({ intentKey, source: input.source }),
      claimId: inserted.id,
      repair: { ...repair, lastDispatchAt: now, updatedAt: now },
    };
  });
}

export function applyDispatchFailure(
  repair: ManagedRepairState,
  claim: ManagedRepairWakeClaim,
  now = new Date().toISOString(),
): { repair: ManagedRepairState; claim: ManagedRepairWakeClaim; halted: boolean } {
  if (claim.status === "failed" || claim.status === "halted") {
    return { repair, claim, halted: repair.dispatchHalted || claim.status === "halted" };
  }
  const failureCount = claim.failureCount + 1;
  const halted = failureCount >= repair.maxDispatchFailures || repair.dispatchHalted;
  return {
    halted,
    claim: {
      ...claim,
      failureCount,
      status: halted ? "halted" : "failed",
      updatedAt: now,
    },
    repair: {
      ...repair,
      dispatchFailureCount: repair.dispatchFailureCount + 1,
      dispatchHalted: halted,
      updatedAt: now,
    },
  };
}

export function selectEffectiveVerdict(
  verdicts: readonly ManagedRepairVerdict[],
  artifactVersion: string,
): ManagedRepairVerdict | null {
  const matches = verdicts.filter(
    (verdict) =>
      verdict.kind === "qa" &&
      verdict.source === "independent_review" &&
      verdict.artifactVersion === artifactVersion,
  );
  matches.sort((left, right) => {
    const time = right.createdAt.localeCompare(left.createdAt);
    return time === 0 ? right.id.localeCompare(left.id) : time;
  });
  return matches[0] ?? null;
}

export function decideVerdictRecord(
  repair: ManagedRepairState,
  input: {
    attempt: AuthorityAttempt;
    reviewerUserId?: string | null;
    reviewerAgentId?: string | null;
    outcome: "PASS" | "FAIL";
    artifactVersion: string;
    kind: "qa" | "note";
    source: "independent_review" | "monitor";
  },
): ManagedRepairDecision {
  if (input.kind === "note" || input.source === "monitor") {
    return decision(
      repair,
      true,
      "managed_repair_monitor_note",
      "Monitor notes are stored and are not an independent QA verdict.",
    );
  }
  if (!explicitBoardAuthorityAccepted(input.attempt)) {
    return decision(
      repair,
      false,
      "managed_repair_untrusted_authority",
      "A comment, status, run, or coordinator claim cannot record an independent verdict.",
    );
  }
  const reviewerUserId = input.attempt.actorUserId?.trim() ?? "";
  if (
    (input.reviewerUserId?.trim() && input.reviewerUserId.trim() !== reviewerUserId) ||
    input.reviewerAgentId
  ) {
    return decision(
      repair,
      false,
      "managed_repair_reviewer_substitution",
      "The reviewer is the authenticated principal. A supplied reviewer id is not authority.",
    );
  }
  if (input.attempt.actorType === "agent") {
    return decision(repair, false, "managed_repair_self_approval", "The executing agent cannot approve its own repair.");
  }
  if (repair.ownerUserId && reviewerUserId === repair.ownerUserId) {
    return decision(repair, false, "managed_repair_self_approval", "The repair owner cannot independently verify their own result.");
  }
  if (!reviewerUserId || !input.artifactVersion.trim()) {
    return decision(repair, false, "managed_repair_missing_independent_verdict", "An independent verdict needs a reviewer and an exact artifact version.");
  }
  if (
    !isExactManagedRepairEvidence(repair.savedResultEvidenceRef) ||
    input.artifactVersion.trim() !== repair.savedResultVersion
  ) {
    return decision(
      repair,
      false,
      "managed_repair_missing_saved_result",
      "An independent verdict must name the persisted saved-result version and checksum.",
    );
  }
  return decision(repair, true, "managed_repair_verdict_recorded", "Independent verdict recorded.");
}

export function decideStageTransition(
  repair: ManagedRepairState,
  target: ManagedRepairStage,
  verdicts: readonly ManagedRepairVerdict[],
  attempt: AuthorityAttempt,
): ManagedRepairDecision {
  if (!explicitBoardAuthorityAccepted(attempt)) {
    return decision(
      repair,
      false,
      "managed_repair_untrusted_authority",
      "Stage changes require an explicit board grant, not a comment or status.",
    );
  }
  if (target === "staged" || target === "reviewed") {
    return decision({ ...repair, stage: target }, true, "managed_repair_stage_updated", "Stage updated.");
  }
  if (target === "applied") {
    if (!repair.savedResultVersion?.trim() || !isExactManagedRepairEvidence(repair.savedResultEvidenceRef)) {
      return decision(
        repair,
        false,
        "managed_repair_missing_saved_result",
        "Applied requires the checksum of a persisted run result.",
      );
    }
    return decision({ ...repair, stage: target }, true, "managed_repair_stage_updated", "Applied.");
  }
  if (target === "independently_verified" || target === "closed") {
    if (repair.stage !== "applied" && repair.stage !== "independently_verified" && repair.stage !== "closed") {
      return decision(
        repair,
        false,
        "managed_repair_staged_as_complete",
        "Verification requires the applied stage and saved-result evidence.",
        { stage: repair.stage },
      );
    }
    if (!repair.savedResultVersion?.trim() || !isExactManagedRepairEvidence(repair.savedResultEvidenceRef)) {
      return decision(repair, false, "managed_repair_missing_saved_result", "Verification requires the checksum of a persisted run result.");
    }
    const verdict = selectEffectiveVerdict(verdicts, repair.savedResultVersion);
    if (!verdict || verdict.outcome !== "PASS") {
      return decision(
        repair,
        false,
        "managed_repair_missing_independent_verdict",
        "Verification requires the latest independent PASS for the exact saved-result version.",
        { artifactVersion: repair.savedResultVersion, verdict: verdict?.outcome ?? null },
      );
    }
    return decision({ ...repair, stage: target }, true, "managed_repair_stage_updated", "Independently verified.");
  }
  return assertNever(target);
}

export function decideAuthorityGrant(
  repair: ManagedRepairState,
  input: {
    attempt: AuthorityAttempt;
    scope: string[];
    liftHold?: boolean;
    clearHalt?: boolean;
    now?: string;
  },
): ManagedRepairDecision {
  if (!explicitBoardAuthorityAccepted(input.attempt)) {
    return decision(
      repair,
      false,
      "managed_repair_untrusted_authority",
      "Comments, quoted instructions, reviewer PASS, statuses, runs, and coordinator claims do not grant scope or lift a hold.",
    );
  }
  if (input.scope.length === 0 || input.scope.some((item) => !item.trim())) {
    return decision(repair, false, "managed_repair_scope_denied", "An explicit grant needs a non-empty scope.");
  }
  const now = input.now ?? new Date().toISOString();
  return decision(
    {
      ...repair,
      authorizedScope: [...input.scope],
      authorizationSource: EXPLICIT_BOARD_AUTHORITY_SOURCE,
      authorizationGrantedByUserId: input.attempt.actorUserId!.trim(),
      authorizationVersion: repair.authorizationVersion + 1,
      liveHold: input.liftHold ? false : repair.liveHold,
      dispatchHalted: input.clearHalt ? false : repair.dispatchHalted,
      updatedAt: now,
    },
    true,
    "managed_repair_granted",
    "Explicit board authorization recorded.",
  );
}

export function decideLiveHold(
  repair: ManagedRepairState,
  input: { hold: boolean; attempt: AuthorityAttempt; now?: string },
): ManagedRepairDecision {
  if (!explicitBoardAuthorityAccepted(input.attempt)) {
    return decision(
      repair,
      false,
      "managed_repair_untrusted_authority",
      "Only an explicit board action can change a live hold.",
    );
  }
  return decision(
    { ...repair, liveHold: input.hold, updatedAt: input.now ?? new Date().toISOString() },
    true,
    "managed_repair_hold_updated",
    input.hold ? "Live hold set." : "Live hold lifted by an explicit board action.",
  );
}

export interface IdleIssueSnapshot {
  status: string;
  executionRunId: string | null;
  assigneeAgentId: string | null;
}

export function idleNextStepDue(
  repair: ManagedRepairState,
  issue: IdleIssueSnapshot,
  now: Date,
): boolean {
  if (!repair.enrolled || repair.liveHold || repair.dispatchHalted) return false;
  if (!hasDurableOwner(repair) || !repair.nextStepId || !isConcreteNextStep(repair.nextStepText)) return false;
  if (hasEvidencedBlocker(repair) || !authorizationIsActive(repair)) return false;
  if (!scopeAllows(repair.authorizedScope, "wake")) return false;
  if (!issue.assigneeAgentId) return false;
  if (issue.executionRunId) return false;
  if (["in_progress", "done", "cancelled", "blocked"].includes(issue.status)) return false;
  const activity = repair.lastDispatchAt ?? repair.nextStepUpdatedAt ?? repair.createdAt;
  const elapsed = now.getTime() - Date.parse(activity);
  return elapsed >= repair.idleThresholdMs;
}

export function createMemoryManagedRepairDatabase(): ManagedRepairDatabase {
  const repairs = new Map<string, ManagedRepairState>();
  const claims = new Map<string, ManagedRepairWakeClaim>();
  const verdicts: ManagedRepairVerdict[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const key = (companyId: string, issueId: string) => `${companyId}:${issueId}`;

  const database: ManagedRepairDatabase = {
    async getRepair(_companyId, issueId) {
      for (const repair of repairs.values()) {
        if (repair.issueId === issueId) return repair;
      }
      return null;
    },
    async saveRepair(repair) {
      repairs.set(key(repair.companyId, repair.issueId), repair);
    },
    async findClaim(companyId, issueId, intentKey) {
      return (
        [...claims.values()].find(
          (claim) => claim.companyId === companyId && claim.issueId === issueId && claim.intentKey === intentKey,
        ) ?? null
      );
    },
    async insertClaim(claim) {
      const existing = await database.findClaim(claim.companyId, claim.issueId, claim.intentKey);
      if (existing) return null;
      claims.set(claim.id, claim);
      return claim;
    },
    async saveClaim(claim) {
      claims.set(claim.id, claim);
    },
    async listVerdicts(companyId, repairId) {
      return verdicts.filter((verdict) => verdict.companyId === companyId && verdict.repairId === repairId);
    },
    async insertVerdict(verdict) {
      verdicts.push(verdict);
    },
    transaction(fn) {
      const run = chain.then(() => fn(database));
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
  return database;
}
