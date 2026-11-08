import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { eq, or, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agentWakeupRequests,
  agents,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueManagedRepairs,
  issues,
  managedRepairWakeClaims,
} from "@paperclipai/db";
import { hashToken } from "../lib/agent-records.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { HttpError } from "../errors.js";
import { managedRepairRoutes } from "../routes/managed-repair.js";
import { hashBearerToken } from "../services/board-auth.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createWakeQueue } from "../modules/wake-queue/index.js";
import { createHeartbeatLifecycle } from "../services/heartbeat/run-lifecycle.js";
import { issueService } from "../services/issues.js";
import { managedRepairResultChecksum } from "@paperclipai/shared";
import {
  evaluateManagedRepairDispatch,
  managedRepairControlService,
  noteManagedRepairRunFailure,
} from "../services/managed-repair-control.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const PROVEN_SOURCE = "82274853729f8c5b0f812da08595020f7eb64d66";
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) {
  throw new Error(`Isolated Postgres is required for managed repair proof: ${support.reason ?? "unsupported"}`);
}

describe("managed repair native enforcement", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("managed-repair-control-");
    db = createDb(database.connectionString);
  }, 180_000);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  function attempt(userId: string) {
    return {
      authoritySource: "explicit_board_grant" as const,
      actorType: "user" as const,
      actorUserId: userId,
    };
  }

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = `board-${randomUUID()}`;
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 8)}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      adapterType: "paperclip_runner",
      status: "idle",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    });
    await db.insert(authUsers).values({
      id: userId,
      name: "Board Operator",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
    });
    return { companyId, agentId, userId };
  }

  async function seedIssue(input: {
    companyId: string;
    agentId: string;
    title: string;
    status?: string;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: input.title,
      status: input.status ?? "todo",
      assigneeAgentId: input.agentId,
    });
    return issueId;
  }

  function httpCode(error: unknown) {
    if (!(error instanceof HttpError) || !error.details || typeof error.details !== "object") return null;
    const code = (error.details as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }

  it("applies migration 0335 after the proven npm source journal", async () => {
    const proven = JSON.parse(execFileSync("git", [
      "show",
      `${PROVEN_SOURCE}:packages/db/src/migrations/meta/_journal.json`,
    ], { encoding: "utf8" })) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const current = JSON.parse(readFileSync(new URL(
      "../../../packages/db/src/migrations/meta/_journal.json",
      import.meta.url,
    ), "utf8")) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const provenLast = proven.entries[proven.entries.length - 1]!;
    const currentPrevious = current.entries[current.entries.length - 2]!;
    const currentLast = current.entries[current.entries.length - 1]!;
    expect(provenLast).toMatchObject({ idx: 334, tag: "0334_rare_slipstream", when: 1791807836288 });
    expect(currentPrevious).toEqual(provenLast);
    expect(currentLast).toMatchObject({ idx: 335, tag: "0335_unusual_wolf_cub" });
    expect(currentLast.when).toBeGreaterThan(provenLast.when);
    const sqlText = readFileSync(new URL(
      `../../../packages/db/src/migrations/${currentLast.tag}.sql`,
      import.meta.url,
    ), "utf8");
    expect(sqlText).toContain("CREATE TABLE");
    expect(sqlText.toUpperCase()).not.toContain("DROP TABLE");
    const alteredTables = [...sqlText.matchAll(/ALTER TABLE "([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(alteredTables)).toEqual(new Set([
      "issue_managed_repairs",
      "managed_repair_verdicts",
      "managed_repair_wake_claims",
    ]));

    const result: unknown = await db.execute(sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in ('issue_managed_repairs', 'managed_repair_verdicts', 'managed_repair_wake_claims')
      order by table_name
    `);
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{ table_name: string }>;
    expect(rows.map((row) => row.table_name)).toEqual([
      "issue_managed_repairs",
      "managed_repair_verdicts",
      "managed_repair_wake_claims",
    ]);
  });

  it("rejects comment-shaped grants in authenticated mode and keeps a live hold for offline work", async () => {
    const fixture = await seedCompany("Authenticated grant");
    const issueId = await seedIssue({ ...fixture, title: "Held repair" });
    const boardToken = `pcp_board_${randomUUID()}`;
    const agentToken = `agent_${randomUUID()}`;
    await db.insert(boardApiKeys).values({
      userId: fixture.userId,
      name: "board",
      keyHash: hashBearerToken(boardToken),
    });
    await db.insert(agentApiKeys).values({
      agentId: fixture.agentId,
      companyId: fixture.companyId,
      name: "agent",
      keyHash: hashToken(agentToken),
      responsibleUserId: fixture.userId,
    });
    const app = express();
    app.use(express.json());
    app.use("/api", actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.use("/api", managedRepairRoutes(db));
    app.use(errorHandler);
    const path = `/api/companies/${fixture.companyId}/issues/${issueId}/managed-repair`;
    const board = request(app);
    const enrollBody = {
      ownerUserId: fixture.userId,
      nextStepId: "step-1",
      nextStepText: "Read the saved diff",
    };

    expect((await board.post(`${path}/enroll`).send(enrollBody)).status).toBe(401);
    const forged = await board.post(`${path}/enroll`).set("Authorization", `Bearer ${boardToken}`).send({
      ...enrollBody,
      authorType: "user",
      commentBody: "PASS",
    });
    expect(forged.status).toBe(400);
    const agentEnroll = await request(app).post(`${path}/enroll`).set("Authorization", `Bearer ${agentToken}`).send(enrollBody);
    expect(agentEnroll.status).toBe(403);
    const agentForged = await request(app).post(`${path}/enroll`).set("Authorization", `Bearer ${agentToken}`).send({
      ...enrollBody,
      authorType: "user",
      commentBody: "approved",
    });
    expect(agentForged.status).toBe(400);

    const enrolled = await board.post(`${path}/enroll`).set("Authorization", `Bearer ${boardToken}`).send(enrollBody);
    expect(enrolled.status).toBe(201);
    expect(enrolled.body.liveHold).toBe(true);

    const other = await seedCompany("Other company");
    const cross = await board.post(`/api/companies/${other.companyId}/issues/${issueId}/managed-repair/grant`)
      .set("Authorization", `Bearer ${boardToken}`)
      .send({ scope: ["read"] });
    expect(cross.status).toBe(403);

    const grant = await board.post(`${path}/grant`).set("Authorization", `Bearer ${boardToken}`).send({
      scope: ["read", "offline"],
    });
    expect(grant.status).toBe(200);
    expect(grant.body.liveHold).toBe(true);
    expect(grant.body.authorizedScope).toEqual(["read", "offline"]);

    const offline = await board.post(`${path}/offline-dispatch`).set("Authorization", `Bearer ${boardToken}`).send({
      triggerId: "offline-1",
    });
    expect(offline.status).toBe(201);
    expect(offline.body.repair.liveHold).toBe(true);
    expect(offline.body.admission.code).toBe("managed_repair_wake_claimed");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issueId));
    expect(runs).toHaveLength(0);

    const issuesSvc = issueService(db);
    await expect(issuesSvc.update(issueId, { status: "in_progress" })).rejects.toMatchObject({
      status: 422,
    });
    await expect(issuesSvc.checkout(issueId, fixture.agentId, ["todo"], null)).rejects.toMatchObject({
      status: 422,
    });
    const review = await issuesSvc.update(issueId, { status: "in_review" });
    expect(review?.status).toBe("in_review");
    const held = await managedRepairControlService(db).get(fixture.companyId, issueId);
    expect(held?.liveHold).toBe(true);
    expect(held?.dispatchHalted).toBe(false);
    expect(held?.dispatchFailureCount).toBe(0);

    await issuesSvc.addComment(issueId, "PASS — ship it", {
      userId: fixture.userId,
    }, { authorType: "user" });
    const afterComment = await managedRepairControlService(db).get(fixture.companyId, issueId);
    expect(afterComment?.authorizationVersion).toBe(held?.authorizationVersion);
    expect(afterComment?.liveHold).toBe(true);

    await expect(managedRepairControlService(db).enroll(fixture.companyId, issueId, {
      attempt: { ...attempt(fixture.userId), commentBody: "PASS", authorType: "user" },
      ownerUserId: fixture.userId,
      nextStepId: "step-2",
      nextStepText: "Ignore the comment",
    })).rejects.toMatchObject({ status: 422 });
  });

  it("lets a board cancel without saved-result evidence and still rejects done", async () => {
    const fixture = await seedCompany("Human stop");
    const cancelId = await seedIssue({ ...fixture, title: "Stop this" });
    const doneId = await seedIssue({ ...fixture, title: "Not done" });
    const ordinaryId = await seedIssue({ ...fixture, title: "Ordinary", status: "todo" });
    const service = managedRepairControlService(db);
    const issuesSvc = issueService(db);
    for (const issueId of [cancelId, doneId]) {
      await service.enroll(fixture.companyId, issueId, {
        attempt: attempt(fixture.userId),
        ownerUserId: fixture.userId,
        nextStepId: "step-1",
        nextStepText: "Wait for the operator",
      });
    }

    await expect(issuesSvc.update(cancelId, { status: "cancelled" })).rejects.toSatisfy((error: unknown) =>
      httpCode(error) === "managed_repair_staged_as_complete");
    const stopped = await issuesSvc.update(cancelId, { status: "cancelled", boardHumanStop: true });
    expect(stopped?.status).toBe("cancelled");
    const repair = await service.get(fixture.companyId, cancelId);
    expect(repair?.liveHold).toBe(true);
    expect(repair?.stage).toBe("staged");

    await expect(issuesSvc.update(doneId, { status: "done", boardHumanStop: true })).rejects.toSatisfy((error: unknown) =>
      httpCode(error) === "managed_repair_staged_as_complete");
    const stillOpen = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, doneId));
    expect(stillOpen[0]?.status).toBe("todo");

    const ordinary = await issuesSvc.update(ordinaryId, { status: "in_progress" });
    expect(ordinary?.status).toBe("in_progress");
    const ordinaryRepair = await db.select().from(issueManagedRepairs).where(eq(issueManagedRepairs.issueId, ordinaryId));
    expect(ordinaryRepair).toHaveLength(0);
  });

  it("halts on a real run failure and does not halt on an enqueue denial", async () => {
    const fixture = await seedCompany("Run failure");
    const issueId = await seedIssue({ ...fixture, title: "Fail the run" });
    const deniedId = await seedIssue({ ...fixture, title: "Denied enqueue" });
    const service = managedRepairControlService(db);
    await service.enroll(fixture.companyId, issueId, {
      attempt: attempt(fixture.userId),
      ownerUserId: fixture.userId,
      nextStepId: "step-1",
      nextStepText: "Run the checked command",
    });
    await service.grant(fixture.companyId, issueId, {
      attempt: attempt(fixture.userId),
      scope: ["execute_next_step"],
      liftHold: true,
    });
    await service.enroll(fixture.companyId, deniedId, {
      attempt: attempt(fixture.userId),
      ownerUserId: fixture.userId,
      nextStepId: "step-1",
      nextStepText: "Stay held",
    });
    await service.grant(fixture.companyId, deniedId, {
      attempt: attempt(fixture.userId),
      scope: ["execute_next_step"],
    });

    const admission = await evaluateManagedRepairDispatch(db, {
      companyId: fixture.companyId,
      issueId,
      source: "direct",
      triggerId: "run-failure-1",
    });
    expect(admission.claimId).toBeTruthy();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      issueId,
      runtimeMode: "native",
      status: "queued",
      contextSnapshot: { issueId, managedRepairClaimId: admission.claimId },
    });
    const lifecycle = createHeartbeatLifecycle(db, {
      emitTerminalAgentTaskRun() {},
    } as never);
    await lifecycle.setRunStatus(runId, "succeeded");
    expect((await service.get(fixture.companyId, issueId))?.dispatchHalted).toBe(false);
    await lifecycle.setRunStatus(runId, "failed", { error: "adapter exploded" });
    const halted = await service.get(fixture.companyId, issueId);
    expect(halted?.dispatchHalted).toBe(true);
    expect(halted?.dispatchFailureCount).toBe(1);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await noteManagedRepairRunFailure(db, run!);
    expect((await service.get(fixture.companyId, issueId))?.dispatchFailureCount).toBe(1);
    await expect(evaluateManagedRepairDispatch(db, {
      companyId: fixture.companyId,
      issueId,
      source: "direct",
      triggerId: "run-failure-2",
    })).rejects.toSatisfy((error: unknown) => httpCode(error) === "managed_repair_halted");

    await expect(issueService(db).update(deniedId, { status: "in_progress" })).rejects.toSatisfy((error: unknown) =>
      httpCode(error) === "managed_repair_live_hold");
    const denied = await service.get(fixture.companyId, deniedId);
    expect(denied?.dispatchHalted).toBe(false);
    expect(denied?.dispatchFailureCount).toBe(0);
  });

  it("lets one same-trigger claim win a transaction race", async () => {
    const fixture = await seedCompany("Claim race");
    const issueId = await seedIssue({ ...fixture, title: "Race" });
    const service = managedRepairControlService(db);
    await service.enroll(fixture.companyId, issueId, {
      attempt: attempt(fixture.userId),
      ownerUserId: fixture.userId,
      nextStepId: "step-1",
      nextStepText: "Claim this once",
    });
    await service.grant(fixture.companyId, issueId, {
      attempt: attempt(fixture.userId),
      scope: ["execute_next_step"],
      liftHold: true,
    });
    const settled = await Promise.allSettled([0, 1].map(() => db.transaction((tx) => evaluateManagedRepairDispatch(tx as unknown as typeof db, {
      companyId: fixture.companyId,
      issueId,
      source: "comment",
      triggerId: "comment-race",
    }, true))));
    const fulfilled = settled.filter((item) => item.status === "fulfilled");
    const rejected = settled.filter((item) => item.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(httpCode(rejected[0]?.status === "rejected" ? rejected[0].reason : null)).toBe("managed_repair_wake_replay");
    const claims = await db.select().from(managedRepairWakeClaims).where(eq(managedRepairWakeClaims.issueId, issueId));
    expect(claims).toHaveLength(1);
  });

  it("does not create a second run for an in-flight managed repair wake", async () => {
    const fixture = await seedCompany("In flight");
    const managedId = await seedIssue({ ...fixture, title: "Managed wake" });
    const ordinaryId = await seedIssue({ ...fixture, title: "Ordinary wake" });
    const service = managedRepairControlService(db);
    await service.enroll(fixture.companyId, managedId, {
      attempt: attempt(fixture.userId),
      ownerUserId: fixture.userId,
      nextStepId: "step-1",
      nextStepText: "Inspect the running task",
    });
    await service.grant(fixture.companyId, managedId, {
      attempt: attempt(fixture.userId),
      scope: ["execute_next_step"],
      liftHold: true,
    });
    const commentA = randomUUID();
    const commentB = randomUUID();
    const ordinaryA = randomUUID();
    const ordinaryB = randomUUID();
    await db.insert(issueComments).values([
      { id: commentA, companyId: fixture.companyId, issueId: managedId, authorType: "user", authorUserId: fixture.userId, body: "First instruction" },
      { id: commentB, companyId: fixture.companyId, issueId: managedId, authorType: "user", authorUserId: fixture.userId, body: "Second instruction" },
      { id: ordinaryA, companyId: fixture.companyId, issueId: ordinaryId, authorType: "user", authorUserId: fixture.userId, body: "Ordinary first" },
      { id: ordinaryB, companyId: fixture.companyId, issueId: ordinaryId, authorType: "user", authorUserId: fixture.userId, body: "Ordinary second" },
    ]);
    await db.insert(heartbeatRuns).values({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      status: "running",
    });
    const heartbeat = heartbeatService(db);
    const wake = (issueId: string, commentId: string, key: string) => heartbeat.wakeup(fixture.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      requestedByActorType: "user",
      requestedByActorId: fixture.userId,
      idempotencyKey: key,
      payload: { issueId, commentId },
      contextSnapshot: { issueId, wakeCommentId: commentId },
    });

    const ordinaryFirst = await wake(ordinaryId, ordinaryA, `ordinary-a-${ordinaryId}`);
    const ordinarySecond = await wake(ordinaryId, ordinaryB, `ordinary-b-${ordinaryId}`);
    expect(ordinaryFirst?.status).toBe("queued");
    expect(ordinarySecond?.id).toBe(ordinaryFirst?.id);
    const ordinaryRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, ordinaryId));
    expect(ordinaryRuns.filter((run) => run.status === "queued")).toHaveLength(1);
    expect(JSON.stringify(ordinaryRuns.find((run) => run.status === "queued")?.contextSnapshot)).toContain(ordinaryB);
    expect(await db.select().from(issueManagedRepairs).where(eq(issueManagedRepairs.issueId, ordinaryId))).toHaveLength(0);
    const ordinaryRequest = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `ordinary-b-${ordinaryId}`));
    expect(ordinaryRequest[0]?.error ?? null).not.toBe("managed_repair_wake_replay");
    expect(ordinaryRequest[0]?.status).not.toBe("deferred_issue_execution");

    const first = await wake(managedId, commentA, `managed-a-${managedId}`);
    expect(first?.status).toBe("queued");
    const sameQueued = await wake(managedId, commentA, `managed-a-again-${managedId}`);
    expect(sameQueued?.id).toBe(first?.id);
    const deferred = await wake(managedId, commentB, `managed-b-${managedId}`);
    expect(deferred).toBeNull();
    const managedRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, managedId));
    expect(managedRuns.filter((run) => run.status === "queued")).toHaveLength(1);
    expect(JSON.stringify(managedRuns.find((run) => run.id === first?.id)?.contextSnapshot)).not.toContain(commentB);

    const runningIssueId = await seedIssue({ ...fixture, title: "Running repair" });
    const runningComment = randomUUID();
    const followupComment = randomUUID();
    await db.insert(issueComments).values([
      { id: runningComment, companyId: fixture.companyId, issueId: runningIssueId, authorType: "user", authorUserId: fixture.userId, body: "Already running" },
      { id: followupComment, companyId: fixture.companyId, issueId: runningIssueId, authorType: "user", authorUserId: fixture.userId, body: "Do not start another" },
    ]);
    await service.enroll(fixture.companyId, runningIssueId, {
      attempt: attempt(fixture.userId),
      ownerUserId: fixture.userId,
      nextStepId: "step-1",
      nextStepText: "Stay on the running task",
    });
    await service.grant(fixture.companyId, runningIssueId, {
      attempt: attempt(fixture.userId),
      scope: ["execute_next_step"],
      liftHold: true,
    });
    await evaluateManagedRepairDispatch(db, {
      companyId: fixture.companyId,
      issueId: runningIssueId,
      source: "comment",
      triggerId: `comment:${runningComment}`,
    });
    const runningId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runningId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      issueId: runningIssueId,
      status: "running",
      contextSnapshot: { issueId: runningIssueId, wakeCommentId: runningComment },
    });
    const joinedRunning = await wake(runningIssueId, runningComment, `running-same-${runningIssueId}`);
    expect(joinedRunning?.id).toBe(runningId);
    const followup = await wake(runningIssueId, followupComment, `running-next-${runningIssueId}`);
    expect(followup).toBeNull();
    const runningIssueRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, runningIssueId));
    expect(runningIssueRuns).toHaveLength(1);
    expect(runningIssueRuns[0]?.status).toBe("running");

    const requests = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, fixture.agentId));
    expect(requests.some((row) => row.error === "managed_repair_wake_replay" && row.status === "coalesced")).toBe(true);
    expect(requests.find((row) => row.idempotencyKey === `managed-b-${managedId}`)?.status).toBe("deferred_issue_execution");
    expect(requests.find((row) => row.idempotencyKey === `running-next-${runningIssueId}`)?.status).toBe("deferred_issue_execution");
    const deferredPayload = requests.find((row) => row.idempotencyKey === `running-next-${runningIssueId}`)?.payload as Record<string, unknown> | null;
    const deferredContext = deferredPayload?._paperclipWakeContext as Record<string, unknown> | undefined;
    expect(deferredContext?.issueId).toBe(runningIssueId);
    expect(deferredContext?.wakeCommentId).toBe(followupComment);
    expect(JSON.stringify(deferredPayload)).toContain(followupComment);
    expect(await db.select().from(managedRepairWakeClaims).where(eq(managedRepairWakeClaims.issueId, managedId))).toHaveLength(1);
    expect(await db.select().from(managedRepairWakeClaims).where(eq(managedRepairWakeClaims.issueId, runningIssueId))).toHaveLength(1);
  }, 60_000);

  it("promotes a deferred trigger once after the current run ends, and withholds it when hold, halt, or authority fails", async () => {
    const fixture = await seedCompany("Deferred promotion");
    const service = managedRepairControlService(db);
    const queue = createWakeQueue(db, {
      resolveResponsibleUserId: async () => fixture.userId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
      wakeAdmissionHelpers: {
        filterZombieCoalesceTarget: (target) => target,
        mergeCoalescedContextSnapshot: (existing) => (
          existing && typeof existing === "object" ? existing as Record<string, unknown> : {}
        ),
        shouldDeferFollowupWakeForSameIssue: () => false,
        shouldQueueFollowupForRunningIssueWake: () => false,
      },
      recovery: {
        escalateStrandedAssignedIssue: async () => {},
        escalateStrandedRecoveryIssueInPlace: async () => {},
      },
    });
    const heartbeat = heartbeatService(db);
    await db.insert(heartbeatRuns).values({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      status: "running",
    });

    async function runsFor(issueId: string) {
      return db.select().from(heartbeatRuns).where(or(
        eq(heartbeatRuns.issueId, issueId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
      ));
    }

    async function deferBehindRunningIssue(title: string) {
      const issueId = await seedIssue({ ...fixture, title });
      const firstComment = randomUUID();
      const nextComment = randomUUID();
      await db.insert(issueComments).values([
        { id: firstComment, companyId: fixture.companyId, issueId, authorType: "user", authorUserId: fixture.userId, body: "Current task" },
        { id: nextComment, companyId: fixture.companyId, issueId, authorType: "user", authorUserId: fixture.userId, body: "Later task" },
      ]);
      await service.enroll(fixture.companyId, issueId, {
        attempt: attempt(fixture.userId),
        ownerUserId: fixture.userId,
        nextStepId: "step-1",
        nextStepText: `Finish ${title}`,
      });
      await service.grant(fixture.companyId, issueId, {
        attempt: attempt(fixture.userId),
        scope: ["execute_next_step"],
        liftHold: true,
      });
      const current = await heartbeat.wakeup(fixture.agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "issue_commented",
        requestedByActorType: "user",
        requestedByActorId: fixture.userId,
        idempotencyKey: `current-${issueId}`,
        payload: { issueId, commentId: firstComment },
        contextSnapshot: { issueId, wakeCommentId: firstComment },
      });
      expect(current?.id).toBeTruthy();
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, current!.id));
      await db.update(issues).set({ executionRunId: current!.id }).where(eq(issues.id, issueId));
      const followup = await heartbeat.wakeup(fixture.agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "issue_commented",
        requestedByActorType: "user",
        requestedByActorId: fixture.userId,
        idempotencyKey: `later-${issueId}`,
        payload: { issueId, commentId: nextComment },
        contextSnapshot: { issueId, wakeCommentId: nextComment },
      });
      expect(followup).toBeNull();
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, current!.id));
      return { issueId, runId: current!.id, nextComment };
    }

    async function release(runId: string) {
      return queue.releaseIssueExecution({
        companyId: fixture.companyId,
        runId,
        now: new Date(),
        suppressImmediateRecovery: true,
      });
    }

    const allowed = await deferBehindRunningIssue("Allowed follow-up");
    const [firstRelease, secondRelease] = await Promise.all([release(allowed.runId), release(allowed.runId)]);
    expect([firstRelease.outcome.kind, secondRelease.outcome.kind].sort()).toEqual(["promoted", "released"]);
    await release(allowed.runId);
    const allowedRuns = await runsFor(allowed.issueId);
    const promoted = allowedRuns.filter((run) => run.id !== allowed.runId);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.status).toBe("queued");
    expect(promoted[0]?.contextSnapshot).toMatchObject({
      issueId: allowed.issueId,
      wakeCommentId: allowed.nextComment,
    });
    expect(JSON.stringify(allowedRuns.find((run) => run.id === allowed.runId)?.contextSnapshot)).not.toContain(allowed.nextComment);
    expect(promoted[0]?.contextSnapshot).toHaveProperty("managedRepairClaimId");
    const allowedClaims = await db.select().from(managedRepairWakeClaims).where(eq(managedRepairWakeClaims.issueId, allowed.issueId));
    expect(allowedClaims).toHaveLength(2);
    const allowedWake = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `later-${allowed.issueId}`));
    expect(allowedWake[0]?.status).toBe("queued");
    expect(allowedWake[0]?.runId).toBe(promoted[0]?.id);

    for (const blocker of ["hold", "halt", "authority"] as const) {
      const blocked = await deferBehindRunningIssue(blocker);
      if (blocker === "hold") {
        await service.setHold(fixture.companyId, blocked.issueId, { hold: true, attempt: attempt(fixture.userId) });
      } else if (blocker === "halt") {
        await db.update(issueManagedRepairs).set({ dispatchHalted: true }).where(eq(issueManagedRepairs.issueId, blocked.issueId));
      } else {
        await db.update(issueManagedRepairs).set({
          authorizationVersion: 0,
          authorizationSource: null,
          authorizationGrantedByUserId: null,
          authorizedScope: [],
        }).where(eq(issueManagedRepairs.issueId, blocked.issueId));
      }
      const blockedRelease = await release(blocked.runId);
      expect(blockedRelease.outcome.kind).toBe("released");
      const blockedRuns = await runsFor(blocked.issueId);
      expect(blockedRuns.map((run) => run.id)).toEqual([blocked.runId]);
      const blockedWake = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `later-${blocked.issueId}`));
      expect(blockedWake[0]?.status).toBe("cancelled");
      expect(blockedWake[0]?.error).toBe("managed_repair_dispatch_denied");
      expect(blockedWake[0]?.runId).toBeNull();
      await release(blocked.runId);
      expect((await runsFor(blocked.issueId))).toHaveLength(1);
    }

    const ordinaryId = await seedIssue({ ...fixture, title: "Ordinary deferred" });
    const ordinaryRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: ordinaryRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      issueId: ordinaryId,
      status: "succeeded",
      contextSnapshot: { issueId: ordinaryId },
      responsibleUserId: fixture.userId,
    });
    await db.update(issues).set({ executionRunId: ordinaryRunId }).where(eq(issues.id, ordinaryId));
    await db.insert(agentWakeupRequests).values({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "assignment",
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: fixture.userId,
      idempotencyKey: `ordinary-later-${ordinaryId}`,
      payload: {
        issueId: ordinaryId,
        _paperclipWakeContext: { issueId: ordinaryId, wakeReason: "assignment" },
      },
    });
    const ordinaryRelease = await release(ordinaryRunId);
    expect(ordinaryRelease.outcome.kind).toBe("promoted");
    const ordinaryRuns = await runsFor(ordinaryId);
    expect(ordinaryRuns.filter((run) => run.status === "queued")).toHaveLength(1);
    expect(await db.select().from(issueManagedRepairs).where(eq(issueManagedRepairs.issueId, ordinaryId))).toHaveLength(0);
    await release(ordinaryRunId);
    expect((await runsFor(ordinaryId)).filter((run) => run.status === "queued")).toHaveLength(1);
  }, 60_000);

  function repairApp(mode: "authenticated" | "local_trusted") {
    const app = express();
    app.use(express.json());
    app.use("/api", actorMiddleware(db, { deploymentMode: mode }));
    app.use("/api", managedRepairRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("rejects unauthenticated local_trusted managed-repair admin writes", async () => {
    const fixture = await seedCompany("Local trusted");
    const issueId = await seedIssue({ ...fixture, title: "No implicit board" });
    const ordinaryId = await seedIssue({ ...fixture, title: "Ordinary local" });
    const app = repairApp("local_trusted");
    const path = `/api/companies/${fixture.companyId}/issues/${issueId}/managed-repair`;
    const bodies = [
      ["enroll", { ownerUserId: fixture.userId, nextStepId: "step-1", nextStepText: "Stay closed" }],
      ["grant", { scope: ["execute_next_step"], liftHold: true }],
      ["hold", { hold: false }],
      ["verdict", { outcome: "PASS", artifactVersion: randomUUID(), kind: "qa", source: "independent_review" }],
      ["stage", { stage: "applied" }],
      ["offline-dispatch", { triggerId: "local-offline" }],
    ] as const;
    for (const [action, body] of bodies) {
      const response = await request(app).post(`${path}/${action}`).send(body);
      expect(response.status, action).toBe(403);
    }
    expect((await db.select().from(issueManagedRepairs).where(eq(issueManagedRepairs.issueId, issueId)))).toHaveLength(0);
    const ordinary = await issueService(db).update(ordinaryId, { status: "in_progress" });
    expect(ordinary?.status).toBe("in_progress");
    expect(await db.select().from(issueManagedRepairs).where(eq(issueManagedRepairs.issueId, ordinaryId))).toHaveLength(0);
  });

  it("binds an independent verdict to the authenticated reviewer and the persisted result", async () => {
    const fixture = await seedCompany("Independent review");
    const reviewerId = `reviewer-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: reviewerId,
      name: "Independent Reviewer",
      email: `${reviewerId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId,
      principalType: "user",
      principalId: reviewerId,
      status: "active",
      membershipRole: "owner",
    });
    const issueId = await seedIssue({ ...fixture, title: "Needs a second person" });
    const ownerToken = `pcp_board_${randomUUID()}`;
    const reviewerToken = `pcp_board_${randomUUID()}`;
    await db.insert(boardApiKeys).values([
      { userId: fixture.userId, name: "owner", keyHash: hashBearerToken(ownerToken) },
      { userId: reviewerId, name: "reviewer", keyHash: hashBearerToken(reviewerToken) },
    ]);
    const result = { diff: "exact managed repair result" };
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      issueId,
      status: "succeeded",
      runtimeMode: "native",
      resultJson: result,
    });
    const app = repairApp("authenticated");
    const path = `/api/companies/${fixture.companyId}/issues/${issueId}/managed-repair`;
    const owner = request(app);
    const enroll = await owner.post(`${path}/enroll`).set("Authorization", `Bearer ${ownerToken}`).send({
      ownerUserId: fixture.userId,
      nextStepId: "step-1",
      nextStepText: "Save the exact result",
    });
    expect(enroll.status).toBe(201);
    const checksum = managedRepairResultChecksum(result);
    const prose = await owner.post(`${path}/saved-result`).set("Authorization", `Bearer ${ownerToken}`).send({
      version: runId,
      evidenceRef: "I-said-so",
    });
    expect(prose.status).toBe(400);
    const mismatched = await owner.post(`${path}/saved-result`).set("Authorization", `Bearer ${ownerToken}`).send({
      version: runId,
      evidenceRef: `sha256:${"ab".repeat(32)}`,
    });
    expect(mismatched.status).toBe(422);
    expect(mismatched.body.details?.code ?? mismatched.body.code).toBe("managed_repair_unbound_result");
    const saved = await owner.post(`${path}/saved-result`).set("Authorization", `Bearer ${ownerToken}`).send({
      version: runId,
      evidenceRef: checksum,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.savedResultVersion).toBe(runId);
    expect(saved.body.savedResultEvidenceRef).toBe(checksum);
    const spoof = await owner.post(`${path}/verdict`).set("Authorization", `Bearer ${ownerToken}`).send({
      outcome: "PASS",
      artifactVersion: runId,
      kind: "qa",
      source: "independent_review",
      reviewerUserId: reviewerId,
    });
    expect(spoof.status).toBe(400);
    const ownerVerdict = await owner.post(`${path}/verdict`).set("Authorization", `Bearer ${ownerToken}`).send({
      outcome: "PASS",
      artifactVersion: runId,
      kind: "qa",
      source: "independent_review",
    });
    expect(ownerVerdict.status).toBe(422);
    expect(ownerVerdict.body.details?.code ?? ownerVerdict.body.code).toBe("managed_repair_self_approval");
    const verdict = await request(app).post(`${path}/verdict`).set("Authorization", `Bearer ${reviewerToken}`).send({
      outcome: "PASS",
      artifactVersion: runId,
      kind: "qa",
      source: "independent_review",
    });
    expect(verdict.status).toBe(201);
    expect(verdict.body.reviewerUserId).toBe(reviewerId);
    expect(verdict.body.reviewerAgentId).toBeNull();
    const applied = await request(app).post(`${path}/stage`).set("Authorization", `Bearer ${reviewerToken}`).send({ stage: "applied" });
    expect(applied.status).toBe(200);
    const verified = await request(app).post(`${path}/stage`).set("Authorization", `Bearer ${reviewerToken}`).send({ stage: "independently_verified" });
    expect(verified.status).toBe(200);
    expect(verified.body.stage).toBe("independently_verified");
    const done = await issueService(db).update(issueId, { status: "done" });
    expect(done?.status).toBe("done");
  });

  it("cancels a held managed job and its deferred comment without reopening or a successor", async () => {
    const fixture = await seedCompany("Board cancel");
    const service = managedRepairControlService(db);
    const issuesSvc = issueService(db);
    const queue = createWakeQueue(db, {
      resolveResponsibleUserId: async () => fixture.userId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
      wakeAdmissionHelpers: {
        filterZombieCoalesceTarget: (target) => target,
        mergeCoalescedContextSnapshot: (existing) => (
          existing && typeof existing === "object" ? existing as Record<string, unknown> : {}
        ),
        shouldDeferFollowupWakeForSameIssue: () => false,
        shouldQueueFollowupForRunningIssueWake: () => false,
      },
      recovery: {
        escalateStrandedAssignedIssue: async () => {},
        escalateStrandedRecoveryIssueInPlace: async () => {},
      },
    });

    async function deferredComment(issueId: string, runId: string, status: string) {
      const commentId = randomUUID();
      await db.insert(issueComments).values({
        id: commentId,
        companyId: fixture.companyId,
        issueId,
        authorType: "user",
        authorUserId: fixture.userId,
        body: "Please continue",
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        issueId,
        status,
        runtimeMode: "native",
        contextSnapshot: { issueId },
        responsibleUserId: fixture.userId,
      });
      await db.update(issues).set({
        status: status === "cancelled" ? "done" : "in_progress",
        executionRunId: runId,
        checkoutRunId: runId,
      }).where(eq(issues.id, issueId));
      await db.insert(agentWakeupRequests).values({
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        source: "on_demand",
        triggerDetail: "manual",
        reason: "issue_commented",
        status: "deferred_issue_execution",
        requestedByActorType: "user",
        requestedByActorId: fixture.userId,
        idempotencyKey: `deferred-${issueId}`,
        payload: {
          issueId,
          commentId,
          _paperclipWakeContext: {
            issueId,
            wakeReason: "issue_commented",
            wakeCommentIds: [commentId],
          },
        },
      });
    }

    const heldId = await seedIssue({ ...fixture, title: "Held running job" });
    const heldRunId = randomUUID();
    await service.enroll(fixture.companyId, heldId, {
      attempt: attempt(fixture.userId),
      ownerUserId: fixture.userId,
      nextStepId: "step-1",
      nextStepText: "Stop this running job",
    });
    await deferredComment(heldId, heldRunId, "cancelled");
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, heldId));
    const heldRelease = await queue.releaseIssueExecution({
      companyId: fixture.companyId,
      runId: heldRunId,
      now: new Date(),
      suppressImmediateRecovery: true,
    });
    expect(heldRelease.outcome.kind).toBe("released");
    const stopped = await issuesSvc.update(heldId, { status: "cancelled", boardHumanStop: true });
    expect(stopped?.status).toBe("cancelled");
    const [heldIssue] = await db.select().from(issues).where(eq(issues.id, heldId));
    expect(heldIssue?.executionRunId).toBeNull();
    expect(heldIssue?.checkoutRunId).toBeNull();
    const heldWake = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `deferred-${heldId}`));
    expect(heldWake[0]?.status).toBe("cancelled");
    expect(heldWake[0]?.runId).toBeNull();
    const heldRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, heldId));
    expect(heldRuns.map((run) => run.id)).toEqual([heldRunId]);

    const authorizedId = await seedIssue({ ...fixture, title: "Authorized running job" });
    const authorizedRunId = randomUUID();
    await service.enroll(fixture.companyId, authorizedId, {
      attempt: attempt(fixture.userId),
      ownerUserId: fixture.userId,
      nextStepId: "step-1",
      nextStepText: "Board stop after authorization",
    });
    await service.grant(fixture.companyId, authorizedId, {
      attempt: attempt(fixture.userId),
      scope: ["execute_next_step"],
      liftHold: true,
    });
    await deferredComment(authorizedId, authorizedRunId, "cancelled");
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, authorizedId));
    await queue.releaseIssueExecution({
      companyId: fixture.companyId,
      runId: authorizedRunId,
      now: new Date(),
      suppressImmediateRecovery: true,
    });
    const authorizedStop = await issuesSvc.update(authorizedId, { status: "cancelled", boardHumanStop: true });
    expect(authorizedStop?.status).toBe("cancelled");
    const authorizedRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, authorizedId));
    expect(authorizedRuns.map((run) => run.id)).toEqual([authorizedRunId]);
    const authorizedWake = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `deferred-${authorizedId}`));
    expect(authorizedWake[0]?.status).toBe("cancelled");
    expect(authorizedWake[0]?.runId).toBeNull();

    const doneId = await seedIssue({ ...fixture, title: "Done must not reopen" });
    const doneRunId = randomUUID();
    await service.enroll(fixture.companyId, doneId, {
      attempt: attempt(fixture.userId),
      ownerUserId: fixture.userId,
      nextStepId: "step-1",
      nextStepText: "Do not reopen this",
    });
    await deferredComment(doneId, doneRunId, "cancelled");
    await expect(queue.releaseIssueExecution({
      companyId: fixture.companyId,
      runId: doneRunId,
      now: new Date(),
      suppressImmediateRecovery: true,
    })).resolves.toMatchObject({ outcome: { kind: "released" } });
    const [doneIssue] = await db.select().from(issues).where(eq(issues.id, doneId));
    expect(doneIssue?.status).toBe("done");
    expect(doneIssue?.executionRunId).toBeNull();
    const doneWake = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `deferred-${doneId}`));
    expect(doneWake[0]?.status).toBe("cancelled");
    const doneRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, doneId));
    expect(doneRuns.filter((run) => run.status === "queued")).toHaveLength(0);
  });

  it("records a failure halt in the same transaction as the terminal status", async () => {
    const fixture = await seedCompany("Atomic halt");
    const issueId = await seedIssue({ ...fixture, title: "Halt with the status" });
    const missingClaimId = await seedIssue({ ...fixture, title: "Missing claim" });
    const interruptedId = await seedIssue({ ...fixture, title: "Interrupted stop" });
    const service = managedRepairControlService(db);
    for (const id of [issueId, missingClaimId, interruptedId]) {
      await service.enroll(fixture.companyId, id, {
        attempt: attempt(fixture.userId),
        ownerUserId: fixture.userId,
        nextStepId: "step-1",
        nextStepText: "Halt only a real failure",
      });
      await service.grant(fixture.companyId, id, {
        attempt: attempt(fixture.userId),
        scope: ["execute_next_step"],
        liftHold: true,
      });
    }
    const admission = await evaluateManagedRepairDispatch(db, {
      companyId: fixture.companyId,
      issueId,
      source: "direct",
      triggerId: "atomic-failure",
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      issueId,
      status: "queued",
      runtimeMode: "native",
      contextSnapshot: { issueId, managedRepairClaimId: admission.claimId },
    });
    await expect(db.transaction(async (tx) => {
      await tx.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, runId));
      await noteManagedRepairRunFailure(tx as unknown as typeof db, {
        id: runId,
        companyId: fixture.companyId,
        issueId,
        contextSnapshot: { issueId, managedRepairClaimId: admission.claimId },
      });
      throw new Error("rollback-halt");
    })).rejects.toThrow("rollback-halt");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status).toBe("queued");
    expect((await service.get(fixture.companyId, issueId))?.dispatchHalted).toBe(false);

    const lifecycle = createHeartbeatLifecycle(db, { emitTerminalAgentTaskRun() {} } as never);
    await lifecycle.setRunStatus(runId, "interrupted");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status).toBe("interrupted");
    const interruptedRepair = await service.get(fixture.companyId, issueId);
    expect(interruptedRepair?.dispatchHalted).toBe(false);
    expect(interruptedRepair?.dispatchFailureCount).toBe(0);
    expect(interruptedRepair?.liveHold).toBe(true);
    expect(interruptedRepair?.authorizationSource).toBeNull();
    expect(interruptedRepair?.authorizationGrantedByUserId).toBeNull();

    await lifecycle.setRunStatus(runId, "failed", { error: "adapter exploded" });
    const halted = await service.get(fixture.companyId, issueId);
    expect(halted?.dispatchHalted).toBe(true);
    expect(halted?.dispatchFailureCount).toBe(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status).toBe("failed");
    await expect(evaluateManagedRepairDispatch(db, {
      companyId: fixture.companyId,
      issueId,
      source: "automatic",
      triggerId: "after-failure",
    })).rejects.toSatisfy((error: unknown) => httpCode(error) === "managed_repair_not_accountable");
    const queue = createWakeQueue(db, {
      resolveResponsibleUserId: async () => fixture.userId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
      wakeAdmissionHelpers: {
        filterZombieCoalesceTarget: (target) => target,
        mergeCoalescedContextSnapshot: (existing) => (
          existing && typeof existing === "object" ? existing as Record<string, unknown> : {}
        ),
        shouldDeferFollowupWakeForSameIssue: () => false,
        shouldQueueFollowupForRunningIssueWake: () => false,
      },
      recovery: {
        escalateStrandedAssignedIssue: async () => {},
        escalateStrandedRecoveryIssueInPlace: async () => {},
      },
    });
    await db.update(issues).set({ executionRunId: runId, status: "in_progress" }).where(eq(issues.id, issueId));
    const released = await queue.releaseIssueExecution({
      companyId: fixture.companyId,
      runId,
      now: new Date(),
      suppressImmediateRecovery: true,
    });
    expect(released.outcome.kind).not.toBe("promoted");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issueId));
    expect(runs.map((run) => run.id)).toEqual([runId]);

    const missingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: missingRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      issueId: missingClaimId,
      status: "running",
      runtimeMode: "native",
      contextSnapshot: { issueId: missingClaimId },
    });
    await lifecycle.setRunStatus(missingRunId, "timed_out", { error: "timed out" });
    const missing = await service.get(fixture.companyId, missingClaimId);
    expect(missing?.dispatchHalted).toBe(true);
    expect(missing?.dispatchFailureCount).toBe(1);
    await noteManagedRepairRunFailure(db, {
      id: missingRunId,
      companyId: fixture.companyId,
      issueId: missingClaimId,
      contextSnapshot: { issueId: missingClaimId },
    });
    expect((await service.get(fixture.companyId, missingClaimId))?.dispatchFailureCount).toBe(1);

    const interruptedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: interruptedRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      issueId: interruptedId,
      status: "running",
      runtimeMode: "native",
      contextSnapshot: { issueId: interruptedId },
    });
    await lifecycle.setRunStatus(interruptedRunId, "interrupted");
    const stopped = await service.get(fixture.companyId, interruptedId);
    expect(stopped?.dispatchHalted).toBe(false);
    expect(stopped?.liveHold).toBe(true);
    expect(stopped?.authorizationGrantedByUserId).toBeNull();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, interruptedId))).map((run) => run.status)).toEqual(["interrupted"]);
  });

  it("does not resume an interrupted managed repair through shutdown, release, or retry", async () => {
    const fixture = await seedCompany("Interrupt resume");
    const issueId = await seedIssue({ ...fixture, title: "Interrupted managed job" });
    const service = managedRepairControlService(db);
    await service.enroll(fixture.companyId, issueId, {
      attempt: attempt(fixture.userId),
      ownerUserId: fixture.userId,
      nextStepId: "step-1",
      nextStepText: "Do not continue after interrupt",
    });
    await service.grant(fixture.companyId, issueId, {
      attempt: attempt(fixture.userId),
      scope: ["execute_next_step"],
      liftHold: true,
    });
    const runId = randomUUID();
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId: fixture.companyId,
      issueId,
      authorType: "user",
      authorUserId: fixture.userId,
      body: "Continue after the shutdown",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      issueId,
      status: "running",
      runtimeMode: "legacy",
      contextSnapshot: { issueId },
      resultJson: { conversationContinuation: "continue_conversation_v1" },
      responsibleUserId: fixture.userId,
    });
    await db.update(issues).set({
      status: "in_progress",
      executionRunId: runId,
      checkoutRunId: runId,
    }).where(eq(issues.id, issueId));
    await db.insert(agentWakeupRequests).values({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: fixture.userId,
      idempotencyKey: `interrupt-deferred-${issueId}`,
      payload: {
        issueId,
        commentId,
        _paperclipWakeContext: {
          issueId,
          wakeReason: "issue_commented",
          wakeCommentIds: [commentId],
        },
      },
    });

    const heartbeat = heartbeatService(db);
    const drained = await heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), [runId]);
    expect(drained.interruptedRunIds).toEqual([runId]);
    expect(drained.retryRunIds).toEqual([]);
    const repair = await service.get(fixture.companyId, issueId);
    expect(repair?.dispatchHalted).toBe(false);
    expect(repair?.dispatchFailureCount).toBe(0);
    expect(repair?.liveHold).toBe(true);
    expect(repair?.authorizationSource).toBeNull();
    expect(repair?.authorizationGrantedByUserId).toBeNull();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `interrupt-deferred-${issueId}`));
    expect(wake?.status).toBe("cancelled");
    expect(wake?.runId).toBeNull();
    const managedRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issueId));
    expect(managedRuns.map((run) => run.status)).toEqual(["interrupted"]);

    const retried = await heartbeat.scheduleBoundedRetry(runId);
    expect(retried.outcome).toBe("not_scheduled");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issueId))).map((run) => run.id)).toEqual([runId]);

    const nativeRunId = randomUUID();
    const nativeIssueId = await seedIssue({ ...fixture, title: "Native interrupted release" });
    await service.enroll(fixture.companyId, nativeIssueId, {
      attempt: attempt(fixture.userId),
      ownerUserId: fixture.userId,
      nextStepId: "step-1",
      nextStepText: "Do not promote the deferred comment",
    });
    await service.grant(fixture.companyId, nativeIssueId, {
      attempt: attempt(fixture.userId),
      scope: ["execute_next_step"],
      liftHold: true,
    });
    const nativeCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: nativeCommentId,
      companyId: fixture.companyId,
      issueId: nativeIssueId,
      authorType: "user",
      authorUserId: fixture.userId,
      body: "Still waiting",
    });
    await db.insert(heartbeatRuns).values({
      id: nativeRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      issueId: nativeIssueId,
      status: "running",
      runtimeMode: "native",
      contextSnapshot: { issueId: nativeIssueId },
      resultJson: { conversationContinuation: "continue_conversation_v1" },
      responsibleUserId: fixture.userId,
    });
    await db.update(issues).set({
      status: "in_progress",
      executionRunId: nativeRunId,
      checkoutRunId: nativeRunId,
    }).where(eq(issues.id, nativeIssueId));
    await db.insert(agentWakeupRequests).values({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: fixture.userId,
      idempotencyKey: `native-interrupt-${nativeIssueId}`,
      payload: {
        issueId: nativeIssueId,
        commentId: nativeCommentId,
        _paperclipWakeContext: {
          issueId: nativeIssueId,
          wakeReason: "issue_commented",
          wakeCommentIds: [nativeCommentId],
        },
      },
    });
    const lifecycle = createHeartbeatLifecycle(db, { emitTerminalAgentTaskRun() {} } as never);
    await lifecycle.setRunStatus(nativeRunId, "interrupted");
    const queue = createWakeQueue(db, {
      resolveResponsibleUserId: async () => fixture.userId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
      wakeAdmissionHelpers: {
        filterZombieCoalesceTarget: (target) => target,
        mergeCoalescedContextSnapshot: (existing) => (
          existing && typeof existing === "object" ? existing as Record<string, unknown> : {}
        ),
        shouldDeferFollowupWakeForSameIssue: () => false,
        shouldQueueFollowupForRunningIssueWake: () => false,
      },
      recovery: {
        escalateStrandedAssignedIssue: async () => {},
        escalateStrandedRecoveryIssueInPlace: async () => {},
      },
    });
    const released = await queue.releaseIssueExecution({
      companyId: fixture.companyId,
      runId: nativeRunId,
      now: new Date(),
    });
    expect(released.outcome.kind).toBe("released");
    expect(released.postCommitEffects.some((effect) => effect.kind === "conversation_retry_requested")).toBe(false);
    expect(released.postCommitEffects.some((effect) => effect.kind === "run_queued")).toBe(false);
    const [nativeWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `native-interrupt-${nativeIssueId}`));
    expect(nativeWake?.status).toBe("cancelled");
    expect(nativeWake?.runId).toBeNull();
    const nativeRetry = await heartbeat.scheduleBoundedRetry(nativeRunId);
    expect(nativeRetry.outcome).toBe("not_scheduled");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, nativeIssueId))).map((run) => run.id)).toEqual([nativeRunId]);

    await service.grant(fixture.companyId, issueId, {
      attempt: attempt(fixture.userId),
      scope: ["execute_next_step"],
      liftHold: true,
    });
    await expect(evaluateManagedRepairDispatch(db, {
      companyId: fixture.companyId,
      issueId,
      source: "automatic",
      triggerId: "fresh-grant-after-interrupt",
    })).resolves.toMatchObject({ allowed: true });
    const retryAfterGrant = await heartbeat.scheduleBoundedRetry(runId);
    expect(retryAfterGrant.outcome).toBe("not_scheduled");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issueId))).map((run) => run.status)).toEqual(["interrupted"]);

    const ordinaryId = await seedIssue({ ...fixture, title: "Ordinary shutdown" });
    const ordinaryRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: ordinaryRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      issueId: ordinaryId,
      status: "running",
      runtimeMode: "legacy",
      contextSnapshot: { issueId: ordinaryId },
      resultJson: { conversationContinuation: "continue_conversation_v1" },
      responsibleUserId: fixture.userId,
    });
    await db.update(issues).set({
      status: "in_progress",
      executionRunId: ordinaryRunId,
      checkoutRunId: ordinaryRunId,
    }).where(eq(issues.id, ordinaryId));
    const ordinary = await heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), [ordinaryRunId]);
    expect(ordinary.interruptedRunIds).toEqual([ordinaryRunId]);
    expect(ordinary.retryRunIds).toHaveLength(1);
    const ordinaryRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, ordinaryId));
    expect(ordinaryRuns.map((run) => run.status).sort()).toEqual(["interrupted", "scheduled_retry"]);
    const [ordinaryRepair] = await db.select().from(issueManagedRepairs).where(eq(issueManagedRepairs.issueId, ordinaryId));
    expect(ordinaryRepair).toBeUndefined();
  }, 60_000);

  it("startup recovery leaves a held assigned repair unwoken and still wakes eligible work", async () => {
    const isolated = await startEmbeddedPostgresTestDatabase("managed-repair-startup-");
    const isolatedDb = createDb(isolated.connectionString);
    try {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const userId = `board-${randomUUID()}`;
      const now = new Date();
      await isolatedDb.insert(companies).values({
        id: companyId,
        name: "Startup held repair",
        issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 8)}`,
      });
      await isolatedDb.insert(agents).values({
        id: agentId,
        companyId,
        name: "Inert synthetic worker",
        role: "engineer",
        adapterType: "paperclip_runner",
        status: "idle",
        runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 1 } },
      });
      await isolatedDb.insert(authUsers).values({
        id: userId,
        name: "Board Operator",
        email: `${userId}@example.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      await isolatedDb.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: "owner",
      });
      const heldId = randomUUID();
      const ordinaryId = randomUUID();
      const eligibleId = randomUUID();
      await isolatedDb.insert(issues).values([
        { id: heldId, companyId, title: "Held assigned self approval", status: "todo", assigneeAgentId: agentId },
        { id: ordinaryId, companyId, title: "Ordinary assigned", status: "todo", assigneeAgentId: agentId },
        { id: eligibleId, companyId, title: "Eligible managed", status: "todo", assigneeAgentId: agentId },
      ]);
      const service = managedRepairControlService(isolatedDb);
      const boardAttempt = attempt(userId);
      await service.enroll(companyId, heldId, {
        attempt: boardAttempt,
        ownerUserId: userId,
        nextStepId: "step-1",
        nextStepText: "Must not self approve",
      });
      const priorRunId = randomUUID();
      await isolatedDb.insert(heartbeatRuns).values({
        id: priorRunId,
        companyId,
        agentId,
        issueId: heldId,
        status: "succeeded",
        runtimeMode: "native",
        resultJson: { test: "exact-fixture-result" },
      });
      await service.enroll(companyId, eligibleId, {
        attempt: boardAttempt,
        ownerAgentId: agentId,
        nextStepId: "step-1",
        nextStepText: "Authorized next step",
      });
      await service.grant(companyId, eligibleId, {
        attempt: boardAttempt,
        scope: ["execute_next_step"],
        liftHold: true,
      });

      const heartbeat = heartbeatService(isolatedDb);
      const first = await heartbeat.reconcileStrandedAssignedIssues();
      await heartbeat.drainActiveRunExecutions();
      expect(first.issueIds).toEqual(expect.arrayContaining([ordinaryId, eligibleId]));
      expect(first.issueIds).not.toContain(heldId);
      expect(first.assignmentDispatched).toBe(2);

      const heldRuns = await isolatedDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, heldId));
      expect(heldRuns.map((run) => run.id)).toEqual([priorRunId]);
      const [heldRepair] = await isolatedDb.select().from(issueManagedRepairs).where(eq(issueManagedRepairs.issueId, heldId));
      expect(heldRepair?.liveHold).toBe(true);
      expect(heldRepair?.authorizationSource).toBeNull();
      const [heldIssue] = await isolatedDb.select().from(issues).where(eq(issues.id, heldId));
      expect(heldIssue?.status).toBe("todo");

      const ordinaryRuns = await isolatedDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, ordinaryId));
      expect(ordinaryRuns.some((run) => run.invocationSource === "assignment")).toBe(true);
      const eligibleRuns = await isolatedDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, eligibleId));
      expect(eligibleRuns.some((run) => run.invocationSource === "assignment")).toBe(true);
      const [eligibleRepair] = await isolatedDb.select().from(issueManagedRepairs).where(eq(issueManagedRepairs.issueId, eligibleId));
      expect(eligibleRepair?.liveHold).toBe(false);

      await expect(evaluateManagedRepairDispatch(isolatedDb, {
        companyId,
        issueId: heldId,
        source: "automatic",
        triggerId: "startup-still-denied",
      })).rejects.toSatisfy((error: unknown) => httpCode(error) === "managed_repair_not_accountable");

      const second = await heartbeat.reconcileStrandedAssignedIssues();
      await heartbeat.drainActiveRunExecutions();
      expect(second.issueIds).not.toContain(heldId);
      const heldAfter = await isolatedDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, heldId));
      expect(heldAfter.map((run) => run.id)).toEqual([priorRunId]);
    } finally {
      await isolatedDb.$client.end();
      await isolated.cleanup();
    }
  }, 120_000);

  it("fails closed when the managed repair table is absent", async () => {
    const fixture = await seedCompany("Missing migration");
    const ordinaryId = await seedIssue({ ...fixture, title: "Ordinary while present" });
    const moved = await issueService(db).update(ordinaryId, { status: "in_progress" });
    expect(moved?.status).toBe("in_progress");
    await db.execute(sql`alter table issue_managed_repairs rename to issue_managed_repairs_absent`);
    try {
      await expect(issueService(db).update(ordinaryId, { status: "done" })).rejects.toThrow();
      const [row] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, ordinaryId));
      expect(row?.status).toBe("in_progress");
      await expect(evaluateManagedRepairDispatch(db, {
        companyId: fixture.companyId,
        issueId: ordinaryId,
        source: "automatic",
        triggerId: "missing-table",
      })).rejects.toThrow();
    } finally {
      await db.execute(sql`alter table issue_managed_repairs_absent rename to issue_managed_repairs`);
    }
  });
});
