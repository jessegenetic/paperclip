import { pgTable, uuid, text, timestamp, integer, boolean, index, primaryKey } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const providerAdmissionPools = pgTable("provider_admission_pools", {
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  poolKey: text("pool_key").notNull(),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.companyId, table.poolKey] })]);

/** Local instance run-log data; no credentials, prompt text or external telemetry. */
export const providerDispatchReceipts = pgTable("provider_dispatch_receipts", {
  runId: uuid("run_id").primaryKey().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id"),
  poolKey: text("pool_key").notNull(),
  automated: boolean("automated").notNull(),
  admittedAt: timestamp("admitted_at", { withTimezone: true }),
  eligibleAt: timestamp("eligible_at", { withTimezone: true }).notNull(),
  suppressionCount: integer("suppression_count").notNull().default(0),
  suppressionReason: text("suppression_reason"),
  outcome: text("outcome"),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("provider_dispatch_receipts_issue_window_idx").on(table.companyId, table.issueId, table.admittedAt),
  index("provider_dispatch_receipts_eligibility_idx").on(table.companyId, table.eligibleAt),
]);
