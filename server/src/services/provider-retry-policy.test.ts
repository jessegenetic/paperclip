import { afterEach, describe, expect, it, vi } from "vitest";
import { computeProviderRetrySchedule, PROVIDER_RETRY_MAX_DELAY_MS } from "./provider-retry-policy.js";

describe("provider backoff", () => {
  afterEach(() => vi.useRealTimers());
  const now = new Date("2026-09-29T12:00:00Z");
  const schedule = (attempt: number, random = 0.5, retryNotBefore?: Date) =>
    computeProviderRetrySchedule({ attempt, maxAttempts: 20, now: new Date(), random: () => random, retryNotBefore });

  it("doubles persisted attempts and caps the jittered delay", () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    expect([1, 2, 3, 4, 5, 20].map(attempt => schedule(attempt)!.delayMs))
      .toEqual([300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000]);
    expect(schedule(20, 1)!.delayMs).toBe(PROVIDER_RETRY_MAX_DELAY_MS);
  });

  it("has bounded jitter and cannot fall into a one-minute blind retry", () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    expect(schedule(1, 0)!.delayMs).toBe(240_000);
    expect(schedule(1, 1)!.delayMs).toBe(360_000);
    expect(schedule(1, NaN)!.delayMs).toBe(300_000);
  });

  it("uses a multi-day reset as a floor beyond the cap", () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const reset = new Date("2026-10-03T17:00:00Z");
    for (const jitter of [0, 0.5, 1]) expect(schedule(1, jitter, reset)!.dueAt).toEqual(reset);
    expect(schedule(2, 0, new Date(now.getTime() + 10_000))!.delayMs).toBe(480_000);
  });

  it("reconstructs the same deadline from durable inputs after restart", () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const saved = JSON.stringify({ attempt: 2, now: now.toISOString(), sample: 0.25 });
    const first = schedule(2, 0.25);
    vi.advanceTimersByTime(60_000);
    const state = JSON.parse(saved);
    expect(computeProviderRetrySchedule({ attempt: state.attempt, now: new Date(state.now), random: () => state.sample, maxAttempts: 2 }))
      .toEqual({ ...first, maxAttempts: 2 });
  });

  it("preserves the finite retry budget", () => {
    for (const attempt of [0, -1, 1.5, NaN, Infinity, 3]) {
      expect(computeProviderRetrySchedule({ attempt, maxAttempts: 2, now })).toBeNull();
    }
  });
});
