CREATE TABLE "issue_managed_repairs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"enrolled" boolean DEFAULT true NOT NULL,
	"owner_user_id" text,
	"owner_agent_id" uuid,
	"next_step_id" text,
	"next_step_text" text,
	"next_step_updated_at" timestamp with time zone,
	"stage" text DEFAULT 'staged' NOT NULL,
	"live_hold" boolean DEFAULT true NOT NULL,
	"authorization_version" integer DEFAULT 0 NOT NULL,
	"authorized_scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"authorization_source" text,
	"authorization_granted_by_user_id" text,
	"saved_result_version" text,
	"saved_result_evidence_ref" text,
	"evidenced_blocker" jsonb,
	"idle_threshold_ms" integer DEFAULT 1200000 NOT NULL,
	"max_dispatch_failures" integer DEFAULT 1 NOT NULL,
	"dispatch_failure_count" integer DEFAULT 0 NOT NULL,
	"dispatch_halted" boolean DEFAULT false NOT NULL,
	"last_dispatch_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_managed_repairs_stage_check" CHECK ("issue_managed_repairs"."stage" in ('staged', 'reviewed', 'applied', 'independently_verified', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "managed_repair_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"repair_id" uuid NOT NULL,
	"reviewer_user_id" text,
	"reviewer_agent_id" uuid,
	"outcome" text NOT NULL,
	"artifact_version" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_repair_verdicts_outcome_check" CHECK ("managed_repair_verdicts"."outcome" in ('PASS', 'FAIL')),
	CONSTRAINT "managed_repair_verdicts_kind_check" CHECK ("managed_repair_verdicts"."kind" in ('qa', 'note')),
	CONSTRAINT "managed_repair_verdicts_source_check" CHECK ("managed_repair_verdicts"."source" in ('independent_review', 'monitor'))
);
--> statement-breakpoint
CREATE TABLE "managed_repair_wake_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"repair_id" uuid NOT NULL,
	"intent_key" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'dispatched' NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_repair_wake_claims_status_check" CHECK ("managed_repair_wake_claims"."status" in ('claimed', 'dispatched', 'failed', 'halted')),
	CONSTRAINT "managed_repair_wake_claims_source_check" CHECK ("managed_repair_wake_claims"."source" in ('direct', 'comment', 'idle_next_step', 'automatic'))
);
--> statement-breakpoint
ALTER TABLE "issue_managed_repairs" ADD CONSTRAINT "issue_managed_repairs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_managed_repairs" ADD CONSTRAINT "issue_managed_repairs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_managed_repairs" ADD CONSTRAINT "issue_managed_repairs_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_repair_verdicts" ADD CONSTRAINT "managed_repair_verdicts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_repair_verdicts" ADD CONSTRAINT "managed_repair_verdicts_repair_id_issue_managed_repairs_id_fk" FOREIGN KEY ("repair_id") REFERENCES "public"."issue_managed_repairs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_repair_verdicts" ADD CONSTRAINT "managed_repair_verdicts_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_repair_wake_claims" ADD CONSTRAINT "managed_repair_wake_claims_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_repair_wake_claims" ADD CONSTRAINT "managed_repair_wake_claims_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_repair_wake_claims" ADD CONSTRAINT "managed_repair_wake_claims_repair_id_issue_managed_repairs_id_fk" FOREIGN KEY ("repair_id") REFERENCES "public"."issue_managed_repairs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_managed_repairs_issue_uq" ON "issue_managed_repairs" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_managed_repairs_company_issue_uq" ON "issue_managed_repairs" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_managed_repairs_idle_scan_idx" ON "issue_managed_repairs" USING btree ("enrolled","live_hold","dispatch_halted");--> statement-breakpoint
CREATE INDEX "managed_repair_verdicts_repair_idx" ON "managed_repair_verdicts" USING btree ("company_id","repair_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_repair_wake_claims_issue_intent_uq" ON "managed_repair_wake_claims" USING btree ("issue_id","intent_key");