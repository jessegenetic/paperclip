import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  companyMemberships,
  companySecrets,
  connectionGrantDelegations,
  connectionGrants,
  toolConnectionInstalls,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import { HttpError } from "../errors.ts";
import {
  DEFAULT_GITHUB_TOKEN_SECRET_NAMES,
  GIT_CREDENTIAL_TOKEN_ENV_KEY,
  buildGitAuthInvocation,
  classifyGitHubIdentitySource,
  createGitRemoteAuthProvider,
  describeGitAuthFailure,
  isGitHubHttpsRemoteUrl,
  resolveManagedGitHubCredential,
  scrubGitCredentialText,
} from "../services/git-credentials.ts";

const fakeDb = null as unknown as Db;

function buildSecretsFake(byName: Record<string, string | Error>) {
  const getByName = vi.fn(async (_companyId: string, name: string) => {
    if (!(name in byName)) return null;
    return { id: `secret-${name}` };
  });
  const resolveSecretValue = vi.fn(async (_companyId: string, secretId: string) => {
    const name = secretId.replace(/^secret-/, "");
    const value = byName[name];
    if (value instanceof Error) throw value;
    return value ?? "";
  });
  return { getByName, resolveSecretValue };
}

describe("isGitHubHttpsRemoteUrl", () => {
  it("accepts https github.com and www.github.com URLs", () => {
    expect(isGitHubHttpsRemoteUrl("https://github.com/example/repo.git")).toBe(true);
    expect(isGitHubHttpsRemoteUrl("https://www.github.com/example/repo.git")).toBe(true);
  });

  it("rejects ssh, http, enterprise hosts, other providers, userinfo URLs, and non-URLs", () => {
    expect(isGitHubHttpsRemoteUrl("git@github.com:example/repo.git")).toBe(false);
    expect(isGitHubHttpsRemoteUrl("ssh://git@github.com/example/repo.git")).toBe(false);
    expect(isGitHubHttpsRemoteUrl("http://github.com/example/repo.git")).toBe(false);
    expect(isGitHubHttpsRemoteUrl("https://github.enterprise.example/org/repo.git")).toBe(false);
    expect(isGitHubHttpsRemoteUrl("https://gitlab.com/example/repo.git")).toBe(false);
    expect(isGitHubHttpsRemoteUrl("https://alice:token@github.com/example/repo.git")).toBe(false);
    expect(isGitHubHttpsRemoteUrl("/local/path/repo.git")).toBe(false);
  });
});

