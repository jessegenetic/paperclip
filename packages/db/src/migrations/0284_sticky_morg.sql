CREATE TABLE "provider_admission_pools" (
	"company_id" uuid NOT NULL,
	"pool_key" text NOT NULL,
	"cooldown_until" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_admission_pools_company_id_pool_key_pk" PRIMARY KEY("company_id","pool_key")
);
--> statement-breakpoint
CREATE TABLE "provider_dispatch_receipts" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid,
	"pool_key" text NOT NULL,
	"automated" boolean NOT NULL,
	"admitted_at" timestamp with time zone,
	"eligible_at" timestamp with time zone NOT NULL,
	"suppression_count" integer DEFAULT 0 NOT NULL,
	"suppression_reason" text,
	"outcome" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_admission_pools" ADD CONSTRAINT "provider_admission_pools_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_dispatch_receipts" ADD CONSTRAINT "provider_dispatch_receipts_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_dispatch_receipts" ADD CONSTRAINT "provider_dispatch_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_dispatch_receipts_issue_window_idx" ON "provider_dispatch_receipts" USING btree ("company_id","issue_id","admitted_at");--> statement-breakpoint
CREATE INDEX "provider_dispatch_receipts_eligibility_idx" ON "provider_dispatch_receipts" USING btree ("company_id","eligible_at");