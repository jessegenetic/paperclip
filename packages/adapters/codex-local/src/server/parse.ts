import {
  asString,
  asNumber,
  parseObject,
  parseJson,
} from "@paperclipai/adapter-utils/server-utils";

const CODEX_TRANSIENT_UPSTREAM_RE =
  /(?:we(?:'|’)re\s+currently\s+experiencing\s+high\s+demand|temporary\s+errors|rate[-\s]?limit(?:ed)?|too\s+many\s+requests|\b429\b|server\s+overloaded|service\s+unavailable|try\s+again\s+later)/i;
const CODEX_REMOTE_COMPACTION_RE = /remote\s+compact\s+task/i;
const CODEX_USAGE_LIMIT_RE =
  /(?:you(?:'|’)ve hit your usage limit|usage limit (?:reached|exceeded))/i;
// The reset clock is wherever the message puts "try again at". Codex has moved
// it between wordings — first model-switch advice ("...for GPT-5. Switch to
// another model now, or try again at 4:30 PM"), now a credits/Visit-URL
// sentence ("...to purchase more credits or try again at Oct 3rd, 2026 10:00
// AM.") — so match the clause itself rather than the sentence around it.
const CODEX_USAGE_LIMIT_RESET_RE =
  /(?:try again at|resets?(?:\s+at)?)\s+([^\n]+?)\s*(?:[.!](?:\s|$)|\n|$)/i;
const CODEX_PROVIDER_QUOTA_RE =
  /(?:you(?:'|’)ve hit your usage limit|usage limit|model (?:is )?at capacity|at capacity for this model|capacity limit)/i;
const CODEX_REFRESH_TOKEN_REUSED_RE =
  /(?:refresh[_\s-]?token[_\s-]?reused|refresh token (?:has )?already been used|token reuse detected)/i;
const CODEX_REFRESH_TOKEN_EXPIRED_RE =
  /(?:refresh[_\s-]?token[_\s-]?expired|refresh token (?:has )?expired|expired refresh token)/i;
const CODEX_REFRESH_TOKEN_INVALIDATED_RE =
  /(?:refresh[_\s-]?token[_\s-]?(?:invalidated|revoked|invalid)|refresh token (?:has been )?(?:invalidated|revoked|invalid)|invalid refresh token|missing bearer)/i;
const CODEX_OAUTH_INVALID_GRANT_RE = /\binvalid_grant\b/i;
const CODEX_CONTEXTUAL_REFRESH_AUTH_INVALIDATED_RE =
  /(?:(?:oauth|refresh|access[_\s-]?token|bearer|credential).{0,80}(?:\b401\b|unauthori[sz]ed|\binvalid[\s-]grant\b)|(?:\b401\b|unauthori[sz]ed|\binvalid[\s-]grant\b).{0,80}(?:oauth|refresh|access[_\s-]?token|bearer|credential))/i;

export type CodexAuthRefreshFailureClass =
  | "refresh_token_reused"
  | "refresh_token_expired"
  | "refresh_token_invalidated";

export function parseCodexJsonl(stdout: string) {
  let sessionId: string | null = null;
  let finalMessage: string | null = null;
  let errorMessage: string | null = null;
  let sawProtocolEvent = false;
  let sawProtocolTerminalEvent = false;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type) sawProtocolEvent = true;
    if (type === "error" || type === "turn.completed" || type === "turn.failed") {
      sawProtocolTerminalEvent = true;
    }
    if (type === "thread.started") {
      sessionId = asString(event.thread_id, sessionId ?? "") || sessionId;
      continue;
    }

    if (type === "error") {
      const msg = asString(event.message, "").trim();
      if (msg) errorMessage = msg;
      continue;
    }

    if (type === "item.completed") {
      const item = parseObject(event.item);
      if (asString(item.type, "") === "agent_message") {
        const text = asString(item.text, "");
        if (text) finalMessage = text;
      }
      continue;
    }

    if (type === "turn.completed") {
      const usageObj = parseObject(event.usage);
      usage.inputTokens = asNumber(usageObj.input_tokens, usage.inputTokens);
      usage.cachedInputTokens = asNumber(usageObj.cached_input_tokens, usage.cachedInputTokens);
      usage.outputTokens = asNumber(usageObj.output_tokens, usage.outputTokens);
      continue;
    }

    if (type === "turn.failed") {
      const err = parseObject(event.error);
      const msg = asString(err.message, "").trim();
      if (msg) errorMessage = msg;
    }
  }

  return {
    sessionId,
    summary: finalMessage?.trim() ?? "",
    usage,
    usageBasis: "per_run" as const,
    errorMessage,
    sawProtocolEvent,
    sawProtocolTerminalEvent,
  };
}

/**
 * Structural crash detection: the codex CLI can only report an agent-level
 * failure through the JSONL protocol (an `error` event, `turn.failed`, or a
 * finished `turn.completed` followed by a nonzero exit). A nonzero exit after
 * the protocol stream started but before any terminal event means the process
 * died out from under the agent (MCP transport crash, worker panic, killed
 * tool server) — retriable infrastructure, not agent behavior. This
 * deliberately does not match error text: transport failure strings vary, and
 * stdout/stderr can quote agent output that merely discusses network errors.
 */
export function isCodexHarnessCrash(input: {
  exitCode: number | null;
  sawProtocolEvent: boolean;
  sawProtocolTerminalEvent: boolean;
}): boolean {
  if ((input.exitCode ?? 0) === 0) return false;
  return input.sawProtocolEvent && !input.sawProtocolTerminalEvent;
}

export function isCodexUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return /unknown (session|thread)|session .* not found|thread .* not found|conversation .* not found|missing rollout path for thread|state db missing rollout path|state db returned stale rollout path|no rollout found for thread id/i.test(
    haystack,
  );
}

function buildCodexErrorHaystack(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): string {
  return [
    input.errorMessage ?? "",
    input.stdout ?? "",
    input.stderr ?? "",
  ]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

export function classifyCodexAuthRefreshFailure(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): CodexAuthRefreshFailureClass | null {
  const haystack = buildCodexErrorHaystack(input);

  if (CODEX_REFRESH_TOKEN_REUSED_RE.test(haystack)) return "refresh_token_reused";
  if (CODEX_REFRESH_TOKEN_EXPIRED_RE.test(haystack)) return "refresh_token_expired";
  if (CODEX_REFRESH_TOKEN_INVALIDATED_RE.test(haystack)) return "refresh_token_invalidated";
  if (CODEX_OAUTH_INVALID_GRANT_RE.test(haystack)) return "refresh_token_invalidated";
  if (CODEX_CONTEXTUAL_REFRESH_AUTH_INVALIDATED_RE.test(haystack)) return "refresh_token_invalidated";
  return null;
}

function readTimeZoneParts(date: Date, timeZone: string) {
  const values = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number.parseInt(values.get("year") ?? "", 10),
    month: Number.parseInt(values.get("month") ?? "", 10),
    day: Number.parseInt(values.get("day") ?? "", 10),
    hour: Number.parseInt(values.get("hour") ?? "", 10),
    minute: Number.parseInt(values.get("minute") ?? "", 10),
  };
}

function normalizeResetTimeZone(timeZoneHint: string | null | undefined): string | null {
  const normalized = timeZoneHint?.trim();
  if (!normalized) return null;
  if (/^(?:utc|gmt)$/i.test(normalized)) return "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
    return normalized;
  } catch {
    return null;
  }
}

function dateFromTimeZoneWallClock(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date | null {
  let candidate = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0));
  const targetUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = readTimeZoneParts(candidate, input.timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const offsetMs = targetUtc - actualUtc;
    if (offsetMs === 0) break;
    candidate = new Date(candidate.getTime() + offsetMs);
  }

  const verified = readTimeZoneParts(candidate, input.timeZone);
  if (
    verified.year !== input.year ||
    verified.month !== input.month ||
    verified.day !== input.day ||
    verified.hour !== input.hour ||
    verified.minute !== input.minute
  ) {
    return null;
  }

  return candidate;
}

function nextClockTimeInTimeZone(input: {
  now: Date;
  hour: number;
  minute: number;
  timeZoneHint: string;
}): Date | null {
  const timeZone = normalizeResetTimeZone(input.timeZoneHint);
  if (!timeZone) return null;

  const nowParts = readTimeZoneParts(input.now, timeZone);
  let retryAt = dateFromTimeZoneWallClock({
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
    hour: input.hour,
    minute: input.minute,
    timeZone,
  });
  if (!retryAt) return null;

  if (retryAt.getTime() <= input.now.getTime()) {
    const nextDay = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1, 0, 0, 0, 0));
    retryAt = dateFromTimeZoneWallClock({
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour: input.hour,
      minute: input.minute,
      timeZone,
    });
  }

  return retryAt;
}

