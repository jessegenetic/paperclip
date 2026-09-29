/** Provider failures must not inherit the short infrastructure retry delay. */
export const PROVIDER_RETRY_BASE_DELAY_MS = 5 * 60_000;
export const PROVIDER_RETRY_MAX_DELAY_MS = 60 * 60_000;
export const PROVIDER_RETRY_JITTER_RATIO = 0.2;

export function computeProviderRetrySchedule(input: {
  /** Persisted failure attempt, never a process-local counter. */
  attempt: number;
  maxAttempts: number;
  now: Date;
  retryNotBefore?: Date | null;
  random?: () => number;
}) {
  const { attempt, maxAttempts, now } = input;
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > maxAttempts) return null;
  const baseDelayMs = Math.min(
    PROVIDER_RETRY_MAX_DELAY_MS,
    PROVIDER_RETRY_BASE_DELAY_MS * 2 ** Math.min(attempt - 1, 20),
  );
  const sample = (input.random ?? Math.random)();
  const boundedSample = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  const jitteredDelayMs = Math.min(PROVIDER_RETRY_MAX_DELAY_MS, Math.round(
    baseDelayMs * (1 + (boundedSample * 2 - 1) * PROVIDER_RETRY_JITTER_RATIO),
  ));
  const resetMs = input.retryNotBefore?.getTime();
  // The local cap applies to backoff only. A provider deadline is a floor,
  // even when it lies days beyond that cap.
  const dueAtMs = Math.max(now.getTime() + jitteredDelayMs,
    resetMs != null && Number.isFinite(resetMs) ? resetMs : 0);
  return {
    attempt,
    baseDelayMs,
    delayMs: dueAtMs - now.getTime(),
    dueAt: new Date(dueAtMs),
    maxAttempts,
  };
}