describe("createGitRemoteAuthProvider", () => {
  const githubUrl = "https://github.com/example/repo.git";

  it("prefers company secrets in declared order", async () => {
    const secrets = buildSecretsFake({ GH_TOKEN: "gh-token", PAPERCLIP_GITHUB_TOKEN: "pc-token" });
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets,
      env: { GITHUB_TOKEN: "env-token" },
    });
    const invocation = await provider(githubUrl);
    expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("gh-token");
    expect(invocation?.source).toBe("company_secret");
    expect(invocation?.secretName).toBe("GH_TOKEN");
    // GITHUB_TOKEN is probed first even though only GH_TOKEN exists.
    expect(secrets.getByName.mock.calls.map((call) => call[1])).toEqual(["GITHUB_TOKEN", "GH_TOKEN"]);
  });

  it("falls back to the server env, GITHUB_TOKEN before GH_TOKEN", async () => {
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets: buildSecretsFake({}),
      env: { GITHUB_TOKEN: "env-github", GH_TOKEN: "env-gh" },
    });
    const invocation = await provider(githubUrl);
    expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("env-github");
    expect(invocation?.source).toBe("server_env");
    expect(invocation?.secretName).toBeNull();
  });

  it("returns null when no token is available anywhere", async () => {
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets: buildSecretsFake({}),
      env: {},
    });
    await expect(provider(githubUrl)).resolves.toBeNull();
  });

  it("accepts GitHub SSH remotes for process-scoped HTTPS rewriting", async () => {
    const secrets = buildSecretsFake({ GITHUB_TOKEN: "token" });
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets,
      env: {},
    });
    const invocation = await provider("git@github.com:example/repo.git");
    expect(invocation?.env.GIT_CONFIG_VALUE_3).toBe("git@github.com:");
    expect(invocation?.env.GIT_CONFIG_KEY_3).toBe("url.https://github.com/.insteadOf");
  });

  it("returns null for non-GitHub URLs without touching the secret store", async () => {
    const secrets = buildSecretsFake({ GITHUB_TOKEN: "token" });
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets,
      env: {},
    });
    await expect(provider("https://gitlab.com/example/repo.git")).resolves.toBeNull();
    expect(secrets.getByName).not.toHaveBeenCalled();
  });

  it("memoizes the credential lookup across calls", async () => {
    const secrets = buildSecretsFake({ GITHUB_TOKEN: "token" });
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets,
      env: {},
    });
    await provider(githubUrl);
    await provider(githubUrl);
    await provider("https://github.com/example/another.git");
    expect(secrets.getByName).toHaveBeenCalledTimes(1);
    expect(secrets.resolveSecretValue).toHaveBeenCalledTimes(1);
  });

  it("passes a system access context so resolution is audited", async () => {
    const secrets = buildSecretsFake({ GITHUB_TOKEN: "token" });
    const provider = createGitRemoteAuthProvider(
      fakeDb,
      "company-1",
      { issueId: "issue-1", heartbeatRunId: "run-1" },
      { secrets, env: {} },
    );
    await provider(githubUrl);
    expect(secrets.resolveSecretValue).toHaveBeenCalledWith("company-1", "secret-GITHUB_TOKEN", "latest", {
      accessContext: expect.objectContaining({
        consumerType: "system",
        consumerId: "workspace-git-credential",
        actorType: "system",
        issueId: "issue-1",
        heartbeatRunId: "run-1",
      }),
    });
  });

  it("continues down the chain when one secret fails to resolve", async () => {
    const secrets = buildSecretsFake({
      GITHUB_TOKEN: new Error("provider outage"),
      GH_TOKEN: "gh-token",
    });
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets,
      env: {},
    });
    const invocation = await provider(githubUrl);
    expect(invocation?.secretName).toBe("GH_TOKEN");
  });

  it("ignores a managed connection installed only for another agent", async () => {
    const query = (rows: unknown[]) => ({
      from: () => ({ where: async () => rows }),
    });
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(query([{
          id: "github-connection",
          companyId: "company-1",
          enabled: true,
          status: "active",
          config: { sourceTemplateKey: "github" },
        }]))
        .mockReturnValueOnce(query([{
          connectionId: "github-connection",
          companyId: "company-1",
          targetType: "agent",
          targetId: "agent-a",
        }])),
    } as unknown as Db;
    const secrets = buildSecretsFake({ GH_TOKEN: "agent-b-legacy-token" });
    const provider = createGitRemoteAuthProvider(db, "company-1", { agentId: "agent-b" }, {
      secrets,
      env: {},
    });

    const invocation = await provider(githubUrl);

    expect(invocation?.source).toBe("company_secret");
    expect(invocation?.secretName).toBe("GH_TOKEN");
    expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("agent-b-legacy-token");
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});

