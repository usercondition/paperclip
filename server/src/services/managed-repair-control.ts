import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  issueManagedRepairs,
  issues,
  managedRepairVerdicts,
  managedRepairWakeClaims,
  type Db,
} from "@paperclipai/db";
import {
  admitManagedRepairWake,
  applyDispatchFailure,
  classifyManagedRepairWakeSource,
  decideAuthorityGrant,
  explicitBoardAuthorityAccepted,
  decideLiveHold,
  decideManagedRepairIssueMutation,
  decideStageTransition,
  decideVerdictRecord,
  idleNextStepDue,
  managedRepairIntentKey,
  resolveManagedRepairWakeTrigger,
  type AuthorityAttempt,
  type ManagedRepairDatabase,
  type ManagedRepairStage,
  type ManagedRepairState,
  type ManagedRepairVerdict,
  type ManagedRepairWakeClaim,
  type ManagedRepairWakeSource,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";

export { classifyManagedRepairWakeSource, resolveManagedRepairWakeTrigger };

type RepairRow = typeof issueManagedRepairs.$inferSelect;
type ClaimRow = typeof managedRepairWakeClaims.$inferSelect;
type VerdictRow = typeof managedRepairVerdicts.$inferSelect;

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapRepair(row: RepairRow): ManagedRepairState {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    enrolled: row.enrolled,
    ownerUserId: row.ownerUserId,
    ownerAgentId: row.ownerAgentId,
    nextStepId: row.nextStepId,
    nextStepText: row.nextStepText,
    nextStepUpdatedAt: iso(row.nextStepUpdatedAt),
    stage: row.stage as ManagedRepairState["stage"],
    liveHold: row.liveHold,
    authorizationVersion: row.authorizationVersion,
    authorizedScope: Array.isArray(row.authorizedScope) ? row.authorizedScope : [],
    authorizationSource: row.authorizationSource,
    authorizationGrantedByUserId: row.authorizationGrantedByUserId,
    savedResultVersion: row.savedResultVersion,
    savedResultEvidenceRef: row.savedResultEvidenceRef,
    evidencedBlocker: row.evidencedBlocker?.evidenceRef ? row.evidencedBlocker : null,
    idleThresholdMs: row.idleThresholdMs,
    maxDispatchFailures: row.maxDispatchFailures,
    dispatchFailureCount: row.dispatchFailureCount,
    dispatchHalted: row.dispatchHalted,
    lastDispatchAt: iso(row.lastDispatchAt),
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updatedAt) ?? new Date(0).toISOString(),
  };
}

function repairPatch(repair: ManagedRepairState): Partial<RepairRow> {
  return {
    enrolled: repair.enrolled,
    ownerUserId: repair.ownerUserId,
    ownerAgentId: repair.ownerAgentId,
    nextStepId: repair.nextStepId,
    nextStepText: repair.nextStepText,
    nextStepUpdatedAt: repair.nextStepUpdatedAt ? new Date(repair.nextStepUpdatedAt) : null,
    stage: repair.stage,
    liveHold: repair.liveHold,
    authorizationVersion: repair.authorizationVersion,
    authorizedScope: repair.authorizedScope,
    authorizationSource: repair.authorizationSource,
    authorizationGrantedByUserId: repair.authorizationGrantedByUserId,
    savedResultVersion: repair.savedResultVersion,
    savedResultEvidenceRef: repair.savedResultEvidenceRef,
    evidencedBlocker: repair.evidencedBlocker,
    idleThresholdMs: repair.idleThresholdMs,
    maxDispatchFailures: repair.maxDispatchFailures,
    dispatchFailureCount: repair.dispatchFailureCount,
    dispatchHalted: repair.dispatchHalted,
    lastDispatchAt: repair.lastDispatchAt ? new Date(repair.lastDispatchAt) : null,
    updatedAt: new Date(repair.updatedAt),
  };
}

function mapClaim(row: ClaimRow): ManagedRepairWakeClaim {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    repairId: row.repairId,
    intentKey: row.intentKey,
    source: row.source as ManagedRepairWakeSource,
    status: row.status as ManagedRepairWakeClaim["status"],
    failureCount: row.failureCount,
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updatedAt) ?? new Date(0).toISOString(),
  };
}

