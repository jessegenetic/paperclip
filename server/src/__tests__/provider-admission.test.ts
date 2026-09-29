import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues,
  providerAdmissionPools, providerDispatchReceipts } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { providerAdmissionService } from "../services/provider-admission.js";

const now = new Date("2030-01-01T12:00:00Z");
describe("durable provider admission (disposable Postgres, no providers)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-provider-admission-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Admission test", issuePrefix: `T${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Test", role: "engineer", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Admission test", status: "in_progress", assigneeAgentId: agentId });
    async function run(human = false, context: Record<string, unknown> = {}) {
      const runId = randomUUID(), wakeId = randomUUID();
      await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId, source: "on_demand",
        requestedByActorType: human ? "user" : "agent", payload: context });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, wakeupRequestId: wakeId,
        status: "running", contextSnapshot: { ...context, issueId } });
      return runId;
    }
    return { companyId, agentId, issueId, run };
  }

  it("reserves a run once across 16 concurrent schedulers and a service restart", async () => {
    const f = await fixture(), id = await f.run();
    const results = await Promise.all(Array.from({ length: 16 }, () => providerAdmissionService(db).reserve(f.companyId, id, now)));
    expect(results.filter((r) => r.kind === "admitted")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "duplicate")).toHaveLength(15);
    expect((await providerAdmissionService(db).reserve(f.companyId, id, now)).kind).toBe("duplicate");
  });

  it("caps concurrent automated dispatches per issue and admits one duplicate resume at the exact boundary", async () => {
    const f = await fixture(), ids = await Promise.all(Array.from({ length: 12 }, () => f.run()));
    const results = await Promise.all(ids.map((id) => providerAdmissionService(db).reserve(f.companyId, id, now)));
    expect(results.filter((r) => r.kind === "admitted")).toHaveLength(4);
    expect(results.filter((r) => r.kind === "deferred")).toHaveLength(8);
    const id = ids[results.findIndex((r) => r.kind === "deferred")]!;
    const boundary = new Date(now.getTime() + 3_600_000);
    const resumed = await Promise.all(Array.from({ length: 8 }, () => providerAdmissionService(db).reserve(f.companyId, id, boundary)));
    expect(resumed.filter((r) => r.kind === "admitted")).toHaveLength(1);
  });

  it("persists multi-day cooldown across agents, fresh issues, manual wakes and service recreation", async () => {
    const f = await fixture(), id = await f.run(), reset = new Date("2030-01-05T12:00:00Z");
    await providerAdmissionService(db).reserve(f.companyId, id, now);
    await providerAdmissionService(db).settle({ companyId: f.companyId, runId: id, outcome: "provider_quota", now,
      providerFailure: { retryNotBefore: reset }, random: () => 0.5 });
    const secondAgent = randomUUID(), secondIssue = randomUUID(), secondRun = randomUUID();
    await db.insert(agents).values({ id: secondAgent, companyId: f.companyId, name: "Other runtime", role: "engineer", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: secondIssue, companyId: f.companyId, title: "Fresh issue" });
    await db.insert(heartbeatRuns).values({ id: secondRun, companyId: f.companyId, agentId: secondAgent,
      status: "running", nativeIssueId: secondIssue });
    for (const freshId of [secondRun, await f.run(true, { providerAccount: "fake", cooldownUntil: null })]) {
      const decision = await providerAdmissionService(db).reserve(f.companyId, freshId, now);
      expect(decision).toMatchObject({ kind: "deferred", eligibleAt: reset, reasons: ["provider_cooldown"] });
    }
    expect((await providerAdmissionService(db).reserve(f.companyId, secondRun, reset)).kind).toBe("admitted");
  });

  it("does not let duplicate failure settlement extend the deadline after restart", async () => {
    const f = await fixture(), id = await f.run();
    await providerAdmissionService(db).reserve(f.companyId, id, now);
    await Promise.all(Array.from({ length: 8 }, () => providerAdmissionService(db).settle({ companyId: f.companyId,
      runId: id, outcome: "provider_quota", providerFailure: {}, now, random: () => 0.5 })));
    await providerAdmissionService(db).settle({ companyId: f.companyId, runId: id, outcome: "provider_quota",
      providerFailure: {}, now: new Date(now.getTime() + 60_000), random: () => 1 });
    const [pool] = await db.select().from(providerAdmissionPools).where(eq(providerAdmissionPools.companyId, f.companyId));
    expect(pool?.consecutiveFailures).toBe(1);
    expect(pool?.cooldownUntil).toEqual(new Date(now.getTime() + 300_000));
  });

  it("preserves company boundaries and rejects forged human authority in wake JSON", async () => {
    const a = await fixture(), b = await fixture(), id = await a.run();
    expect((await providerAdmissionService(db).reserve(b.companyId, id, now)).kind).toBe("stale");
    for (let index = 0; index < 4; index++) await providerAdmissionService(db).reserve(a.companyId, await a.run(), now);
    expect((await providerAdmissionService(db).reserve(a.companyId,
      await a.run(false, { requestedByActorType: "user", providerPool: randomUUID() }), now)).kind).toBe("deferred");
    expect((await providerAdmissionService(db).reserve(a.companyId, await a.run(true), now)).kind).toBe("admitted");
    expect((await providerAdmissionService(db).reserve(b.companyId, await b.run(), now)).kind).toBe("admitted");
  });

  it("keeps the queued human message and records suppression without admitting a provider attempt", async () => {
    const f = await fixture(), failed = await f.run();
    await providerAdmissionService(db).reserve(f.companyId, failed, now);
    await providerAdmissionService(db).settle({ companyId: f.companyId, runId: failed, outcome: "provider_quota",
      providerFailure: {}, now, random: () => 0.5 });
    const human = await f.run(true, { message: "Keep the approval gate. Do not deploy." });
    await providerAdmissionService(db).reserve(f.companyId, human, now);
    const [receipt] = await db.select().from(providerDispatchReceipts).where(eq(providerDispatchReceipts.runId, human));
    expect(receipt).toMatchObject({ admittedAt: null, suppressionCount: 1, suppressionReason: "provider_cooldown" });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, human));
    expect(run?.contextSnapshot?.message).toBe("Keep the approval gate. Do not deploy.");
  });

  it("keeps a later reset when an older in-flight run succeeds, then doubles the next failure delay", async () => {
    const f = await fixture(), first = await f.run(), older = await f.run();
    await providerAdmissionService(db).reserve(f.companyId, first, now);
    await providerAdmissionService(db).reserve(f.companyId, older, now);
    await providerAdmissionService(db).settle({ companyId: f.companyId, runId: first, outcome: "provider_quota",
      providerFailure: {}, now, random: () => 0.5 });
    await providerAdmissionService(db).settle({ companyId: f.companyId, runId: older, outcome: "succeeded", now });
    const nextTime = new Date(now.getTime() + 300_000), second = await f.run();
    expect((await providerAdmissionService(db).reserve(f.companyId, second, nextTime)).kind).toBe("admitted");
    await providerAdmissionService(db).settle({ companyId: f.companyId, runId: second, outcome: "provider_quota",
      providerFailure: {}, now: nextTime, random: () => 0.5 });
    const [pool] = await db.select().from(providerAdmissionPools).where(eq(providerAdmissionPools.companyId, f.companyId));
    expect(pool?.consecutiveFailures).toBe(2);
    expect(pool?.cooldownUntil).toEqual(new Date(now.getTime() + 900_000));
  });

  it("rolls back invalid issue authority without leaving an admission receipt", async () => {
    const f = await fixture(), other = await fixture(), id = await f.run();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: other.issueId } }).where(eq(heartbeatRuns.id, id));
    await expect(providerAdmissionService(db).reserve(f.companyId, id, now)).rejects.toThrow("issue boundary mismatch");
    expect(await db.select().from(providerDispatchReceipts).where(eq(providerDispatchReceipts.runId, id))).toHaveLength(0);
    expect(await db.select().from(providerAdmissionPools).where(eq(providerAdmissionPools.companyId, f.companyId))).toHaveLength(0);
  });
});