describe("buildGitAuthInvocation", () => {
  it("keeps the token out of argv and installs the helper URL-scoped to github.com", () => {
    const invocation = buildGitAuthInvocation({
      token: "super-secret-token",
      source: "company_secret",
      secretName: "GITHUB_TOKEN",
    });
    expect(invocation.configArgs.join(" ")).not.toContain("super-secret-token");
    expect(invocation.configArgs[0]).toBe("-c");
    expect(invocation.configArgs[1]).toBe("credential.helper=");
    expect(invocation.configArgs[3]).toContain("credential.https://github.com.helper=");
    expect(invocation.configArgs[3]).toContain("x-access-token");
    expect(invocation.configArgs[5]).toContain("credential.https://www.github.com.helper=");
    expect(invocation.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("super-secret-token");
    expect(invocation.env.GH_TOKEN).toBe("super-secret-token");
    expect(invocation.env.GITHUB_TOKEN).toBe("super-secret-token");
    expect(invocation.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(invocation.env).not.toHaveProperty("HOME");
  });

  it("sets GitHub's stable noreply commit identity without exposing the token in config", () => {
    const invocation = buildGitAuthInvocation({
      token: "super-secret-token",
      source: "managed_connection",
      secretName: null,
      githubIdentity: { userId: "12345", login: "octocat" },
    });
    expect(invocation.env.GIT_CONFIG_KEY_7).toBe("user.name");
    expect(invocation.env.GIT_CONFIG_VALUE_7).toBe("octocat");
    expect(invocation.env.GIT_CONFIG_KEY_8).toBe("user.email");
    expect(invocation.env.GIT_CONFIG_VALUE_8).toBe("12345+octocat@users.noreply.github.com");
    expect(invocation.env.GIT_AUTHOR_NAME).toBe("octocat");
    expect(invocation.env.GIT_AUTHOR_EMAIL).toBe("12345+octocat@users.noreply.github.com");
    expect(invocation.env.GIT_COMMITTER_NAME).toBe("octocat");
    expect(invocation.env.GIT_COMMITTER_EMAIL).toBe("12345+octocat@users.noreply.github.com");
    expect(Object.values(invocation.env).filter((value) => value.includes("super-secret-token"))).toHaveLength(3);
  });
});

describe("credential helper execution (real git, no network)", () => {
  async function runCredentialFill(description: string) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-cred-fill-"));
    try {
      const invocation = buildGitAuthInvocation({
        token: "abc123",
        source: "company_secret",
        secretName: "GITHUB_TOKEN",
      });
      return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn("git", [...invocation.configArgs, "credential", "fill"], {
            cwd,
            env: { ...process.env, ...invocation.env },
            stdio: ["pipe", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => { stdout += String(chunk); });
          child.stderr.on("data", (chunk) => { stderr += String(chunk); });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout, stderr }));
          child.stdin.write(description);
          child.stdin.end();
        },
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }

  it("answers a github.com https request with the env-carried token", async () => {
    const result = await runCredentialFill("protocol=https\nhost=github.com\n\n");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("username=x-access-token");
    expect(result.stdout).toContain("password=abc123");
  });

  it("never hands the token to another host, even if git asks", async () => {
    // Simulates a request whose effective host changed after our pre-invocation URL check
    // (for example a repository-local url.<base>.insteadOf rewrite): the URL-scoped helper
    // config keeps git from consulting the helper, prompts are disabled, so the fill fails
    // and the token is never emitted.
    const result = await runCredentialFill("protocol=https\nhost=evil.example\n\n");
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("abc123");
  });

  it("never answers plain-http requests for github.com", async () => {
    const result = await runCredentialFill("protocol=http\nhost=github.com\n\n");
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("abc123");
  });
});

describe("scrubGitCredentialText", () => {
  it("masks URL userinfo", () => {
    expect(scrubGitCredentialText("https://x-access-token:ghp_secret@github.com/a/b.git")).toBe(
      "https://***@github.com/a/b.git",
    );
  });

  it("masks userinfo on non-HTTP schemes, leaving scp-style remotes alone", () => {
    expect(scrubGitCredentialText("ssh://deploy:hunter2@internal.example/repo.git")).toBe(
      "ssh://***@internal.example/repo.git",
    );
    expect(scrubGitCredentialText("git@github.com:example/repo.git")).toBe(
      "git@github.com:example/repo.git",
    );
  });

  it("masks entire URL query strings regardless of parameter names", () => {
    expect(scrubGitCredentialText("https://github.com/a/b.git?access_token=ghs_secret&ref=main")).toBe(
      "https://github.com/a/b.git?***",
    );
    expect(scrubGitCredentialText("https://host.example/r.git?obscure_cred_name=secret")).toBe(
      "https://host.example/r.git?***",
    );
  });

  it("leaves credential-free text unchanged", () => {
    expect(scrubGitCredentialText("fatal: repository not found")).toBe("fatal: repository not found");
  });
});