function mapVerdict(row: VerdictRow): ManagedRepairVerdict {
  return {
    id: row.id,
    repairId: row.repairId,
    companyId: row.companyId,
    reviewerUserId: row.reviewerUserId,
    reviewerAgentId: row.reviewerAgentId,
    outcome: row.outcome as ManagedRepairVerdict["outcome"],
    artifactVersion: row.artifactVersion,
    kind: row.kind as ManagedRepairVerdict["kind"],
    source: row.source as ManagedRepairVerdict["source"],
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
  };
}

export function createSqlManagedRepairDatabase(handle: Db, nested = false): ManagedRepairDatabase {
  const database: ManagedRepairDatabase = {
    async getRepair(_companyId, issueId) {
      const [row] = await handle
        .select()
        .from(issueManagedRepairs)
        .where(eq(issueManagedRepairs.issueId, issueId))
        .limit(1)
        .for("update");
      if (!row) return null;
      return mapRepair(row);
    },
    async saveRepair(repair) {
      await handle
        .update(issueManagedRepairs)
        .set(repairPatch(repair))
        .where(and(eq(issueManagedRepairs.id, repair.id), eq(issueManagedRepairs.companyId, repair.companyId)));
    },
    async findClaim(companyId, issueId, intentKey) {
      const [row] = await handle
        .select()
        .from(managedRepairWakeClaims)
        .where(
          and(
            eq(managedRepairWakeClaims.companyId, companyId),
            eq(managedRepairWakeClaims.issueId, issueId),
            eq(managedRepairWakeClaims.intentKey, intentKey),
          ),
        )
        .limit(1);
      return row ? mapClaim(row) : null;
    },
    async insertClaim(claim) {
      const [row] = await handle
        .insert(managedRepairWakeClaims)
        .values({
          id: claim.id,
          companyId: claim.companyId,
          issueId: claim.issueId,
          repairId: claim.repairId,
          intentKey: claim.intentKey,
          source: claim.source,
          status: claim.status,
          failureCount: claim.failureCount,
          createdAt: new Date(claim.createdAt),
          updatedAt: new Date(claim.updatedAt),
        })
        .onConflictDoNothing({ target: [managedRepairWakeClaims.issueId, managedRepairWakeClaims.intentKey] })
        .returning();
      return row ? mapClaim(row) : null;
    },
    async saveClaim(claim) {
      await handle
        .update(managedRepairWakeClaims)
        .set({
          status: claim.status,
          failureCount: claim.failureCount,
          updatedAt: new Date(claim.updatedAt),
        })
        .where(and(eq(managedRepairWakeClaims.id, claim.id), eq(managedRepairWakeClaims.companyId, claim.companyId)));
    },
    async listVerdicts(companyId, repairId) {
      const rows = await handle
        .select()
        .from(managedRepairVerdicts)
        .where(and(eq(managedRepairVerdicts.companyId, companyId), eq(managedRepairVerdicts.repairId, repairId)));
      return rows.map(mapVerdict);
    },
    async insertVerdict(verdict) {
      await handle.insert(managedRepairVerdicts).values({
        id: verdict.id,
        companyId: verdict.companyId,
        repairId: verdict.repairId,
        reviewerUserId: verdict.reviewerUserId,
        reviewerAgentId: verdict.reviewerAgentId,
        outcome: verdict.outcome,
        artifactVersion: verdict.artifactVersion,
        kind: verdict.kind,
        source: verdict.source,
        createdAt: new Date(verdict.createdAt),
      });
    },
    transaction(fn) {
      if (nested) return fn(database);
      return handle.transaction((tx) => fn(createSqlManagedRepairDatabase(tx as unknown as Db, true)));
    },
  };
  return database;
}

export function isManagedRepairDispatchDenial(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("details" in err)) return false;
  const details = (err as { details?: { code?: unknown } }).details;
  return typeof details?.code === "string" && details.code.startsWith("managed_repair_");
}

