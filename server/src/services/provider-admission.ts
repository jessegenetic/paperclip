import { and, eq, gt, isNotNull, sql } from "drizzle-orm";
import { type Db, agents, agentWakeupRequests, heartbeatRuns, issues,
  providerAdmissionPools, providerDispatchReceipts } from "@paperclipai/db";
import { AUTOMATED_ISSUE_DISPATCH_WINDOW_MS, SHARED_PROVIDER_POOL,
  providerAdmissionEligibility } from "./provider-admission-policy.js";
import { computeProviderRetrySchedule } from "./provider-retry-policy.js";

type AdmissionTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function lockPool(tx: AdmissionTransaction, companyId: string, now: Date) {
  await tx.insert(providerAdmissionPools).values({ companyId, poolKey: SHARED_PROVIDER_POOL, updatedAt: now })
    .onConflictDoNothing();
  const [pool] = await tx.select().from(providerAdmissionPools).where(and(
    eq(providerAdmissionPools.companyId, companyId), eq(providerAdmissionPools.poolKey, SHARED_PROVIDER_POOL),
  )).for("update");
  if (!pool) throw new Error("Provider admission pool missing");
  return pool;
}

/** Every decision and its receipt commit together. No provider work runs in this transaction. */
export function providerAdmissionService(db: Db) {
  return {
    async reserve(companyId: string, runId: string, now = new Date()) {
      return db.transaction(async (tx) => {
        const pool = await lockPool(tx, companyId, now);
        const [run] = await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId),
        )).for("update");
        if (!run || !["queued", "running"].includes(run.status)) return { kind: "stale" as const };
        // Resolve authority from persisted runtime records; wake JSON never selects an account or exemption.
        const [agent] = await tx.select({ id: agents.id }).from(agents).where(and(
          eq(agents.companyId, companyId), eq(agents.id, run.agentId),
        ));
        if (!agent) throw new Error("Provider admission agent boundary mismatch");
        const [wake] = run.wakeupRequestId ? await tx.select().from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.id, run.wakeupRequestId),
          eq(agentWakeupRequests.agentId, run.agentId),
        )) : [];
        const automated = !wake || !["user", "board"].includes(wake.requestedByActorType ?? "");
        const candidate = run.nativeIssueId ?? (typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null);
        const [issue] = candidate ? await tx.select({ id: issues.id }).from(issues).where(and(
          eq(issues.companyId, companyId), eq(issues.id, candidate),
        )) : [];
        if (candidate && !issue) throw new Error("Provider admission issue boundary mismatch");
        const [existing] = await tx.select().from(providerDispatchReceipts).where(and(
          eq(providerDispatchReceipts.companyId, companyId), eq(providerDispatchReceipts.runId, runId),
        ));
        // A receipt is an at-most-once dispatch reservation. A duplicate scheduler
        // cannot use it to launch the same provider turn twice.
        if (existing?.admittedAt) return { kind: "duplicate" as const };
        const dispatches = issue ? await tx.select({ at: providerDispatchReceipts.admittedAt })
          .from(providerDispatchReceipts).where(and(
            eq(providerDispatchReceipts.companyId, companyId), eq(providerDispatchReceipts.issueId, issue.id),
            eq(providerDispatchReceipts.automated, true), isNotNull(providerDispatchReceipts.admittedAt),
            gt(providerDispatchReceipts.admittedAt, new Date(now.getTime() - AUTOMATED_ISSUE_DISPATCH_WINDOW_MS)),
          )) : [];
        const decision = providerAdmissionEligibility({ now, cooldownUntil: pool.cooldownUntil,
          automated, automatedDispatches: dispatches.flatMap(({ at }) => at ? [at] : []) });
        const values = { companyId, runId, issueId: issue?.id ?? null, poolKey: SHARED_PROVIDER_POOL,
          automated, admittedAt: decision.eligible ? now : null, eligibleAt: decision.eligibleAt,
          suppressionCount: (existing?.suppressionCount ?? 0) + (decision.eligible ? 0 : 1),
          suppressionReason: decision.reasons.join(",") || null, updatedAt: now };
        await tx.insert(providerDispatchReceipts).values(values).onConflictDoUpdate({
          target: providerDispatchReceipts.runId, set: values,
        });
        return decision.eligible
          ? { kind: "admitted" as const, eligibleAt: decision.eligibleAt }
          : { kind: "deferred" as const, eligibleAt: decision.eligibleAt, reasons: decision.reasons };
      });
    },

    async settle(input: { companyId: string; runId: string; outcome: string;
      providerFailure?: { retryNotBefore?: Date | null }; now?: Date; random?: () => number }) {
      const now = input.now ?? new Date();
      return db.transaction(async (tx) => {
        const pool = await lockPool(tx, input.companyId, now);
        const [receipt] = await tx.select().from(providerDispatchReceipts).where(and(
          eq(providerDispatchReceipts.companyId, input.companyId), eq(providerDispatchReceipts.runId, input.runId),
        )).for("update");
        if (!receipt?.admittedAt || receipt.settledAt) return;
        await tx.update(providerDispatchReceipts).set({ outcome: input.outcome, settledAt: now, updatedAt: now })
          .where(eq(providerDispatchReceipts.runId, input.runId));
        if (input.providerFailure) {
          const attempt = Math.min(pool.consecutiveFailures + 1, 1_000_000);
          const schedule = computeProviderRetrySchedule({ attempt, maxAttempts: 1_000_000, now,
            retryNotBefore: input.providerFailure.retryNotBefore, random: input.random })!;
          await tx.update(providerAdmissionPools).set({ consecutiveFailures: attempt,
            cooldownUntil: new Date(Math.max(pool.cooldownUntil?.getTime() ?? 0, schedule.dueAt.getTime())), updatedAt: now,
          }).where(and(eq(providerAdmissionPools.companyId, input.companyId), eq(providerAdmissionPools.poolKey, SHARED_PROVIDER_POOL)));
        } else if (input.outcome === "succeeded") {
          // An older in-flight success must never clear a later failure's reset floor.
          await tx.update(providerAdmissionPools).set({ consecutiveFailures: 0, updatedAt: now })
            .where(and(eq(providerAdmissionPools.companyId, input.companyId), eq(providerAdmissionPools.poolKey, SHARED_PROVIDER_POOL),
              sql`(${providerAdmissionPools.cooldownUntil} is null or ${providerAdmissionPools.cooldownUntil} <= ${now})`));
        }
      });
    },
  };
}
