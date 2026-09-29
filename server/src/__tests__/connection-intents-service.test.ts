import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  aiProviderDefaults,
  agentWakeupRequests,
  issueComments,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecrets,
  connectionGrantDelegations,
  connectionGrants,
  createDb,
  goals,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  runIdentityContexts,
  toolApplications,
  toolCatalogEntries,
  connectionIntentDeliveries,
  toolConnectionInstalls,
  toolConnections,
  toolProfileBindings,
  toolProfiles,
  userSecretDefinitions,
} from "@paperclipai/db";
import type { RuntimeToolsTokenClaims } from "../runtime-tools-token.js";
import { wakeConnectionIntentAfterResolution } from "../routes/connection-intents.js";
import { connectionIntentDeliveryService } from "../services/connection-intent-delivery.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { materializeNativeInteractionResponses } from "../services/native-runtime/native-interaction-bridge.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { resolveManagedGitHubIdentitySelection } from "../services/git-credentials.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("wakeConnectionIntentAfterResolution", () => {
  it("preserves resolved interaction evidence in the queued run snapshot", async () => {
    const wakeup = vi.fn().mockResolvedValue(null);
    await wakeConnectionIntentAfterResolution(
      { wakeup } as Parameters<typeof wakeConnectionIntentAfterResolution>[0],
      {
        loaded: {
          issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "in_progress" },
          interaction: {
            id: "interaction-1",
            resolvedAt: "2026-08-28T13:30:00.000Z",
          },
        },
        status: "accepted",
        actorId: "user-1",
      },
    );

    expect(wakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      contextSnapshot: expect.objectContaining({
        interactionId: "interaction-1",
        interactionKind: "connection_intent",
        interactionStatus: "accepted",
        interactionResolvedAt: "2026-08-28T13:30:00.000Z",
        mutation: "interaction",
        wakeReason: "issue_commented",
      }),
    }));
  });
});

