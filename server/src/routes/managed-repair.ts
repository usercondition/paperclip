import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  boardManagedRepairActor,
  EXPLICIT_BOARD_AUTHORITY_SOURCE,
  type AuthorityAttempt,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { managedRepairControlService } from "../services/managed-repair-control.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const scopeSchema = z.enum(["read", "offline", "mutate_status", "checkout", "execute_next_step"]);
const blockerSchema = z.object({
  evidenceRef: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(4_000),
}).strict();

const enrollSchema = z.object({
  ownerUserId: z.string().trim().min(1).max(200).nullable().optional(),
  ownerAgentId: z.string().uuid().nullable().optional(),
  nextStepId: z.string().trim().min(1).max(200),
  nextStepText: z.string().trim().min(8).max(4_000),
  evidencedBlocker: blockerSchema.nullable().optional(),
}).strict();

const grantSchema = z.object({
  scope: z.array(scopeSchema).min(1),
  liftHold: z.boolean().optional(),
  clearHalt: z.boolean().optional(),
}).strict();

const holdSchema = z.object({ hold: z.boolean() }).strict();
const offlineSchema = z.object({ triggerId: z.string().trim().min(1).max(200) }).strict();

const accountableSchema = z.object({
  ownerUserId: z.string().trim().min(1).max(200).nullable().optional(),
  ownerAgentId: z.string().uuid().nullable().optional(),
  nextStepId: z.string().trim().min(1).max(200).nullable().optional(),
  nextStepText: z.string().trim().min(8).max(4_000).nullable().optional(),
  evidencedBlocker: blockerSchema.nullable().optional(),
}).strict();

const savedResultSchema = z.object({
  version: z.string().uuid(),
  evidenceRef: z.string().trim().regex(/^sha256:[a-f0-9]{64}$/i),
}).strict();

const verdictSchema = z.object({
  outcome: z.enum(["PASS", "FAIL"]),
  artifactVersion: z.string().trim().min(1).max(500),
  kind: z.enum(["qa", "note"]),
  source: z.enum(["independent_review", "monitor"]),
}).strict();

const stageSchema = z.object({
  stage: z.enum(["staged", "reviewed", "applied", "independently_verified", "closed"]),
}).strict();

function boardAttempt(req: Parameters<typeof assertBoard>[0]): AuthorityAttempt {
  assertBoard(req);
  const actor = boardManagedRepairActor({
    type: req.actor.type,
    userId: req.actor.userId ?? null,
    source: req.actor.source ?? null,
  });
  if (!actor) throw forbidden("Board authority is required for managed repair.");
  return {
    authoritySource: EXPLICIT_BOARD_AUTHORITY_SOURCE,
    actorType: actor.actorType,
    actorUserId: actor.actorUserId,
  };
}

export function managedRepairRoutes(db: Db) {
  const router = Router();
  const svc = managedRepairControlService(db);
  const companyId = (req: Request) => {
    const value = req.params.companyId;
    return typeof value === "string" ? value : "";
  };
  const issueId = (req: Request) => {
    const value = req.params.issueId;
    return typeof value === "string" ? value : "";
  };

  router.get("/companies/:companyId/issues/:issueId/managed-repair", async (req, res) => {
    assertCompanyAccess(req, companyId(req));
    assertBoard(req);
    res.json(await svc.get(companyId(req), issueId(req)));
  });

  router.post("/companies/:companyId/issues/:issueId/managed-repair/enroll", validate(enrollSchema), async (req, res) => {
    assertCompanyAccess(req, companyId(req));
    const repair = await svc.enroll(companyId(req), issueId(req), { ...req.body, attempt: boardAttempt(req) });
    res.status(201).json(repair);
  });

  router.post("/companies/:companyId/issues/:issueId/managed-repair/grant", validate(grantSchema), async (req, res) => {
    assertCompanyAccess(req, companyId(req));
    res.json(await svc.grant(companyId(req), issueId(req), { ...req.body, attempt: boardAttempt(req) }));
  });

  router.post("/companies/:companyId/issues/:issueId/managed-repair/offline-dispatch", validate(offlineSchema), async (req, res) => {
    assertCompanyAccess(req, companyId(req));
    boardAttempt(req);
    res.status(201).json(await svc.dispatchOffline(companyId(req), issueId(req), { triggerId: req.body.triggerId }));
  });

  router.post("/companies/:companyId/issues/:issueId/managed-repair/hold", validate(holdSchema), async (req, res) => {
    assertCompanyAccess(req, companyId(req));
    res.json(await svc.setHold(companyId(req), issueId(req), { hold: req.body.hold, attempt: boardAttempt(req) }));
  });

  router.post("/companies/:companyId/issues/:issueId/managed-repair/accountable", validate(accountableSchema), async (req, res) => {
    assertCompanyAccess(req, companyId(req));
    res.json(await svc.setAccountable(companyId(req), issueId(req), { ...req.body, attempt: boardAttempt(req) }));
  });

  router.post("/companies/:companyId/issues/:issueId/managed-repair/saved-result", validate(savedResultSchema), async (req, res) => {
    assertCompanyAccess(req, companyId(req));
    res.json(await svc.recordSavedResult(companyId(req), issueId(req), { ...req.body, attempt: boardAttempt(req) }));
  });

  router.post("/companies/:companyId/issues/:issueId/managed-repair/verdict", validate(verdictSchema), async (req, res) => {
    assertCompanyAccess(req, companyId(req));
    res.status(201).json(await svc.recordVerdict(companyId(req), issueId(req), { ...req.body, attempt: boardAttempt(req) }));
  });

  router.post("/companies/:companyId/issues/:issueId/managed-repair/stage", validate(stageSchema), async (req, res) => {
    assertCompanyAccess(req, companyId(req));
    res.json(await svc.setStage(companyId(req), issueId(req), { stage: req.body.stage, attempt: boardAttempt(req) }));
  });

  return router;
}
