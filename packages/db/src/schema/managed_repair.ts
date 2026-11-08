import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const issueManagedRepairs = pgTable(
  "issue_managed_repairs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    enrolled: boolean("enrolled").notNull().default(true),
    ownerUserId: text("owner_user_id"),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    nextStepId: text("next_step_id"),
    nextStepText: text("next_step_text"),
    nextStepUpdatedAt: timestamp("next_step_updated_at", { withTimezone: true }),
    stage: text("stage").notNull().default("staged"),
    liveHold: boolean("live_hold").notNull().default(true),
    authorizationVersion: integer("authorization_version").notNull().default(0),
    authorizedScope: jsonb("authorized_scope").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    authorizationSource: text("authorization_source"),
    authorizationGrantedByUserId: text("authorization_granted_by_user_id"),
    savedResultVersion: text("saved_result_version"),
    savedResultEvidenceRef: text("saved_result_evidence_ref"),
    evidencedBlocker: jsonb("evidenced_blocker").$type<{ evidenceRef: string; summary: string } | null>(),
    idleThresholdMs: integer("idle_threshold_ms").notNull().default(1_200_000),
    maxDispatchFailures: integer("max_dispatch_failures").notNull().default(1),
    dispatchFailureCount: integer("dispatch_failure_count").notNull().default(0),
    dispatchHalted: boolean("dispatch_halted").notNull().default(false),
    lastDispatchAt: timestamp("last_dispatch_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueUq: uniqueIndex("issue_managed_repairs_issue_uq").on(table.issueId),
    companyIssueUq: uniqueIndex("issue_managed_repairs_company_issue_uq").on(table.companyId, table.issueId),
    idleScanIdx: index("issue_managed_repairs_idle_scan_idx").on(table.enrolled, table.liveHold, table.dispatchHalted),
    stageCheck: check(
      "issue_managed_repairs_stage_check",
      sql`${table.stage} in ('staged', 'reviewed', 'applied', 'independently_verified', 'closed')`,
    ),
  }),
);

export const managedRepairVerdicts = pgTable(
  "managed_repair_verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    repairId: uuid("repair_id").notNull().references(() => issueManagedRepairs.id, { onDelete: "cascade" }),
    reviewerUserId: text("reviewer_user_id"),
    reviewerAgentId: uuid("reviewer_agent_id").references(() => agents.id, { onDelete: "set null" }),
    outcome: text("outcome").notNull(),
    artifactVersion: text("artifact_version").notNull(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    repairIdx: index("managed_repair_verdicts_repair_idx").on(table.companyId, table.repairId, table.createdAt),
    outcomeCheck: check("managed_repair_verdicts_outcome_check", sql`${table.outcome} in ('PASS', 'FAIL')`),
    kindCheck: check("managed_repair_verdicts_kind_check", sql`${table.kind} in ('qa', 'note')`),
    sourceCheck: check(
      "managed_repair_verdicts_source_check",
      sql`${table.source} in ('independent_review', 'monitor')`,
    ),
  }),
);

export const managedRepairWakeClaims = pgTable(
  "managed_repair_wake_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    repairId: uuid("repair_id").notNull().references(() => issueManagedRepairs.id, { onDelete: "cascade" }),
    intentKey: text("intent_key").notNull(),
    source: text("source").notNull(),
    status: text("status").notNull().default("dispatched"),
    failureCount: integer("failure_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    intentUq: uniqueIndex("managed_repair_wake_claims_issue_intent_uq").on(table.issueId, table.intentKey),
    statusCheck: check(
      "managed_repair_wake_claims_status_check",
      sql`${table.status} in ('claimed', 'dispatched', 'failed', 'halted')`,
    ),
    sourceCheck: check(
      "managed_repair_wake_claims_source_check",
      sql`${table.source} in ('direct', 'comment', 'idle_next_step', 'automatic')`,
    ),
  }),
);