function throwDecision(result: { allowed: boolean; code: string; message: string; details: Record<string, unknown> }) {
  if (result.allowed) return;
  const error = result.code === "managed_repair_wake_replay" || result.code === "managed_repair_halted"
    ? conflict(result.message, { ...result.details, code: result.code })
    : unprocessable(result.message, { ...result.details, code: result.code });
  throw error;
}

async function loadRepair(dbOrTx: Db, companyId: string, issueId: string) {
  const [row] = await dbOrTx
    .select()
    .from(issueManagedRepairs)
    .where(eq(issueManagedRepairs.issueId, issueId))
    .limit(1);
  if (!row) return null;
  if (row.companyId !== companyId) {
    throw unprocessable("Managed repair belongs to a different company.", { code: "managed_repair_company_scope" });
  }
  return mapRepair(row);
}

export async function previewManagedRepairIssueMutation(
  dbOrTx: Db,
  input: {
    companyId: string;
    issueId: string;
    fromStatus: string;
    toStatus: string;
    action: "status" | "checkout";
    humanStop?: boolean;
  },
) {
  const repair = await loadRepair(dbOrTx, input.companyId, input.issueId);
  return decideManagedRepairIssueMutation(repair, input);
}

export async function assertManagedRepairIssueMutation(
  dbOrTx: Db,
  input: {
    companyId: string;
    issueId: string;
    fromStatus: string;
    toStatus: string;
    action: "status" | "checkout";
    humanStop?: boolean;
  },
) {
  const repair = await loadRepair(dbOrTx, input.companyId, input.issueId);
  const decision = decideManagedRepairIssueMutation(repair, input);
  throwDecision(decision);
  return decision;
}

export async function assertManagedRepairWake(
  dbOrTx: Db,
  input: { companyId: string; issueId: string },
) {
  const repair = await loadRepair(dbOrTx, input.companyId, input.issueId);
  const decision = decideManagedRepairIssueMutation(repair, {
    fromStatus: "todo",
    toStatus: "in_progress",
    action: "status",
  });
  if (!repair?.enrolled) return decision;
  if (decision.code === "managed_repair_work_allowed") return decision;
  throwDecision(decision);
  return decision;
}

export async function evaluateManagedRepairDispatch(
  dbOrTx: Db,
  input: {
    companyId: string;
    issueId: string;
    source: ManagedRepairWakeSource;
    triggerId: string;
    commentBody?: string | null;
    authorType?: string | null;
    disposition?: "live" | "offline";
  },
  nested = false,
) {
  const admission = await admitManagedRepairWake(createSqlManagedRepairDatabase(dbOrTx, nested), {
    ...input,
    claimId: randomUUID(),
  });
  if (!admission.allowed) throwDecision(admission);
  return admission;
}

export async function planManagedRepairInFlightWake(
  dbOrTx: Db,
  input: {
    companyId: string;
    issueId: string;
    source: ManagedRepairWakeSource;
    triggerId: string;
  },
): Promise<"ordinary" | "join" | "defer"> {
  const repair = await loadRepair(dbOrTx, input.companyId, input.issueId);
  if (!repair?.enrolled) return "ordinary";
  const decision = decideManagedRepairIssueMutation(repair, {
    fromStatus: "todo",
    toStatus: "in_progress",
    action: "status",
  });
  throwDecision(decision);
  if (!repair.nextStepId?.trim()) return "defer";
  const intentKey = managedRepairIntentKey({
    issueId: repair.issueId,
    nextStepId: repair.nextStepId.trim(),
    authorizationVersion: repair.authorizationVersion,
    source: input.source,
    triggerId: input.triggerId,
    lastDispatchAt: repair.lastDispatchAt,
    disposition: "live",
  });
  const [claim] = await dbOrTx
    .select({ id: managedRepairWakeClaims.id })
    .from(managedRepairWakeClaims)
    .where(and(
      eq(managedRepairWakeClaims.issueId, repair.issueId),
      eq(managedRepairWakeClaims.intentKey, intentKey),
    ))
    .limit(1);
  return claim ? "join" : "defer";
}

