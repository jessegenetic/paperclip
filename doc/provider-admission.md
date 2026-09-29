# Durable provider admission (implementation in progress)

This increment adds a database-backed admission service and tests. It is not yet
connected to heartbeat dispatch. It does not currently block runtime provider
calls. Do not adopt this draft as a complete burn-control fix.

## Admission contract

`providerAdmissionService.reserve(companyId, runId, now)` serializes decisions
under one company pool row. It verifies the run, agent, issue and wake company
boundaries. It returns `admitted`, `deferred`, `duplicate`, or `stale`.

The initial default permits four automated dispatch reservations per issue in a
rolling hour. The window is `(now - one hour, now]`. Existing future timestamps
count conservatively after a clock correction. A reservation consumes a slot
even if a later startup failure prevents provider work. It is not proof of a
provider call or token consumption.

The exemption for human dispatches comes from the persisted wake actor type,
not the wake JSON, reason, or invocation source. Human dispatches still obey
the shared cooldown. The service does not modify user messages or wake payloads.

Account isolation is not yet proven across host credentials, managed grants,
native sessions and adapter overrides. The initial pool therefore covers all
runtime accounts within a company. This can delay an unrelated provider. It
cannot be split by an agent, model, issue, or wake payload. Separate companies
have separate state. Cross-company account coordination is not implemented.

`settle` records one outcome per admitted run under the same pool lock. Provider
failures increment a durable consecutive failure counter. Backoff starts at
five minutes, doubles with ±20% jitter, and caps locally at one hour. Provider
reset and Retry-After deadlines supplied as `retryNotBefore` remain floors.
An existing later deadline is never shortened. Replaying settlement after a
restart does not extend a deadline or increment the counter again. A success
does not clear a cooldown that is still in the future.

## Local burn-report data contract

These tables hold local instance data, not outbound telemetry. Every read must
filter by the authenticated company. Join receipts to heartbeat runs by both
`company_id` and `run_id`.

| Field | Meaning |
| --- | --- |
| `provider_admission_pools.cooldown_until` | Shared provider deadline; nullable when no failure is known |
| `provider_dispatch_receipts.admitted_at` | Reservation time; null means no dispatch was admitted |
| `eligible_at` | Eligibility computed at the latest check; a later pool failure can extend it |
| `suppression_count` | Number of deferred checks of this run, not number of distinct user messages |
| `suppression_reason` | `provider_cooldown`, `issue_dispatch_cap`, or both |
| `automated` | Derived from persisted wake actor authority |
| `outcome`, `settled_at` | Settled result; null means unavailable or unsettled |

Do not label reservations as confirmed provider calls. Runtime wiring must
record attempts/outcomes and preserve the distinction between startup failure,
provider execution and unavailable execution evidence.

Token reporting continues to use heartbeat usage records. A missing record is
unavailable, not zero. Cached input is a subset of inclusive input and must not
be added a second time. Dollar estimates are a separate metric. Subscription
credits remain unknown unless directly observed. Owner-reported aggregate
ranges are not independently verified by these receipts.

## Remaining runtime work

- Integrate checks at dispatch for legacy, native, direct, scheduled and restart
  paths. Resolve trusted credential identity before considering finer pools.
- Atomically park deferred runs and reuse their eligible resume. Preserve queued
  human directions and existing issue coalescing. Timers must not launch LLMs
  to check eligibility.
- Keep native reattachment distinct from new provider work. A reservation alone
  cannot prove whether a process started before a crash. Retain existing
  ownership/reconciliation guards; never replay uncertain provider work.
- Persist failure cooldown before another dispatch can pass admission. Cover
  the terminal-result/restart boundary, including exhausted retry budgets.
- Add bounded delta context and measure complete rendered prompt bytes/chars;
  report token counts only when measured with the actual tokenizer or provider.
- Add runtime path regressions and independent review before adoption approval.