/**
 * A reset more than a day out cannot be expressed by a clock alone, so Codex
 * interposes a date: `try again at Oct 3rd, 2026 10:00 AM`. Resolve the date
 * when it is present and fall back to the next occurrence of the bare clock.
 */
function datedClockTimeInTimeZone(input: {
  now: Date;
  year: number | null;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZoneHint: string;
}): Date | null {
  const timeZone = normalizeResetTimeZone(input.timeZoneHint);
  if (!timeZone) return null;

  const year = input.year ?? readTimeZoneParts(input.now, timeZone).year;
  const at = (resolvedYear: number) =>
    dateFromTimeZoneWallClock({
      year: resolvedYear,
      month: input.month,
      day: input.day,
      hour: input.hour,
      minute: input.minute,
      timeZone,
    });

  const retryAt = at(year);
  if (!retryAt) return null;
  // An explicit year is authoritative. Without one, a date already behind us
  // means the provider meant next year's occurrence.
  if (input.year === null && retryAt.getTime() <= input.now.getTime()) {
    return at(year + 1);
  }
  return retryAt;
}

const MONTH_PREFIXES = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
] as const;

const CODEX_RESET_CLOCK_RE =
  /^(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})?[\s,]+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?(?:\s*\(([^)]+)\)|\s+([A-Z]{2,5}))?$/i;