export async function noteManagedRepairRunFailure(
  dbOrTx: Db,
  run: { id: string; companyId: string; contextSnapshot: unknown },
) {
  const snapshot = run.contextSnapshot && typeof run.contextSnapshot === "object"
    ? run.contextSnapshot as Record<string, unknown>
    : {};
  const claimId = typeof snapshot.managedRepairClaimId === "string" ? snapshot.managedRepairClaimId : null;
  if (!claimId) return null;
  return dbOrTx.transaction(async (tx) => {
    const [claimRow] = await tx
      .select()
      .from(managedRepairWakeClaims)
      .where(and(eq(managedRepairWakeClaims.id, claimId), eq(managedRepairWakeClaims.companyId, run.companyId)))
      .limit(1)
      .for("update");
    if (!claimRow) return null;
    const [repairRow] = await tx
      .select()
      .from(issueManagedRepairs)
      .where(and(eq(issueManagedRepairs.id, claimRow.repairId), eq(issueManagedRepairs.companyId, run.companyId)))
      .limit(1)
      .for("update");
    if (!repairRow) return null;
    const next = applyDispatchFailure(mapRepair(repairRow), mapClaim(claimRow));
    await tx.update(managedRepairWakeClaims).set({
      status: next.claim.status,
      failureCount: next.claim.failureCount,
      updatedAt: new Date(next.claim.updatedAt),
    }).where(eq(managedRepairWakeClaims.id, next.claim.id));
    await tx.update(issueManagedRepairs).set({
      dispatchFailureCount: next.repair.dispatchFailureCount,
      dispatchHalted: next.repair.dispatchHalted,
      updatedAt: new Date(next.repair.updatedAt),
    }).where(eq(issueManagedRepairs.id, next.repair.id));
    return next;
  });
}

async function requireIssue(dbOrTx: Db, companyId: string, issueId: string) {
  const [issue] = await dbOrTx
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .limit(1);
  if (!issue) throw notFound("Issue not found");
}

function assertGranted(decision: { allowed: boolean; code: string; message: string; details: Record<string, unknown>; repair: ManagedRepairState | null }) {
  throwDecision(decision);
  if (!decision.repair) throw unprocessable("Managed repair is not enrolled.", { code: "managed_repair_not_enrolled" });
  return decision.repair;
}