describeEmbeddedPostgres("connectionIntentService", () => {
  let db!: ReturnType<typeof createDb>;
  let connectionString!: string;
  let cleanup: (() => Promise<void>) | undefined;
  let claims!: RuntimeToolsTokenClaims;
  let runId!: string;

  beforeAll(async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-connection-intents-");
    cleanup = tempDb.cleanup;
    connectionString = tempDb.connectionString;
    db = createDb(connectionString);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Connection tests",
      issuePrefix: "CONN",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "responsible-user",
      status: "active",
      membershipRole: "member",
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Connect a service",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Researcher",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Read Notion",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "responsible-user",
      contextSnapshot: { issueId },
    });
    claims = {
      sub: agentId,
      company_id: companyId,
      run_id: runId,
      responsible_user_id: "responsible-user",
      scope: "connection_intents",
      iat: 1,
      exp: 2,
      instance_id: "test",
    };
  }, 20_000);

  afterAll(async () => {
    await cleanup?.();
  });

  async function waitForBlockedMembershipLock() {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const [waiting] = await db.execute<{ waiting: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE state = 'active'
            AND wait_event_type = 'Lock'
            AND query ILIKE '%company_memberships%'
            AND query ILIKE '%for update%'
        ) AS waiting
      `);
      if (waiting?.waiting) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  it("searches first-party definitions without leaking run identity", async () => {
    const result = await connectionIntentService(db).search(claims, "notion");
    expect(result.results).toEqual([
      expect.objectContaining({ service: "notion", state: "available" }),
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("responsible-user");
    expect(serialized).not.toContain(claims.sub);
  });

  it("creates one addressed request, resolves after install, and then reports ready for the responsible user", async () => {
    const service = connectionIntentService(db);
    const first = await service.request(claims, "notion");
    const repeated = await service.request(claims, "notion");
    expect(repeated.interactionId).toBe(first.interactionId);
    const [row] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, first.interactionId!));
    expect(row).toMatchObject({
      kind: "connection_intent",
      addresseeUserId: "responsible-user",
      sourceRunId: runId,
      status: "pending",
    });

    const [application] = await db.insert(toolApplications).values({
      companyId: claims.company_id,
      applicationKey: `notion-${randomUUID()}`,
      name: "Notion",
      type: "mcp_http",
      status: "active",
      metadata: { sourceTemplateKey: "notion" },
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: claims.company_id,
      applicationId: application!.id,
      name: "Responsible user's Notion",
      uid: `notion/${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "api_key",
      credentialPolicy: "per_user",
      status: "active",
      enabled: true,
      healthStatus: "ok",
      config: { sourceTemplateKey: "notion" },
      transportConfig: { sourceTemplateKey: "notion" },
    }).returning();
    const [grant] = await db.insert(connectionGrants).values({
      companyId: claims.company_id,
      connectionId: connection!.id,
      kind: "user",
      subjectUserId: claims.responsible_user_id,
      status: "active",
      isDefault: false,
    }).returning();
    const [otherAgent] = await db.insert(agents).values({
      companyId: claims.company_id,
      name: "Existing Notion user",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    await db.insert(toolConnectionInstalls).values({
      companyId: claims.company_id,
      connectionId: connection!.id,
      targetType: "agent",
      targetId: otherAgent!.id,
    });

    await expect(service.complete(first.interactionId!, connection!.id, "someone-else"))
      .rejects.toThrow("Only the addressed user");
    expect(await db.select().from(connectionGrantDelegations)).toHaveLength(0);
    expect(await db.select().from(issueThreadInteractions).where(
      eq(issueThreadInteractions.id, first.interactionId!),
    )).toEqual([expect.objectContaining({ status: "pending" })]);

    const [profile] = await db.insert(toolProfiles).values({ companyId: claims.company_id, name: "Notion reads", profileKey: "notion-reads", defaultAction: "allow", status: "active" }).returning();
    await db.insert(toolProfileBindings).values({ companyId: claims.company_id, profileId: profile!.id, targetType: "agent", targetId: claims.sub });
    await db.insert(toolCatalogEntries).values({ companyId: claims.company_id, connectionId: connection!.id, toolName: "notion-read", name: "notion-read", versionHash: "fixture-v1", status: "active", entryKind: "tool" });
    const resolved = await service.complete(
      first.interactionId!,
      connection!.id,
      claims.responsible_user_id,
    );
    expect(resolved).toMatchObject({
      status: "accepted",
      result: { outcome: "connected", connectionId: connection!.id },
    });
    expect(await db.select().from(connectionGrantDelegations).where(
      eq(connectionGrantDelegations.grantId, grant!.id),
    )).toEqual([
      expect.objectContaining({
        agentId: claims.sub,
        createdByUserId: claims.responsible_user_id,
      }),
    ]);
    const installs = await db.select().from(toolConnectionInstalls).where(
      eq(toolConnectionInstalls.connectionId, connection!.id),
    );
    expect(installs).toHaveLength(2);
    expect(installs).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetType: "agent", targetId: claims.sub }),
      expect.objectContaining({ targetType: "agent", targetId: otherAgent!.id }),
    ]));

    // A task-bound run already carries the responsible user's identity. The
    // standing delegation created by an agent-initiated setup is only needed
    // for future automated runs that have no responsible user.
    await db.delete(connectionGrantDelegations).where(eq(connectionGrantDelegations.grantId, grant!.id));

    const continuationRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: continuationRunId,
      companyId: claims.company_id,
      agentId: claims.sub,
      status: "running",
      responsibleUserId: claims.responsible_user_id,
      contextSnapshot: { issueId: row!.issueId },
    });
    const continuationClaims: RuntimeToolsTokenClaims = {
      ...claims,
      run_id: continuationRunId,
    };
    const readySearch = await service.search(continuationClaims, "notion");
    expect(readySearch.results).toEqual([
      expect.objectContaining({ service: "notion", state: "ready", connectionId: connection!.id }),
    ]);

    const [dedicatedConnection] = await db.insert(toolConnections).values({
      companyId: claims.company_id,
      applicationId: application!.id,
      name: "Researcher's dedicated Notion",
      uid: `notion/${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "api_key",
      credentialPolicy: "per_agent",
      status: "active",
      enabled: true,
      healthStatus: "ok",
      config: { sourceTemplateKey: "notion" },
      transportConfig: { sourceTemplateKey: "notion" },
    }).returning();
    await db.insert(connectionGrants).values({
      companyId: claims.company_id,
      connectionId: dedicatedConnection!.id,
      kind: "agent",
      subjectAgentId: claims.sub,
      status: "active",
      isDefault: false,
    });
    await db.insert(toolConnectionInstalls).values({
      companyId: claims.company_id,
      connectionId: dedicatedConnection!.id,
      targetType: "agent",
      targetId: claims.sub,
    });

    await db.insert(toolCatalogEntries).values({ companyId: claims.company_id, connectionId: dedicatedConnection!.id, toolName: "notion-read", name: "notion-read", versionHash: "fixture-v1", status: "active", entryKind: "tool" });
    const dedicatedSearch = await service.search(continuationClaims, "notion");
    expect(dedicatedSearch.results).toEqual([
      expect.objectContaining({ service: "notion", state: "ready", connectionId: dedicatedConnection!.id }),
    ]);
    const readyRequest = await service.request(continuationClaims, "notion");
    expect(readyRequest).toMatchObject({
      state: "ready",
      interactionId: null,
      connectionId: dedicatedConnection!.id,
    });
    expect(await db.select().from(issueThreadInteractions)).toHaveLength(1);
    await expect(service.complete(first.interactionId!, connection!.id, claims.responsible_user_id)).resolves.toMatchObject({ status: "accepted" });
    expect(await db.select().from(connectionIntentDeliveries).where(eq(connectionIntentDeliveries.interactionId, first.interactionId!))).toHaveLength(1);
    await expect(service.request(claims, "unknown-service"))
      .rejects.toThrow("was not found");
    expect((await service.search(claims, "github")).results).toEqual([
      expect.objectContaining({ service: "github", state: "available" }),
    ]);
    await expect(service.request(claims, "github")).resolves.toMatchObject({
      state: "needs_user_action",
      connectionId: null,
    });
  });

  it("only advertises GitHub tool methods in search and setup options", async () => {
    const service = connectionIntentService(db);
    const search = await service.search(claims, "github");
    const github = search.results.find((result) => result.service === "github");
    expect(github).toEqual(
      expect.objectContaining({
        methods: [
          expect.objectContaining({
            key: "mcp-key",
            label: "Personal access token (advanced)",
            auth: "api_key",
          }),
        ],
      }),
    );
    expect(github?.methods.map((method) => method.key)).not.toContain(
      "chat-agent",
    );

    await expect(service.request(claims, "discord")).rejects.toThrow(
      "is not available",
    );

    const request = await service.request(claims, "github");
    const setup = await service.setupOptions(request.interactionId!);
    expect(setup.service.methods).toEqual([
      expect.objectContaining({
        key: "mcp-key",
        label: "Personal access token (advanced)",
        auth: "api_key",
      }),
    ]);
    expect(setup.service.methods.map((method) => method.key)).not.toContain(
      "chat-agent",
    );
  });

  it("serializes OAuth intent completion behind addressed-user membership revocation", async () => {
    const raceCompanyId = randomUUID();
    const raceAgentId = randomUUID();
    const raceGoalId = randomUUID();
    const raceIssueId = randomUUID();
    const raceRunId = randomUUID();
    const raceUserId = `race-user-${randomUUID()}`;
    await db.insert(companies).values({
      id: raceCompanyId,
      name: "Connection intent authority race",
      issuePrefix: `RACE${randomUUID().slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId: raceCompanyId,
      principalType: "user",
      principalId: raceUserId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(goals).values({
      id: raceGoalId,
      companyId: raceCompanyId,
      title: "Connect Notion during authority race",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: raceAgentId,
      companyId: raceCompanyId,
      name: "Race agent",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: raceIssueId,
      companyId: raceCompanyId,
      goalId: raceGoalId,
      title: "Use Notion",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: raceAgentId,
    });
    await db.insert(heartbeatRuns).values({
      id: raceRunId,
      companyId: raceCompanyId,
      agentId: raceAgentId,
      status: "running",
      responsibleUserId: raceUserId,
      contextSnapshot: { issueId: raceIssueId },
    });
    const raceClaims: RuntimeToolsTokenClaims = {
      sub: raceAgentId,
      company_id: raceCompanyId,
      run_id: raceRunId,
      responsible_user_id: raceUserId,
      scope: "connection_intents",
      iat: 1,
      exp: 2,
      instance_id: "test",
    };
    const completionDb = createDb(connectionString, { maxConnections: 1 });
    const revocationDb = createDb(connectionString, { maxConnections: 1 });
    const service = connectionIntentService(completionDb);
    const pending = await service.request(raceClaims, "notion");
    const [application] = await db.insert(toolApplications).values({
      companyId: raceClaims.company_id,
      applicationKey: `notion-race-${randomUUID()}`,
      name: "Notion",
      type: "mcp_http",
      status: "active",
      metadata: { sourceTemplateKey: "notion" },
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: raceClaims.company_id,
      applicationId: application!.id,
      name: "Personal Notion OAuth",
      uid: `notion-race/${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "shared",
      status: "active",
      enabled: true,
      healthStatus: "ok",
      config: { sourceTemplateKey: "notion", connectionMethodKey: "mcp-oauth" },
      transportConfig: { sourceTemplateKey: "notion", connectionMethodKey: "mcp-oauth" },
    }).returning();
    const [secretDefinition] = await db.insert(userSecretDefinitions).values({
      companyId: raceClaims.company_id,
      key: `notion-oauth-${randomUUID()}`,
      name: "Notion OAuth access token",
    }).returning();
    const [accessSecret] = await db.insert(companySecrets).values({
      companyId: raceClaims.company_id,
      scope: "user",
      ownerUserId: raceClaims.responsible_user_id,
      userSecretDefinitionId: secretDefinition!.id,
      key: `notion-oauth-${randomUUID()}`,
      name: `Notion OAuth ${randomUUID()}`,
    }).returning();
    await db.insert(connectionGrants).values({
      companyId: raceClaims.company_id,
      connectionId: connection!.id,
      kind: "user",
      subjectUserId: raceClaims.responsible_user_id,
      credentialSecretRefs: [{
        secretId: accessSecret!.id,
        versionSelector: "latest",
        configPath: "oauth.access_token",
        required: true,
        label: "OAuth access token",
      }],
      status: "active",
      isDefault: false,
    });
    const expectNoOAuthCompletionWrites = async () => {
      await expect(db.select().from(toolConnections).where(
        eq(toolConnections.id, connection!.id),
      )).resolves.toEqual([expect.objectContaining({
        credentialPolicy: "shared",
        credentialRefs: [],
        credentialSecretRefs: [],
        status: "active",
        enabled: true,
      })]);
      await expect(db.select().from(companySecretBindings).where(and(
        eq(companySecretBindings.companyId, raceClaims.company_id),
        eq(companySecretBindings.targetType, "tool_connection"),
        eq(companySecretBindings.targetId, connection!.id),
      ))).resolves.toHaveLength(0);
      await expect(db.select().from(toolProfiles).where(and(
        eq(toolProfiles.companyId, raceClaims.company_id),
        eq(toolProfiles.profileKey, `app:${connection!.id}`),
      ))).resolves.toHaveLength(0);
      await expect(db.select().from(toolProfileBindings).where(
        eq(toolProfileBindings.companyId, raceClaims.company_id),
      )).resolves.toHaveLength(0);
      await expect(db.select().from(toolConnectionInstalls).where(
        eq(toolConnectionInstalls.connectionId, connection!.id),
      )).resolves.toHaveLength(0);
      await expect(db.select().from(connectionGrantDelegations).where(
        eq(connectionGrantDelegations.companyId, raceClaims.company_id),
      )).resolves.toHaveLength(0);
      await expect(db.select().from(issueThreadInteractions).where(
        eq(issueThreadInteractions.id, pending.interactionId!),
      )).resolves.toEqual([expect.objectContaining({ status: "pending" })]);
    };
    let releaseRevocation!: () => void;
    const revocationMayCommit = new Promise<void>((resolve) => {
      releaseRevocation = resolve;
    });
    let membershipLocked!: () => void;
    const membershipIsLocked = new Promise<void>((resolve) => {
      membershipLocked = resolve;
    });
    let revocation: Promise<void> | null = null;
    let completion: Promise<{ value: unknown; error: unknown }> | null = null;

    try {
      revocation = revocationDb.transaction(async (tx) => {
        await tx
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(and(
            eq(companyMemberships.companyId, raceClaims.company_id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, raceClaims.responsible_user_id),
          ))
          .for("update");
        membershipLocked();
        await revocationMayCommit;
        await tx
          .update(companyMemberships)
          .set({ membershipRole: "viewer", updatedAt: new Date() })
          .where(and(
            eq(companyMemberships.companyId, raceClaims.company_id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, raceClaims.responsible_user_id),
          ));
      });

      await membershipIsLocked;
      completion = service.complete(
        pending.interactionId!,
        connection!.id,
        raceClaims.responsible_user_id,
        { canManageOrganizationGrant: true },
      ).then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );

      expect(await waitForBlockedMembershipLock()).toBe(true);
      await expectNoOAuthCompletionWrites();

      releaseRevocation();
      await revocation;
      const outcome = await completion;
      expect(outcome.value).toBeNull();
      expect(outcome.error).toMatchObject({
        status: 403,
        message: expect.stringContaining("no longer authorized"),
      });
      await expectNoOAuthCompletionWrites();
    } finally {
      releaseRevocation();
      await revocation?.catch(() => undefined);
      await completion?.catch(() => undefined);
      await completionDb.$client.end({ timeout: 0 }).catch(() => undefined);
      await revocationDb.$client.end({ timeout: 0 }).catch(() => undefined);
    }
  }, 15_000);

  it("revalidates the responsible user's active write membership for every token use", async () => {
    const service = connectionIntentService(db);
    try {
      await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(
        companyMemberships.principalId,
        claims.responsible_user_id,
      ));
      await expect(service.search(claims, "notion"))
        .rejects.toThrow("no longer authorized for company write access");

      await db.update(companyMemberships).set({ membershipRole: "member", status: "inactive" }).where(eq(
        companyMemberships.principalId,
        claims.responsible_user_id,
      ));
      await expect(service.request(claims, "notion"))
        .rejects.toThrow("no longer authorized for company write access");
    } finally {
      await db.update(companyMemberships).set({ membershipRole: "member", status: "active" }).where(eq(
        companyMemberships.principalId,
        claims.responsible_user_id,
      ));
    }
  });

  it("rejects every addressed-user mutation after write membership is revoked", async () => {
    const service = connectionIntentService(db);
    const pending = await service.request(claims, "posthog");
    expect(pending.interactionId).toBeTruthy();
    try {
      await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(
        companyMemberships.principalId,
        claims.responsible_user_id,
      ));
      await expect(service.updatePhase(
        pending.interactionId!,
        "authorizing",
        claims.responsible_user_id,
      )).rejects.toThrow("no longer authorized for company write access");
      await expect(service.decline(
        pending.interactionId!,
        claims.responsible_user_id,
      )).rejects.toThrow("no longer authorized for company write access");
      await expect(service.complete(
        pending.interactionId!,
        randomUUID(),
        claims.responsible_user_id,
      )).rejects.toThrow("no longer authorized for company write access");
    } finally {
      await db.update(companyMemberships).set({ membershipRole: "member", status: "active" }).where(eq(
        companyMemberships.principalId,
        claims.responsible_user_id,
      ));
    }
  });


  it("native authority discovers and requests services on an empty tool snapshot", async () => {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const issueId = String(run!.contextSnapshot!.issueId);
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId }).where(eq(heartbeatRuns.id, runId));
    const authority = new PaperclipRunnerToolAuthority(db, { companyId: claims.company_id, issueId, agentId: claims.sub, runId });
    const result = await authority.execute({ tool: "connections_search", callId: "discover", arguments: { query: "github" } });
    expect(result).toMatchObject({ results: expect.arrayContaining([expect.objectContaining({ service: "github", state: "available" })]) });
    const request = await authority.execute({ tool: "connection_request", callId: "request", arguments: { service: "github" } });
    expect(request).toMatchObject({ state: "needs_user_action", interactionId: expect.any(String) });
    await expect(authority.execute({ tool: "connection_request", callId: "bad", arguments: { service: "connection:https://private.invalid" } })).rejects.toThrow("not found");
  });

  it("preserves an authorizing card through comments and later runs", async () => {
    const service = connectionIntentService(db);
    const first = await service.request(claims, "zapier");
    await service.updatePhase(first.interactionId!, "authorizing", claims.responsible_user_id);
    const loaded = await service.loadIntent(first.interactionId!);
    await db.insert(issueComments).values({ companyId: claims.company_id, issueId: loaded.issue.id, authorUserId: claims.responsible_user_id, body: "Organize the checklist while I connect." });
    await issueThreadInteractionService(db).getForIssue(loaded.issue, first.interactionId!);
    const laterRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: laterRunId, companyId: claims.company_id, agentId: claims.sub, status: "running", responsibleUserId: claims.responsible_user_id, contextSnapshot: { issueId: loaded.issue.id } });
    const repeated = await service.request({ ...claims, run_id: laterRunId }, "zapier");
    expect(repeated.interactionId).toBe(first.interactionId);
    expect((await service.loadIntent(first.interactionId!)).interaction).toMatchObject({ status: "pending", payload: { phase: "authorizing" } });
  });

  it("discovers only authorized custom connections and searches indexed capabilities", async () => {
    const [application] = await db.insert(toolApplications).values({ companyId: claims.company_id, applicationKey: randomUUID(), name: "Research archive", type: "mcp_http", status: "active" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: claims.company_id, applicationId: application!.id, uid: randomUUID(), name: "Archive fixture", transport: "mcp_remote", authKind: "none", enabled: true, status: "active", healthStatus: "ok" }).returning();
    const id = `connection:${connection!.id}`;
    const service = connectionIntentService(db);
    await expect(service.request(claims, id)).rejects.toThrow("not found");
    await db.insert(connectionGrants).values({ companyId: claims.company_id, connectionId: connection!.id, kind: "user", subjectUserId: claims.responsible_user_id, status: "active" });
    await db.insert(toolCatalogEntries).values({ companyId: claims.company_id, connectionId: connection!.id, toolName: "archive_read", name: "Archive read", description: "Read the unique heliotrope launch decision", versionHash: "fixture-v1", status: "active", entryKind: "tool" });
    expect((await service.search(claims, "heliotrope")).results).toEqual([expect.objectContaining({ service: id, source: "configured", state: "needs_user_action" })]);
    const requested = await service.request(claims, id);
    expect((await service.setupOptions(requested.interactionId!)).existingConnections).toEqual([expect.objectContaining({ id: connection!.id })]);
    await expect(service.request({ ...claims, company_id: randomUUID() }, id)).rejects.toThrow();
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, connection!.id));
    expect((await service.search(claims, "heliotrope")).results[0]).toMatchObject({ state: "unavailable" });
  });

  it("returns only selection metadata for an agent-authorized custom connection", async () => {
    const [application] = await db.insert(toolApplications).values({ companyId: claims.company_id, applicationKey: randomUUID(), name: "Private archive", type: "mcp_http", status: "active" }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: claims.company_id, applicationId: application!.id, uid: randomUUID(),
      name: "Archive identity", transport: "mcp_remote", authKind: "none", enabled: true, status: "active", healthStatus: "ok",
      config: { oauth: { accessToken: "private-access", refreshToken: "private-refresh", clientSecret: "private-client" } },
      transportConfig: { url: "https://private.invalid/mcp?token=private-url", headers: { Authorization: "private-header" } },
    }).returning();
    await db.insert(connectionGrants).values({ companyId: claims.company_id, connectionId: connection!.id,
      kind: "agent", subjectAgentId: claims.sub, status: "active" });
    const service = connectionIntentService(db);
    const requested = await service.request(claims, `connection:${connection!.id}`);
    const setup = await service.setupOptions(requested.interactionId!);
    expect(setup.existingConnections).toEqual([{
      id: connection!.id, applicationId: application!.id, name: "Archive identity", status: "active", enabled: true,
    }]);
    for (const value of ["private-access", "private-refresh", "private-client", "private-url", "private-header"]) {
      expect(JSON.stringify(setup)).not.toContain(value);
    }
  });

  it("searches catalog-provider tool descriptions only within the current identity audience", async () => {
    const [application] = await db.insert(toolApplications).values({ companyId: claims.company_id, applicationKey: randomUUID(), name: "Indexed Notion", type: "mcp_http", status: "active", metadata: { sourceTemplateKey: "notion" } }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: claims.company_id, applicationId: application!.id, uid: randomUUID(), name: "Private Notion", transport: "mcp_remote", authKind: "none", enabled: true, status: "active", healthStatus: "ok", config: { sourceTemplateKey: "notion" } }).returning();
    await db.insert(toolCatalogEntries).values({ companyId: claims.company_id, connectionId: connection!.id, toolName: "archive_read", name: "Archive read", description: "Read chrysanthemum workspace decisions", versionHash: "fixture-v1", status: "active", entryKind: "tool" });
    const service = connectionIntentService(db);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Discovery must use the stored index"));
    expect((await service.search(claims, "chrysanthemum")).results).toEqual([]);
    await db.insert(connectionGrants).values({ companyId: claims.company_id, connectionId: connection!.id, kind: "user", subjectUserId: claims.responsible_user_id, status: "active" });
    expect((await service.search(claims, "chrysanthemum")).results).toEqual([expect.objectContaining({ service: "notion", source: "catalog" })]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("materializes declined connection outcomes for a fresh native continuation", async () => {
    const service = connectionIntentService(db);
    const request = await service.request(claims, "linear");
    await service.decline(request.interactionId!, claims.responsible_user_id);
    const [issue] = await db.select().from(issues).where(eq(issues.assigneeAgentId, claims.sub));
    const responses = await materializeNativeInteractionResponses({ db, companyId: claims.company_id,
      agentId: claims.sub, runId: claims.run_id, issueId: issue!.id, interactionIds: [request.interactionId!] });
    expect(responses).toEqual([expect.objectContaining({ kind: "connection_intent", response: expect.objectContaining({ status: "rejected" }) })]);
  });

  it("recovers a resolution after a failed dispatch and acknowledges an already queued wake exactly once", async () => {
    const service = connectionIntentService(db);
    const pending = await service.request(claims, "airtable");
    await service.decline(pending.interactionId!, claims.responsible_user_id);
    const wakeup = vi.fn().mockRejectedValueOnce(new Error("simulated crash before durable enqueue"));
    const deliveries = connectionIntentDeliveryService(db, { wakeup } as never);
    await expect(deliveries.deliver(pending.interactionId!)).rejects.toThrow("simulated crash");
    await db.update(connectionIntentDeliveries).set({ nextAttemptAt: new Date(0) }).where(eq(connectionIntentDeliveries.interactionId, pending.interactionId!));
    // Simulate a second worker crashing immediately after heartbeat persists its wake.
    await db.insert(agentWakeupRequests).values({ companyId: claims.company_id, agentId: claims.sub, source: "automation", status: "queued", idempotencyKey: `connection-intent:${pending.interactionId}:rejected` });
    await deliveries.deliver(pending.interactionId!);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect((await db.select().from(connectionIntentDeliveries).where(eq(connectionIntentDeliveries.interactionId, pending.interactionId!)))[0]!.deliveredAt).not.toBeNull();
    await deliveries.deliver(pending.interactionId!);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("retires continuation delivery after assignment changes", async () => {
    const service = connectionIntentService(db);
    const pending = await service.request(claims, "asana");
    const loaded = await service.loadIntent(pending.interactionId!);
    await service.decline(pending.interactionId!, claims.responsible_user_id);
    const wakeup = vi.fn();
    try {
      await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, loaded.issue.id));
      await connectionIntentDeliveryService(db, { wakeup } as never).deliver(pending.interactionId!);
      expect(wakeup).not.toHaveBeenCalled();
      expect((await db.select().from(connectionIntentDeliveries).where(eq(connectionIntentDeliveries.interactionId, pending.interactionId!)))[0]!.deliveredAt).not.toBeNull();
    } finally {
      await db.update(issues).set({ assigneeAgentId: claims.sub }).where(eq(issues.id, loaded.issue.id));
    }
  });

  it("rejects cross-company claims and tokens after the run ends", async () => {
    const service = connectionIntentService(db);
    await expect(service.search({ ...claims, company_id: randomUUID() }, "notion"))
      .rejects.toThrow("does not match its heartbeat run");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    await expect(service.search(claims, "notion"))
      .rejects.toThrow("no longer active");
  });
  it("keeps runtime authentication separate from obsolete Anthropic tool requests", async () => {
    const companyId = claims.company_id;
    const agentId = randomUUID();
    const issueId = randomUUID();
    const aiRunId = randomUUID();
    const binding = { provider: "anthropic", method: "subscription", mode: "responsible_user" } as const;
    await db.insert(agents).values({ id: agentId, companyId, name: "AI Agent", adapterType: "claude_local", runtimeConfig: { aiConnection: binding } });
    await db.insert(issues).values({ id: issueId, companyId, title: "AI authentication", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: aiRunId, companyId, agentId, status: "running", responsibleUserId: claims.responsible_user_id, contextSnapshot: { issueId } });
    const [app] = await db.insert(toolApplications).values({ companyId, applicationKey: "ai-intent-fixture", name: "AI intent fixture", type: "mcp_http", metadata: { sourceTemplateKey: "anthropic" } }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: app!.id, name: "Personal Claude API", uid: `ai-${randomUUID()}`, connectionPurpose: "ai", transport: "runtime_auth", authKind: "api_key", credentialPolicy: "per_user", healthStatus: "ok", status: "active", enabled: true, config: { sourceTemplateKey: "anthropic", ai: { provider: "anthropic", method: "api_key" } } }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId: connection!.id, kind: "user", subjectUserId: claims.responsible_user_id, createdByUserId: claims.responsible_user_id }).returning();
    await db.insert(aiProviderDefaults).values({ companyId, userId: claims.responsible_user_id!, provider: "anthropic", grantId: grant!.id });
    const aiClaims = { ...claims, sub: agentId, run_id: aiRunId };
    const service = connectionIntentService(db);
    await expect(service.request(aiClaims, "anthropic")).rejects.toMatchObject({
      status: 422,
      message: "Connection service anthropic is not available",
    });
    // Preserve an intent created before the obsolete REST method was removed.
    // It must neither alias the AI request nor accept an AI account as tools.
    const toolRequest = await issueThreadInteractionService(db).createConnectionIntent(
      { id: issueId, companyId },
      {
        payload: {
          version: 1,
          serviceSlug: "anthropic",
          serviceName: "Anthropic",
          serviceLogoUrl: null,
          requestingAgentId: agentId,
          requestingAgentName: "AI Agent",
          phase: "requested",
        },
        sourceRunId: aiRunId,
        addresseeUserId: claims.responsible_user_id!,
        idempotencyKey: `connection-intent:${aiRunId}:${claims.responsible_user_id}:anthropic`,
      },
    );
    const aiRequest = await service.request(aiClaims, "anthropic", { purpose: "ai" });
    expect(aiRequest.state).toBe("needs_user_action");
    expect(aiRequest.interactionId).not.toBe(toolRequest.id);
    expect((await service.setupOptions(aiRequest.interactionId!)).aiConnection).toEqual(binding);
    expect((await service.setupOptions(aiRequest.interactionId!)).aiRepair?.connection).toMatchObject({ id: connection!.id, method: "api_key" });
    expect((await service.setupOptions(toolRequest.id)).existingConnections).toEqual([]);
    await expect(service.complete(toolRequest.id, connection!.id, claims.responsible_user_id!)).rejects.toThrow("cannot satisfy");
    await expect(service.complete(aiRequest.interactionId!, connection!.id, claims.responsible_user_id!)).resolves.toMatchObject({ status: "accepted" });
    expect((await service.request(aiClaims, "anthropic", { purpose: "ai" })).state).toBe("ready");
    await expect(service.request(aiClaims, "anthropic")).rejects.toMatchObject({ status: 422 });
    expect((await service.search(aiClaims, "openrouter")).results.some(result => result.service === "openrouter")).toBe(false);
  });

  // Agent-facing readiness and the credential broker resolve the same GitHub
  // identity, but readiness used to stop at "a grant was selected". A grant whose
  // access token cannot be read still selected, so the same connection reported
  // `ready` here while the broker handed back an empty environment -- and because
  // `request` gates on this identical check, the agent could not raise a setup
  // card either. Readiness must fail with the credential, not with the grant.
  it("reports an unreadable GitHub credential as actionable instead of ready", async () => {
    const companyId = claims.company_id;
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runIdForGithub = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "GitHub Agent", role: "engineer", status: "active", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Push a branch", status: "in_progress", priority: "medium", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runIdForGithub, companyId, agentId, status: "running", responsibleUserId: claims.responsible_user_id, contextSnapshot: { issueId } });
    const githubClaims: RuntimeToolsTokenClaims = { ...claims, sub: agentId, run_id: runIdForGithub };

    const [application] = await db.insert(toolApplications).values({
      companyId, applicationKey: `github-${randomUUID()}`, name: "GitHub", type: "mcp_http",
      status: "active", metadata: { sourceTemplateKey: "github" },
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: application!.id, name: "Operator's GitHub", uid: `github/${randomUUID()}`,
      transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_agent", status: "active",
      enabled: true, healthStatus: "ok",
      config: { sourceTemplateKey: "github" }, transportConfig: { sourceTemplateKey: "github" },
    }).returning();
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: connection!.id, targetType: "agent", targetId: agentId });
    const [profile] = await db.insert(toolProfiles).values({ companyId, name: "GitHub reads", profileKey: `github-reads-${randomUUID()}`, defaultAction: "allow", status: "active" }).returning();
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile!.id, targetType: "agent", targetId: agentId });
    await db.insert(toolCatalogEntries).values({ companyId, connectionId: connection!.id, toolName: "get-me", name: "get-me", versionHash: "fixture-v1", status: "active", entryKind: "tool" });

    // The grant itself is healthy and unambiguous: active, dedicated to this
    // agent, with live provider metadata. Only the secret behind it is gone, so
    // nothing but the credential check can distinguish this from a usable identity.
    const [secret] = await db.insert(companySecrets).values({
      companyId, scope: "company", key: `github-token-${randomUUID()}`, name: "GitHub token",
      status: "active", deletedAt: new Date("2026-09-28T00:00:00Z"),
    }).returning();
    await db.insert(connectionGrants).values({
      companyId, connectionId: connection!.id, kind: "agent", subjectAgentId: agentId, status: "active",
      providerTenant: { github: {
        userId: "gh-1", login: "operator", installationCount: 1, repositoryCount: 4,
        repositorySelection: "all", installationIds: ["1"], installationOwnerLogins: ["operator"],
      } },
      credentialSecretRefs: [{ secretId: secret!.id, configPath: "oauth.access_token" }],
    });

    const service = connectionIntentService(db);
    const search = await service.search(githubClaims, "github");
    const github = search.results.find((result) => result.service === "github");
    expect(github).toMatchObject({ state: "needs_user_action", connectionId: null });
    expect(github?.reason).not.toBe("Connection is installed and usable by this agent");

    // The escalation path has to reopen with it. Reporting `ready` here is what
    // left an agent with a broken credential and no way to ask for a repair.
    const request = await service.request(githubClaims, "github");
    expect(request.state).toBe("needs_user_action");
    expect(request.interactionId).not.toBeNull();
  });

  it("selects a standing delegation for the delegated agent only, whatever principal the run resolves", async () => {
    const companyId = claims.company_id;
    const ownerUserId = claims.responsible_user_id;
    const delegatedAgentId = randomUUID();
    const otherAgentId = randomUUID();
    for (const [id, name] of [[delegatedAgentId, "Delegated Agent"], [otherAgentId, "Other Agent"]] as const) {
      await db.insert(agents).values({ id, companyId, name, role: "engineer", status: "active", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    }

    const [application] = await db.insert(toolApplications).values({
      companyId, applicationKey: `github-${randomUUID()}`, name: `GitHub (delegated ${randomUUID()})`, type: "mcp_http",
      status: "active", metadata: { sourceTemplateKey: "github" },
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: application!.id, name: `Operator's GitHub ${randomUUID()}`, uid: `github/${randomUUID()}`,
      transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_agent", status: "active",
      enabled: true, healthStatus: "ok",
      config: { sourceTemplateKey: "github" }, transportConfig: { sourceTemplateKey: "github" },
    }).returning();
    // Installed company-wide, so connection eligibility is identical for both
    // agents and the delegation is the only thing that can tell them apart.
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: connection!.id, targetType: "company", targetId: companyId });

    const [secret] = await db.insert(companySecrets).values({
      companyId, scope: "company", key: `github-token-${randomUUID()}`, name: "GitHub token", status: "active",
    }).returning();
    // The operator's own personal grant. Neither agent has a dedicated grant, and
    // the grant's subject is the owner -- not either agent's run principal.
    const [grant] = await db.insert(connectionGrants).values({
      companyId, connectionId: connection!.id, kind: "user", subjectUserId: ownerUserId, status: "active",
      createdByUserId: ownerUserId,
      providerTenant: { github: {
        userId: "gh-1", login: "operator", installationCount: 1, repositoryCount: 4,
        repositorySelection: "all", installationIds: ["1"], installationOwnerLogins: ["operator"],
      } },
      credentialSecretRefs: [{ secretId: secret!.id, configPath: "oauth.access_token" }],
    }).returning();

    // Before the delegation exists nothing matches an agent-run principal, for
    // either agent. This is the shape the identity broker reported as
    // `candidates.length === 0` / "No managed GitHub identity is available".
    for (const responsibleUserId of [null, `unrelated-${randomUUID()}`]) {
      const before = await resolveManagedGitHubIdentitySelection(db, companyId, { agentId: delegatedAgentId, responsibleUserId });
      expect(before.configured).toBe(true);
      expect(before.grant).toBeUndefined();
      expect(before.error).toBe("No managed GitHub identity is available for this run");
      // Matching nothing must report *no* pool. This used to report `personal`,
      // so the string that means "the operator's own grant was selected" was
      // also the string every failing probe on this fault returned.
      expect(before.identitySource).toBeUndefined();
    }

    await db.insert(connectionGrantDelegations).values({
      companyId, grantId: grant!.id, agentId: delegatedAgentId, createdByUserId: ownerUserId,
    });

    // A delegation has to be honoured on the runs that can actually issue a
    // credential. Those resolve a principal for `issue_commented` work and null it
    // for `company_default` work, and the pool used to be unreachable in both: the
    // credential paths hard-coded `allowStandingDelegation: false`, and the pool
    // itself additionally demanded a null principal.
    for (const responsibleUserId of [null, `unrelated-${randomUUID()}`]) {
      const selection = await resolveManagedGitHubIdentitySelection(db, companyId, { agentId: delegatedAgentId, responsibleUserId });
      expect(selection.grant?.id).toBe(grant!.id);
      // Borrowing the operator's identity is reported as borrowing it. The same
      // grant read by the owner's own run below reports `personal`, so the two
      // are distinguishable from outside -- which they were not when this value
      // was computed from `grant.kind`.
      expect(selection.identitySource).toBe("delegated");
    }

    // Delegation is per agent. The undelegated agent sees nothing, which is what
    // keeps this narrower than a company-wide loan of the operator's identity.
    const undelegated = await resolveManagedGitHubIdentitySelection(db, companyId, { agentId: otherAgentId, responsibleUserId: null });
    expect(undelegated.grant).toBeUndefined();
    expect(undelegated.error).toBe("No managed GitHub identity is available for this run");
    expect(undelegated.identitySource).toBeUndefined();

    // The owner's own runs keep using their own grant directly: precedence puts
    // `personal` ahead of `delegated`, so a delegation can never shadow it.
    // Same grant, same row, different run -- and now a different reported pool,
    // which is the whole point of separating the two values.
    await expect(resolveManagedGitHubIdentitySelection(db, companyId, { agentId: otherAgentId, responsibleUserId: ownerUserId }))
      .resolves.toMatchObject({ grant: expect.objectContaining({ id: grant!.id }), identitySource: "personal" });

    await db.delete(connectionGrantDelegations).where(eq(connectionGrantDelegations.grantId, grant!.id));
    await db.delete(connectionGrants).where(eq(connectionGrants.id, grant!.id));
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection!.id));
    await db.delete(toolConnections).where(eq(toolConnections.id, connection!.id));
  });

  // Readiness derived the borrowable principal straight from the run row, while
  // the credential broker nulls it for a `company_default` run -- an automation
  // tick has no operator behind it, so it must not borrow one implicitly. With a
  // single personal grant that split is directly observable: readiness matched the
  // grant and answered `ready` while the export path resolved nothing and handed
  // back an empty environment, and because `request` gates on the same check the
  // agent could not raise a card about it either. Both planes have to derive the
  // principal identically.
  it("does not report a borrowable personal identity as ready on an ownerless run", async () => {
    const companyId = claims.company_id;
    const ownerUserId = claims.responsible_user_id!;
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Automation Agent", role: "engineer", status: "active", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Publish a preview", status: "in_progress", priority: "medium", assigneeAgentId: agentId });

    const [application] = await db.insert(toolApplications).values({
      companyId, applicationKey: `github-${randomUUID()}`, name: `GitHub (principal ${randomUUID()})`, type: "mcp_http",
      status: "active", metadata: { sourceTemplateKey: "github" },
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: application!.id, name: `Operator's GitHub ${randomUUID()}`, uid: `github/${randomUUID()}`,
      transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_agent", status: "active",
      enabled: true, healthStatus: "ok",
      config: { sourceTemplateKey: "github" }, transportConfig: { sourceTemplateKey: "github" },
    }).returning();
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: connection!.id, targetType: "agent", targetId: agentId });
    const [profile] = await db.insert(toolProfiles).values({ companyId, name: `GitHub principal reads ${randomUUID()}`, profileKey: `github-principal-${randomUUID()}`, defaultAction: "allow", status: "active" }).returning();
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile!.id, targetType: "agent", targetId: agentId });
    await db.insert(toolCatalogEntries).values({ companyId, connectionId: connection!.id, toolName: "get-me", name: "get-me", versionHash: "fixture-v1", status: "active", entryKind: "tool" });

    // Everything about this grant is healthy -- active, live provider metadata, a
    // readable company-scoped secret -- so the run's principal is the only thing
    // that can decide the outcome. The grant is subjected to the operator, which
    // is exactly what both runs below resolve as their responsible user.
    const [secret] = await db.insert(companySecrets).values({
      companyId, scope: "company", key: `github-token-${randomUUID()}`, name: `GitHub token ${randomUUID()}`, status: "active",
    }).returning();
    const [grant] = await db.insert(connectionGrants).values({
      companyId, connectionId: connection!.id, kind: "user", subjectUserId: ownerUserId, status: "active",
      createdByUserId: ownerUserId,
      providerTenant: { github: {
        userId: "gh-1", login: "operator", installationCount: 1, repositoryCount: 4,
        repositorySelection: "all", installationIds: ["1"], installationOwnerLogins: ["operator"],
      } },
      credentialSecretRefs: [{ secretId: secret!.id, configPath: "oauth.access_token" }],
    }).returning();

    const runFor = async (cause: string) => {
      const runIdForCause = randomUUID();
      const [context] = await db.insert(runIdentityContexts).values({
        companyId, runId: runIdForCause, revision: 1, responsibleUserId: ownerUserId,
        cause, correlationId: `${cause}-${randomUUID()}`, status: "accepted", acceptedAt: new Date(),
      }).returning();
      await db.insert(heartbeatRuns).values({
        id: runIdForCause, companyId, agentId, status: "running", responsibleUserId: ownerUserId,
        activeIdentityContextId: context!.id, contextSnapshot: { issueId },
      });
      return { ...claims, sub: agentId, run_id: runIdForCause } satisfies RuntimeToolsTokenClaims;
    };
    const service = connectionIntentService(db);
    const githubResult = async (forClaims: RuntimeToolsTokenClaims) =>
      (await service.search(forClaims, "github")).results.find((result) => result.service === "github");

    // Control: an operator-caused wake does borrow the operator's identity, so the
    // same fixtures report ready. Without this the assertion below could pass for
    // any reason at all.
    const operatorClaims = await runFor("issue_commented");
    expect(await githubResult(operatorClaims)).toMatchObject({ state: "ready", connectionId: connection!.id });

    // The ownerless run must not, and the escalation path has to stay open for it.
    const automationClaims = await runFor("company_default");
    expect(await githubResult(automationClaims)).toMatchObject({ state: "needs_user_action", connectionId: null });
    const request = await service.request(automationClaims, "github");
    expect(request.state).toBe("needs_user_action");
    expect(request.interactionId).not.toBeNull();

    // And the sanctioned repair closes it on both planes at once: a standing
    // delegation is the explicit, audited loan of that identity to this agent.
    await db.insert(connectionGrantDelegations).values({
      companyId, grantId: grant!.id, agentId, createdByUserId: ownerUserId,
    });
    expect(await githubResult(automationClaims)).toMatchObject({ state: "ready", connectionId: connection!.id });
    expect((await service.request(automationClaims, "github")).state).toBe("ready");

    await db.delete(connectionGrantDelegations).where(eq(connectionGrantDelegations.grantId, grant!.id));
    await db.delete(connectionGrants).where(eq(connectionGrants.id, grant!.id));
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection!.id));
    await db.delete(toolConnections).where(eq(toolConnections.id, connection!.id));
  });

});
