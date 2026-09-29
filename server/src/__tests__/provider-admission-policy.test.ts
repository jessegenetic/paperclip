import { describe, expect, it } from "vitest";
import { providerAdmissionEligibility } from "../services/provider-admission-policy.js";

const now = new Date("2030-01-01T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
describe("provider admission eligibility", () => {
  it("allows the first four automated dispatches, then waits for the oldest to leave the rolling window", () => {
    const automatedDispatches = [minutesAgo(50), minutesAgo(40), minutesAgo(30), minutesAgo(20)];
    expect(providerAdmissionEligibility({ now, cooldownUntil: null, automated: true,
      automatedDispatches: automatedDispatches.slice(0, 3) }).eligible).toBe(true);
    expect(providerAdmissionEligibility({ now, cooldownUntil: null, automated: true, automatedDispatches }))
      .toEqual({ eligible: false, eligibleAt: new Date("2030-01-01T12:10:00Z"), reasons: ["issue_dispatch_cap"] });
  });
  it("releases the cap exactly at the rolling boundary", () => {
    expect(providerAdmissionEligibility({ now, cooldownUntil: null, automated: true,
      automatedDispatches: [minutesAgo(60), minutesAgo(40), minutesAgo(30), minutesAgo(20)] }).eligible).toBe(true);
  });
  it("uses the fourth newest dispatch when historical counts already exceed the cap", () => {
    expect(providerAdmissionEligibility({ now, cooldownUntil: null, automated: true,
      automatedDispatches: [59, 58, 50, 40, 30, 20].map(minutesAgo) }).eligibleAt)
      .toEqual(new Date("2030-01-01T12:10:00Z"));
  });
  it.each([true, false])("never shortens a multi-day cooldown (automated=%s)", (automated) => {
    const cooldownUntil = new Date("2030-01-05T12:00:00Z");
    expect(providerAdmissionEligibility({ now, cooldownUntil, automated,
      automatedDispatches: [50, 40, 30, 20].map(minutesAgo) }).eligibleAt).toEqual(cooldownUntil);
  });
  it("does not treat a human message as an automated dispatch", () => {
    expect(providerAdmissionEligibility({ now, cooldownUntil: null, automated: false,
      automatedDispatches: [50, 40, 30, 20].map(minutesAgo) }).eligible).toBe(true);
  });
  it("keeps the cap when it expires later than the cooldown", () => {
    expect(providerAdmissionEligibility({ now, cooldownUntil: new Date(now.getTime() + 1000), automated: true,
      automatedDispatches: [50, 40, 30, 20].map(minutesAgo) }).reasons)
      .toEqual(["provider_cooldown", "issue_dispatch_cap"]);
  });
});