export function managedRepairControlService(db: Db) {
  return {
    async get(companyId: string, issueId: string) {
      await requireIssue(db, companyId, issueId);
      return loadRepair(db, companyId, issueId);
    },
    async enroll(companyId: string, issueId: string, input: {
      attempt: AuthorityAttempt;
      ownerUserId?: string | null;
      ownerAgentId?: string | null;
      nextStepId: string;
      nextStepText: string;
      evidencedBlocker?: { evidenceRef: string; summary: string } | null;
    }) {
      if (!explicitBoardAuthorityAccepted(input.attempt)) {
        throw unprocessable(
          "Comments, quoted instructions, reviewer PASS, statuses, runs, and coordinator claims do not enroll managed repair.",
          { code: "managed_repair_untrusted_authority" },
        );
      }
      await requireIssue(db, companyId, issueId);
      const now = new Date();
      const [row] = await db
        .insert(issueManagedRepairs)
        .values({
          companyId,
          issueId,
          enrolled: true,
          ownerUserId: input.ownerUserId ?? null,
          ownerAgentId: input.ownerAgentId ?? null,
          nextStepId: input.nextStepId,
          nextStepText: input.nextStepText,
          nextStepUpdatedAt: now,
          liveHold: true,
          evidencedBlocker: input.evidencedBlocker ?? null,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: issueManagedRepairs.issueId })
        .returning();
      if (!row) throw conflict("Managed repair is already enrolled.", { code: "managed_repair_already_enrolled" });
      return mapRepair(row);
    },
    async grant(companyId: string, issueId: string, input: { attempt: AuthorityAttempt; scope: string[]; liftHold?: boolean; clearHalt?: boolean }) {
      const current = await loadRepair(db, companyId, issueId);
      if (!current?.enrolled) throw unprocessable("Managed repair is not enrolled.", { code: "managed_repair_not_enrolled" });
      const decision = decideAuthorityGrant(current, input);
      const repair = assertGranted(decision);
      await db.update(issueManagedRepairs).set(repairPatch(repair)).where(eq(issueManagedRepairs.id, repair.id));
      return repair;
    },
    async dispatchOffline(companyId: string, issueId: string, input: { triggerId: string }) {
      const current = await loadRepair(db, companyId, issueId);
      if (!current?.enrolled) throw unprocessable("Managed repair is not enrolled.", { code: "managed_repair_not_enrolled" });
      const admission = await evaluateManagedRepairDispatch(db, {
        companyId,
        issueId,
        source: "direct",
        triggerId: input.triggerId,
        disposition: "offline",
      });
      const after = await loadRepair(db, companyId, issueId);
      return { admission, repair: after };
    },
    async setHold(companyId: string, issueId: string, input: { hold: boolean; attempt: AuthorityAttempt }) {
      const current = await loadRepair(db, companyId, issueId);
      if (!current?.enrolled) throw unprocessable("Managed repair is not enrolled.", { code: "managed_repair_not_enrolled" });
      const repair = assertGranted(decideLiveHold(current, input));
      await db.update(issueManagedRepairs).set(repairPatch(repair)).where(eq(issueManagedRepairs.id, repair.id));
      return repair;
    },
    async setStage(companyId: string, issueId: string, input: { stage: ManagedRepairStage; attempt: AuthorityAttempt }) {
      const current = await loadRepair(db, companyId, issueId);
      if (!current?.enrolled) throw unprocessable("Managed repair is not enrolled.", { code: "managed_repair_not_enrolled" });
      const verdicts = await createSqlManagedRepairDatabase(db, true).listVerdicts(companyId, current.id);
      const repair = assertGranted(decideStageTransition(current, input.stage, verdicts, input.attempt));
      await db.update(issueManagedRepairs).set(repairPatch(repair)).where(eq(issueManagedRepairs.id, repair.id));
      return repair;
    },
    async setAccountable(companyId: string, issueId: string, input: {
      attempt: AuthorityAttempt;
      ownerUserId?: string | null;
      ownerAgentId?: string | null;
      nextStepId?: string | null;
      nextStepText?: string | null;
      evidencedBlocker?: { evidenceRef: string; summary: string } | null;
    }) {
      if (!explicitBoardAuthorityAccepted(input.attempt)) {
        throw unprocessable(
          "Comments, quoted instructions, reviewer PASS, statuses, runs, and coordinator claims cannot set managed-repair accountability.",
          { code: "managed_repair_untrusted_authority" },
        );
      }
      const current = await loadRepair(db, companyId, issueId);
      if (!current?.enrolled) throw unprocessable("Managed repair is not enrolled.", { code: "managed_repair_not_enrolled" });
      const nextStepChanged = input.nextStepText != null && input.nextStepText !== current.nextStepText;
      const repair = {
        ...current,
        ownerUserId: input.ownerUserId === undefined ? current.ownerUserId : input.ownerUserId,
        ownerAgentId: input.ownerAgentId === undefined ? current.ownerAgentId : input.ownerAgentId,
        nextStepId: input.nextStepId === undefined ? current.nextStepId : input.nextStepId,
        nextStepText: input.nextStepText === undefined ? current.nextStepText : input.nextStepText,
        nextStepUpdatedAt: nextStepChanged ? new Date().toISOString() : current.nextStepUpdatedAt,
        evidencedBlocker: input.evidencedBlocker === undefined ? current.evidencedBlocker : input.evidencedBlocker,
        liveHold: current.liveHold,
        updatedAt: new Date().toISOString(),
      };
      await db.update(issueManagedRepairs).set(repairPatch(repair)).where(eq(issueManagedRepairs.id, repair.id));
      return repair;
    },
    async recordSavedResult(companyId: string, issueId: string, input: { attempt: AuthorityAttempt; version: string; evidenceRef: string }) {
      const current = await loadRepair(db, companyId, issueId);
      if (!current?.enrolled) throw unprocessable("Managed repair is not enrolled.", { code: "managed_repair_not_enrolled" });
      if (!explicitBoardAuthorityAccepted(input.attempt)) {
        throw unprocessable(
          "Comments, quoted instructions, reviewer PASS, statuses, runs, and coordinator claims cannot record saved-result evidence.",
          { code: "managed_repair_untrusted_authority" },
        );
      }
      if (!input.version.trim() || !input.evidenceRef.trim()) {
        throw unprocessable("Saved results need an exact version and evidence reference.", { code: "managed_repair_missing_saved_result" });
      }
      const repair = {
        ...current,
        savedResultVersion: input.version.trim(),
        savedResultEvidenceRef: input.evidenceRef.trim(),
        updatedAt: new Date().toISOString(),
      };
      await db.update(issueManagedRepairs).set(repairPatch(repair)).where(eq(issueManagedRepairs.id, repair.id));
      return repair;
    },
    async recordVerdict(companyId: string, issueId: string, input: {
      attempt: AuthorityAttempt;
      reviewerUserId?: string | null;
      reviewerAgentId?: string | null;
      outcome: "PASS" | "FAIL";
      artifactVersion: string;
      kind: "qa" | "note";
      source: "independent_review" | "monitor";
    }) {
      const current = await loadRepair(db, companyId, issueId);
      if (!current?.enrolled) throw unprocessable("Managed repair is not enrolled.", { code: "managed_repair_not_enrolled" });
      const decision = decideVerdictRecord(current, input);
      throwDecision(decision);
      const verdict: ManagedRepairVerdict = {
        id: randomUUID(),
        repairId: current.id,
        companyId,
        reviewerUserId: input.reviewerUserId ?? input.attempt.actorUserId ?? null,
        reviewerAgentId: input.reviewerAgentId ?? null,
        outcome: input.outcome,
        artifactVersion: input.artifactVersion,
        kind: input.kind,
        source: input.source,
        createdAt: new Date().toISOString(),
      };
      await createSqlManagedRepairDatabase(db, true).insertVerdict(verdict);
      return verdict;
    },
  };
}