describe("describeGitAuthFailure", () => {
  it("names the company secret when a stored credential was used", () => {
    expect(describeGitAuthFailure({
      error: "fatal: Authentication failed",
      used: { source: "company_secret", secretName: "GH_TOKEN" },
    })).toContain("the GH_TOKEN company-secret GitHub credential");
  });

  it("names the server environment when an env credential was used", () => {
    expect(describeGitAuthFailure({
      error: "fatal: Authentication failed",
      used: { source: "server_env", secretName: null },
    })).toContain("server-environment GitHub credential");
  });

  it("points at Settings → Secrets for auth-looking failures without a credential", () => {
    expect(describeGitAuthFailure({
      error: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      used: null,
    })).toContain("add a GITHUB_TOKEN or GH_TOKEN company secret");
  });

  it("stays silent for non-auth failures without a credential", () => {
    expect(describeGitAuthFailure({
      error: "fatal: unable to resolve host example.invalid",
      used: null,
    })).toBeNull();
  });

  it("stays silent for non-auth failures even when a credential was used", () => {
    // A credential present during an unrelated failure (network outage, target-path
    // collision) must not be blamed for it.
    expect(describeGitAuthFailure({
      error: "fatal: destination path '/x/y' already exists and is not an empty directory.",
      used: { source: "company_secret", secretName: "GH_TOKEN" },
    })).toBeNull();
  });
});

