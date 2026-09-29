/** Conservative until runtime credentials can prove disjoint provider accounts.
 * Never partition this pool by model, agent, issue, or caller-supplied wake data.
 * A company cannot inspect or alter another company's admission state.
 */
export const SHARED_PROVIDER_POOL = "company-runtime-accounts:v1";
export const AUTOMATED_ISSUE_DISPATCH_LIMIT = 4;
export const AUTOMATED_ISSUE_DISPATCH_WINDOW_MS = 60 * 60_000;

export function providerAdmissionEligibility(input: {
  now: Date;
  cooldownUntil: Date | null;
  automated: boolean;
  /** Actual durable dispatch reservations, not requested wake timestamps. */
  automatedDispatches: Date[];
}) {
  const now = input.now.getTime();
  if (!Number.isFinite(now)) throw new Error("Invalid admission clock");
  const window = input.automatedDispatches
    .map((date) => date.getTime())
    .filter((time) => Number.isFinite(time) && time > now - AUTOMATED_ISSUE_DISPATCH_WINDOW_MS)
    .sort((a, b) => b - a);
  const capUntil = input.automated && window.length >= AUTOMATED_ISSUE_DISPATCH_LIMIT
    ? window[AUTOMATED_ISSUE_DISPATCH_LIMIT - 1]! + AUTOMATED_ISSUE_DISPATCH_WINDOW_MS
    : now;
  const cooldownUntil = input.cooldownUntil?.getTime() ?? now;
  // No manual wake or per-issue cap can shorten a provider deadline.
  const eligibleAt = new Date(Math.max(now, cooldownUntil, capUntil));
  return {
    eligible: eligibleAt.getTime() === now,
    eligibleAt,
    reasons: [
      ...(cooldownUntil > now ? ["provider_cooldown" as const] : []),
      ...(capUntil > now ? ["issue_dispatch_cap" as const] : []),
    ],
  };
}