function parseLocalClockTime(clockText: string, now: Date): Date | null {
  const match = clockText.trim().match(CODEX_RESET_CLOCK_RE);
  if (!match) return null;

  const monthName = match[1]?.toLowerCase();
  const monthIndex = monthName
    ? MONTH_PREFIXES.findIndex((prefix) => monthName.startsWith(prefix))
    : -1;
  // A leading word that is not a month means this is not a reset clock at all.
  if (monthName && monthIndex < 0) return null;
  const day = match[2] ? Number.parseInt(match[2], 10) : null;
  if (day !== null && (!Number.isInteger(day) || day < 1 || day > 31)) return null;
  const year = match[3] ? Number.parseInt(match[3], 10) : null;

  const hour12 = Number.parseInt(match[4] ?? "", 10);
  const minute = Number.parseInt(match[5] ?? "0", 10);
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour24 = hour12 % 12;
  if ((match[6] ?? "").toLowerCase() === "p") hour24 += 12;

  const explicitDate =
    monthIndex >= 0 && day !== null ? { month: monthIndex + 1, day, year } : null;
  const timeZoneHint = match[7] ?? match[8];
  if (timeZoneHint) {
    const explicitRetryAt = explicitDate
      ? datedClockTimeInTimeZone({ now, ...explicitDate, hour: hour24, minute, timeZoneHint })
      : nextClockTimeInTimeZone({ now, hour: hour24, minute, timeZoneHint });
    if (explicitRetryAt) return explicitRetryAt;
  }

  if (explicitDate) {
    const resolvedYear = explicitDate.year ?? now.getFullYear();
    const retryAt = new Date(now);
    retryAt.setFullYear(resolvedYear, explicitDate.month - 1, explicitDate.day);
    retryAt.setHours(hour24, minute, 0, 0);
    if (explicitDate.year === null && retryAt.getTime() <= now.getTime()) {
      retryAt.setFullYear(resolvedYear + 1);
    }
    return retryAt;
  }

  const retryAt = new Date(now);
  retryAt.setHours(hour24, minute, 0, 0);
  if (retryAt.getTime() <= now.getTime()) {
    retryAt.setDate(retryAt.getDate() + 1);
  }
  return retryAt;
}

export function extractCodexRetryNotBefore(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}, now = new Date()): Date | null {
  const haystack = buildCodexErrorHaystack(input);
  // Keep the reset clause scoped to a real usage-limit message: on its own,
  // "try again at ..." also appears in transient upstream advice.
  if (!CODEX_USAGE_LIMIT_RE.test(haystack)) return null;
  const resetMatch = haystack.match(CODEX_USAGE_LIMIT_RESET_RE);
  if (!resetMatch) return null;
  return parseLocalClockTime(resetMatch[1] ?? "", now);
}

export function isCodexTransientUpstreamError(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const haystack = buildCodexErrorHaystack(input);

  if (isCodexProviderQuotaError(input)) return false;
  if (!CODEX_TRANSIENT_UPSTREAM_RE.test(haystack)) return false;
  // Keep automatic retries scoped to the observed remote-compaction/high-demand
  // failure shape.
  return CODEX_REMOTE_COMPACTION_RE.test(haystack) || /high\s+demand|temporary\s+errors/i.test(haystack);
}

export function isCodexProviderQuotaError(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const haystack = buildCodexErrorHaystack(input);
  return CODEX_PROVIDER_QUOTA_RE.test(haystack) || extractCodexRetryNotBefore(input) != null;
}