describe("resolveManagedGitHubCredential", () => {
  const githubTenant = {
    github: { userId: "gh-1", login: "operator", installationCount: 1, repositoryCount: 1 },
  };

  // The resolver reads six tables through the same `select().from().where()` shape
  // (two of them with `.limit(1)`), so dispatch canned rows by table identity and
  // let the resolver's own filtering decide what it does with them.
  function buildManagedDb(rows: Partial<Record<
    "connections" | "installs" | "grants" | "delegations" | "secrets" | "memberships",
    unknown[]
  >>) {
    const byTable = new Map<unknown, unknown[]>([
      [toolConnections, rows.connections ?? []],
      [toolConnectionInstalls, rows.installs ?? []],
      [connectionGrants, rows.grants ?? []],
      [connectionGrantDelegations, rows.delegations ?? []],
      [companySecrets, rows.secrets ?? []],
      [companyMemberships, rows.memberships ?? []],
    ]);
    const answer = (table: unknown) => {
      const data = byTable.get(table) ?? [];
      const pending = Promise.resolve(data) as Promise<unknown[]> & { limit: (count: number) => Promise<unknown[]> };
      pending.limit = async (count: number) => data.slice(0, count);
      return pending;
    };
    const from = (table: unknown) => ({
      where: () => answer(table),
      leftJoin: () => ({ where: () => answer(table) }),
    });
    return { select: () => ({ from }) } as unknown as Db;
  }

  function buildScenario(options: {
    grant: Record<string, unknown>;
    secret?: Record<string, unknown> | null;
    memberships?: unknown[];
    delegations?: unknown[];
    resolveSecretValue?: () => Promise<string>;
  }) {
    const db = buildManagedDb({
      delegations: options.delegations ?? [],
      connections: [{
        id: "github-connection", companyId: "company-1", enabled: true, status: "active",
        healthStatus: "ok", config: { sourceTemplateKey: "github" },
      }],
      installs: [{
        connectionId: "github-connection", companyId: "company-1",
        targetType: "company", targetId: "company-1",
      }],
      grants: [{
        id: "grant-1", companyId: "company-1", connectionId: "github-connection",
        status: "active", createdAt: new Date("2026-09-28T00:00:00Z"),
        credentialSecretRefs: [{ secretId: "secret-1", configPath: "oauth.access_token" }],
        providerTenant: githubTenant, subjectUserId: null, subjectAgentId: null,
        ...options.grant,
      }],
      // A complete secret row. Selection now verifies the access token is readable
      // before handing the grant on, so `id`/`status`/`definitionStatus` are load
      // bearing: while selection short-circuited on a lone candidate these fields
      // were never read, and a fixture could omit them and still pass.
      secrets: options.secret === null ? [] : [{
        id: "secret-1", status: "active", deletedAt: null,
        scope: "user", ownerUserId: "owner-1", userSecretDefinitionId: "definition-1",
        definitionStatus: "active", definitionDeletedAt: null,
        ...options.secret,
      }],
      memberships: options.memberships ?? [{ id: "membership-1", role: "admin" }],
    });
    const resolveUserSecretValue = vi.fn(async () => ({ value: "personal-token" }));
    // Mirror the real secret service: the company-secret path refuses a
    // user-scoped secret (secrets.ts `secret_scope_invalid`), which is exactly
    // the throw that made a dedicated agent grant unusable.
    const scope = options.secret?.scope ?? "user";
    const secrets = {
      ...buildSecretsFake({}),
      resolveSecretValue: vi.fn(options.resolveSecretValue ?? (async () => {
        if (scope !== "company") {
          throw new HttpError(422, "User-scoped secrets must be resolved through user secret declarations", {
            code: "secret_scope_invalid",
          });
        }
        return "company-token";
      })),
      resolveUserSecretValue,
    } as unknown as Parameters<typeof resolveManagedGitHubCredential>[1];
    return { db, secrets, resolveUserSecretValue };
  }

  it("reads a user-scoped credential through a dedicated agent grant", async () => {
    const { db, secrets, resolveUserSecretValue } = buildScenario({
      grant: { kind: "agent", subjectAgentId: "agent-a" },
    });

    const result = await resolveManagedGitHubCredential(db, secrets, "company-1", { agentId: "agent-a" });

    expect(result.error).toBeUndefined();
    expect(result.credential?.token).toBe("personal-token");
    expect(result.credential?.identitySource).toBe("dedicated");
    // The credential is attributed to its owner, not to the borrowing agent, so
    // the secret access event still names the real principal.
    expect(resolveUserSecretValue).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ definitionId: "definition-1", responsibleUserId: "owner-1" }),
      expect.anything(),
    );
  });

  it("refuses a borrowed credential whose owner is no longer an authorized member", async () => {
    const revoked = buildScenario({ grant: { kind: "agent", subjectAgentId: "agent-a" }, memberships: [] });
    await expect(resolveManagedGitHubCredential(revoked.db, revoked.secrets, "company-1", { agentId: "agent-a" }))
      .resolves.toMatchObject({ error: "The managed GitHub identity owner is not an authorized company member" });
    expect(revoked.resolveUserSecretValue).not.toHaveBeenCalled();

    const viewer = buildScenario({
      grant: { kind: "agent", subjectAgentId: "agent-a" },
      memberships: [{ id: "membership-1", role: "viewer" }],
    });
    await expect(resolveManagedGitHubCredential(viewer.db, viewer.secrets, "company-1", { agentId: "agent-a" }))
      .resolves.toMatchObject({ error: "The managed GitHub identity owner is not an authorized company member" });
    expect(viewer.resolveUserSecretValue).not.toHaveBeenCalled();
  });

  it("keeps a user grant pinned to its own subject", async () => {
    const { db, secrets, resolveUserSecretValue } = buildScenario({
      grant: { kind: "user", subjectUserId: "someone-else" },
    });

    const result = await resolveManagedGitHubCredential(db, secrets, "company-1", {
      responsibleUserId: "someone-else",
    });

    expect(result.credential).toBeUndefined();
    expect(result.error).toBe("The personal GitHub credential is invalid");
    expect(resolveUserSecretValue).not.toHaveBeenCalled();
  });

  it("still resolves a company-scoped credential through the company path", async () => {
    const { db, secrets, resolveUserSecretValue } = buildScenario({
      grant: { kind: "agent", subjectAgentId: "agent-a" },
      secret: { scope: "company", ownerUserId: null, userSecretDefinitionId: null },
    });

    const result = await resolveManagedGitHubCredential(db, secrets, "company-1", { agentId: "agent-a" });

    expect(result.credential?.token).toBe("company-token");
    expect(resolveUserSecretValue).not.toHaveBeenCalled();
  });

  it("reports a configuration failure with its code instead of calling it temporary", async () => {
    const { db, secrets } = buildScenario({
      grant: { kind: "agent", subjectAgentId: "agent-a" },
      secret: { scope: "company", ownerUserId: null, userSecretDefinitionId: null },
      resolveSecretValue: async () => {
        throw new HttpError(422, "User-scoped secrets must be resolved through user secret declarations", {
          code: "secret_scope_invalid",
        });
      },
    });

    const result = await resolveManagedGitHubCredential(db, secrets, "company-1", { agentId: "agent-a" });

    expect(result.credential).toBeUndefined();
    expect(result.error).toContain("secret_scope_invalid");
    expect(result.error).not.toContain("temporarily unavailable");
  });

  // A lone candidate used to skip credential validation entirely, so selection
  // returned a grant whose token could not be read. Agent-facing readiness reports
  // a connection `ready` from that selection alone, which is how the same
  // connection could advertise itself as usable and then hand back no credentials.
  const REBIND = "The managed GitHub identity's access token cannot be read; rebind the connection's credentials";

  it("refuses a lone grant whose access-token secret is missing or deleted", async () => {
    const absent = buildScenario({ grant: { kind: "agent", subjectAgentId: "agent-a" }, secret: null });
    await expect(resolveManagedGitHubCredential(absent.db, absent.secrets, "company-1", { agentId: "agent-a" }))
      .resolves.toMatchObject({ configured: true, error: REBIND });
    expect(absent.resolveUserSecretValue).not.toHaveBeenCalled();

    const deleted = buildScenario({
      grant: { kind: "agent", subjectAgentId: "agent-a" },
      secret: { deletedAt: new Date("2026-09-28T00:00:00Z") },
    });
    await expect(resolveManagedGitHubCredential(deleted.db, deleted.secrets, "company-1", { agentId: "agent-a" }))
      .resolves.toMatchObject({ error: REBIND });

    const inactive = buildScenario({
      grant: { kind: "agent", subjectAgentId: "agent-a" },
      secret: { status: "revoked" },
    });
    await expect(resolveManagedGitHubCredential(inactive.db, inactive.secrets, "company-1", { agentId: "agent-a" }))
      .resolves.toMatchObject({ error: REBIND });
  });

  it("refuses a lone grant whose user secret declaration is revoked", async () => {
    const revoked = buildScenario({
      grant: { kind: "agent", subjectAgentId: "agent-a" },
      secret: { definitionStatus: "revoked" },
    });
    await expect(resolveManagedGitHubCredential(revoked.db, revoked.secrets, "company-1", { agentId: "agent-a" }))
      .resolves.toMatchObject({ error: REBIND });
    expect(revoked.resolveUserSecretValue).not.toHaveBeenCalled();
  });

  // Guards the fix against over-reach in both directions: readability must not be
  // conflated with provider-metadata freshness (which would break the working
  // dedicated grant), nor with the user-grant subject pin (which has its own,
  // more accurate message and must keep reporting that instead of a rebind).
  it("keeps lost repository access and the subject pin out of the rebind message", async () => {
    // Zero install/repository counts are already rejected downstream on their own
    // terms. The readability gate must not reach this case first and relabel it,
    // because "rebind the credentials" would send an operator to replace a token
    // that is fine -- the access behind it is what went away.
    const stale = buildScenario({
      grant: {
        kind: "agent", subjectAgentId: "agent-a",
        providerTenant: { github: { userId: "gh-1", login: "operator", installationCount: 0, repositoryCount: 0 } },
      },
    });
    const staleResult = await resolveManagedGitHubCredential(stale.db, stale.secrets, "company-1", { agentId: "agent-a" });
    expect(staleResult.error).toBe("The managed GitHub identity no longer has repository access");
    expect(staleResult.error).not.toBe(REBIND);

    // Same for a user grant pointing at someone else's secret: an invalid grant,
    // reported as such by the resolution path rather than as a rebind.
    const pinned = buildScenario({ grant: { kind: "user", subjectUserId: "someone-else" } });
    const pinnedResult = await resolveManagedGitHubCredential(pinned.db, pinned.secrets, "company-1", {
      responsibleUserId: "someone-else",
    });
    expect(pinnedResult.error).toBe("The personal GitHub credential is invalid");
    expect(pinnedResult.error).not.toBe(REBIND);

    // An OAuth vault grant declares no access-token secret ref: its token lives in
    // `externalCredential` and is refreshed by the grant refresher. Judging it by
    // company-secret readability would reject a working connection outright, which
    // is what `tool-gateway-service`'s legacy-shared-policy case proves end to end.
    const vaulted = buildScenario({
      grant: { kind: "agent", subjectAgentId: "agent-a", credentialSecretRefs: [] },
      secret: null,
    });
    const vaultedResult = await resolveManagedGitHubCredential(vaulted.db, vaulted.secrets, "company-1", {
      agentId: "agent-a",
    });
    expect(vaultedResult.error).not.toBe(REBIND);
  });

  // Standing delegation is the owner-authorized route for lending a personal
  // identity to one agent. Agent scoping is enforced in SQL, so it is proven
  // against a real database in `connection-intents-service.test.ts`; these cover
  // the resolution path a selected delegation then has to survive.
  it("reads a delegated personal credential on a run whose own principal has no grant", async () => {
    const { db, secrets, resolveUserSecretValue } = buildScenario({
      grant: { kind: "user", subjectUserId: "owner-1" },
      delegations: [{ grantId: "grant-1", agentId: "agent-a" }],
    });

    const result = await resolveManagedGitHubCredential(db, secrets, "company-1", {
      agentId: "agent-a",
      // A different principal than the grant's subject. The delegated pool used to
      // require this to be null, which is the one context the credential export
      // produced *and* the one where it disabled delegation outright.
      responsibleUserId: "someone-else",
    });

    expect(result.error).toBeUndefined();
    expect(result.credential?.token).toBe("personal-token");
    // Reported as borrowed, not as this run's own identity. This assertion read
    // `personal` while the test's own name said delegated -- the value was
    // computed from `grant.kind`, and a borrowed identity is a `user` grant
    // exactly like a directly-subjected one.
    expect(result.credential?.identitySource).toBe("delegated");
    expect(resolveUserSecretValue).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ responsibleUserId: "owner-1" }),
      expect.anything(),
    );

    // The contrast that makes the value load-bearing: the *same* grant read by
    // the owner's own run is `personal`. One grant, two runs, two answers.
    const own = buildScenario({ grant: { kind: "user", subjectUserId: "owner-1" } });
    const ownResult = await resolveManagedGitHubCredential(own.db, own.secrets, "company-1", {
      agentId: "agent-a",
      responsibleUserId: "owner-1",
    });
    expect(ownResult.credential?.token).toBe("personal-token");
    expect(ownResult.credential?.identitySource).toBe("personal");
  });

  // The MCP gateway holds a grant but not the pool it came from, so it
  // classifies with this rather than re-deriving from `kind` -- which is what
  // made the MCP plane report `personal` for a borrowed credential too. The
  // gateway's own call sites are covered only by typecheck; this pins the
  // classification both planes now share.
  it("classifies a grant against the run it was selected for", () => {
    const agentGrant = { kind: "agent", subjectAgentId: "agent-a", subjectUserId: null };
    const userGrant = { kind: "user", subjectAgentId: null, subjectUserId: "owner-1" };

    expect(classifyGitHubIdentitySource(agentGrant, { agentId: "agent-a", responsibleUserId: null })).toBe("dedicated");
    expect(classifyGitHubIdentitySource(userGrant, { agentId: "agent-a", responsibleUserId: "owner-1" })).toBe("personal");
    // Same user grant, a run whose principal is not its subject: reachable only
    // through a standing delegation, so that is what it is called.
    expect(classifyGitHubIdentitySource(userGrant, { agentId: "agent-a", responsibleUserId: "someone-else" })).toBe("delegated");
    expect(classifyGitHubIdentitySource(userGrant, { agentId: "agent-a", responsibleUserId: null })).toBe("delegated");
    // A null principal must not collide with a grant that has no subject user.
    expect(classifyGitHubIdentitySource({ kind: "user", subjectAgentId: null, subjectUserId: null }, { agentId: "agent-a", responsibleUserId: null })).toBe("delegated");
    // An agent grant subjected to a *different* agent is never this run's own.
    expect(classifyGitHubIdentitySource({ kind: "agent", subjectAgentId: "agent-b", subjectUserId: null }, { agentId: "agent-a", responsibleUserId: null })).not.toBe("dedicated");
  });

  it("reports no identity source at all when no pool matched", async () => {
    // `personal` used to be returned here too, so the string that means "the
    // operator's own grant was selected" was also what every zero-candidate
    // failure on this fault reported. An operator reading `source: personal`
    // beside an empty `env` could not tell which had happened.
    const { db, secrets } = buildScenario({ grant: { kind: "user", subjectUserId: "owner-1" } });
    const result = await resolveManagedGitHubCredential(db, secrets, "company-1", {
      agentId: "agent-a",
      responsibleUserId: "someone-else",
    });

    expect(result.credential).toBeUndefined();
    expect(result.error).toBe("No managed GitHub identity is available for this run");
    expect(result.identitySource).toBeUndefined();
  });

  it("refuses a delegated credential once its owner is no longer an authorized member", async () => {
    const { db, secrets } = buildScenario({
      grant: { kind: "user", subjectUserId: "owner-1" },
      delegations: [{ grantId: "grant-1", agentId: "agent-a" }],
      memberships: [],
    });

    await expect(resolveManagedGitHubCredential(db, secrets, "company-1", {
      agentId: "agent-a", responsibleUserId: null,
    })).resolves.toMatchObject({
      error: "The managed GitHub identity owner is not an authorized company member",
    });
  });

  it("still reports an unexpected failure as temporary", async () => {
    const { db, secrets } = buildScenario({
      grant: { kind: "agent", subjectAgentId: "agent-a" },
      secret: { scope: "company", ownerUserId: null, userSecretDefinitionId: null },
      resolveSecretValue: async () => { throw new Error("provider outage"); },
    });

    const result = await resolveManagedGitHubCredential(db, secrets, "company-1", { agentId: "agent-a" });

    expect(result.error).toBe("GitHub credentials are temporarily unavailable");
  });
});

describe("DEFAULT_GITHUB_TOKEN_SECRET_NAMES", () => {
  it("keeps the shared name order stable", () => {
    expect([...DEFAULT_GITHUB_TOKEN_SECRET_NAMES]).toEqual([
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "PAPERCLIP_GITHUB_TOKEN",
    ]);
  });
});