export async function dispatchIdleManagedRepairNextSteps(
  db: Db,
  enqueue: (agentId: string, options: {
    source: "automation";
    triggerDetail: "system";
    reason: string;
    payload: Record<string, unknown>;
    requestedByActorType: "system";
    requestedByActorId: string;
    contextSnapshot: Record<string, unknown>;
    idempotencyKey: string;
  }) => Promise<unknown>,
  now = new Date(),
) {
  const rows = await db
    .select({
      repair: issueManagedRepairs,
      status: issues.status,
      executionRunId: issues.executionRunId,
      assigneeAgentId: issues.assigneeAgentId,
      companyStatus: companies.status,
      agentStatus: agents.status,
    })
    .from(issueManagedRepairs)
    .innerJoin(issues, and(eq(issues.id, issueManagedRepairs.issueId), eq(issues.companyId, issueManagedRepairs.companyId)))
    .innerJoin(companies, eq(companies.id, issueManagedRepairs.companyId))
    .leftJoin(agents, eq(agents.id, issues.assigneeAgentId))
    .where(and(eq(issueManagedRepairs.enrolled, true), eq(issueManagedRepairs.liveHold, false), eq(issueManagedRepairs.dispatchHalted, false), eq(companies.status, "active")));
  let enqueued = 0;
  let skipped = 0;
  for (const row of rows) {
    const state = mapRepair(row.repair);
    if (!idleNextStepDue(state, row, now) || row.agentStatus === "paused" || row.agentStatus === "terminated") {
      skipped += 1;
      continue;
    }
    try {
      const run = await enqueue(row.assigneeAgentId!, {
        source: "automation",
        triggerDetail: "system",
        reason: "managed_repair_idle_next_step",
        payload: { issueId: state.issueId, managedRepairTriggerId: `idle:${state.nextStepId}` },
        requestedByActorType: "system",
        requestedByActorId: "managed_repair_scheduler",
        idempotencyKey: `managed-repair-idle:${state.issueId}:${state.nextStepId}:${state.authorizationVersion}:${state.lastDispatchAt ?? "none"}`,
        contextSnapshot: {
          issueId: state.issueId,
          taskId: state.issueId,
          source: "managed_repair.idle_next_step",
          wakeReason: "managed_repair_idle_next_step",
        },
      });
      if (run) enqueued += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      logger.warn({ err, issueId: state.issueId }, "managed repair idle next step was not dispatched");
    }
  }
  return { scanned: rows.length, enqueued, skipped };
}
