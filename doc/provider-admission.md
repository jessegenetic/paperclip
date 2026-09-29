# Durable provider admission (implementation in progress)

The draft includes a database-backed admission service, queued-run preflight,
a scheduler promotion floor, and final legacy adapter admission. Legacy results
persist shared provider cooldowns before terminal publication or issue release.
Native provider-turn admission and settlement are still unfinished.
The shared dispatch wrapper uses the selected runtime mode, because a fresh
native selection changes the database row after the initial run snapshot was
loaded. The legacy controller check must not suppress this native handoff.
Queued preflight still defers fresh native wakes during a known shared cooldown. Do not adopt
this draft as a complete burn-control fix.

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

## Durable queued-run deferral

`reserve(companyId, runId, now, { parkDeniedRun: true })` is for a queued run
before runtime ownership is claimed. A denial commits the receipt and changes
that same run to `scheduled_retry` in one transaction. Its deadline is the later
of the shared cooldown and rolling cap. The wake, context, retry reason and
attempt count remain intact. This mode refuses running rows; it must never
park an active process or remove its ownership evidence.

`resumeDeferred(companyId, runId, now)` is a deterministic timer operation.
It rechecks the durable receipt, shared floor and rolling window under the pool
lock. Later failures extend the stored deadline. Repeated early timer checks do
not add suppressions or provider attempts. At eligibility, one concurrent caller
changes the same run to `queued`; the other callers observe a stale request.
Cancellation and company boundaries remain effective.

Queueing does not grant provider permission. Runtime integration must apply its
normal pause, budget, assignment, ownership and dependency gates, then reserve
again at the dispatch boundary. Another failure or dispatch can make a queued
run ineligible after the timer check. The runtime scheduler uses its existing issue/run transaction and policy gates
plus `deferredProviderEligibility` to check the saved floor. This read does not
take a pool lock inside the issue/run locks, avoiding inversion of admission's
pool/run lock order. A concurrent failure can extend the floor after the read;
the queued preflight checks again. Distinct wake coalescing still needs integration.

`reserve(..., { checkOnly: true, parkDeniedRun: true })` is the queued preflight.
It parks denials atomically, but eligible checks create no receipt and consume no
slot. `claimQueuedRun` uses this after its existing scheduling gates. This is
only an early resource-saving check. The final provider handoff must reserve
again, including native replacements; active native reattachment is a separate
ownership operation.

## Legacy provider entry

`reserve(..., { legacyDispatchOwner })` admits the owning legacy controller after
workspace and credential preparation. It rejects expired/wrong ownership, native
rows and process markers. A denial atomically parks the same run and returns its
wake to queued, retaining input and issue ownership. The executor then releases
preparation resources and leaves the agent idle. No retry attempt is consumed.
The normal issue/interaction dispatch gate still applies after reservation.
Reservation happens outside that gate to preserve pool/run lock ordering.

Structured legacy results settle before workspace finalization, terminal run
publication and issue release. Provider quota and transient-upstream results
set a cooldown even when no automatic retry budget remains. Thrown adapter
errors without a structured deadline record a failure without inventing quota
classification. A late settlement is idempotent. A crash before result storage
remains an unresolved recovery boundary; this patch does not claim durable
native result replay or atomic provider-start evidence.

## Local burn-report data contract

These tables hold local instance data, not outbound telemetry. Every read must
filter by the authenticated company. Join receipts to heartbeat runs by both
`company_id` and `run_id`.

| Field | Meaning |
| --- | --- |
| `provider_admission_pools.cooldown_until` | Shared provider deadline; nullable when no failure is known |
| `provider_dispatch_receipts.admitted_at` | Reservation time; null means no dispatch was admitted |
| `eligible_at` | Eligibility computed at the latest check; a later pool failure can extend it |
| `suppression_count` | Number of denied reservation checks; excludes timer observations and is not a count of distinct user messages |
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

- Complete native dispatch/restart checks and all-path regression coverage. Resolve trusted credential identity before considering finer pools.
- Complete native deferral and distinct-wake coalescing. Queued preflight,
  scheduled promotion and legacy post-preparation checks are wired. Timers must not launch LLMs to check eligibility.
- Keep native reattachment distinct from new provider work. A reservation alone
  cannot prove whether a process started before a crash. Retain existing
  ownership/reconciliation guards; never replay uncertain provider work.
- Persist failure cooldown before another dispatch can pass admission. Cover
  the terminal-result/restart boundary, including exhausted retry budgets.
- Add bounded delta context and measure complete rendered prompt bytes/chars;
  report token counts only when measured with the actual tokenizer or provider.
- Add runtime path regressions and independent review before adoption approval.

## Native integration boundary found during regression review

The current receipt key is one run. Native execution can resume the same run,
reattach an active turn, or start a new turn on a retained session. These are not
equivalent dispatches. Before wiring native entry, define durable attempt/turn
identity so a reattachment does not spend another slot and a new turn cannot
reuse an old reservation. Do not allow `duplicate` receipts to authorize replay.

`native-session-executor.ts` claims its coordinator before calling the runner's
`onSessionAdmission` hook. That hook runs before both fresh sessions and retained
session attachment. It is not by itself evidence of a new provider turn. Native
coordinator claims use coordinator-before-run locking; admission must preserve
that order beneath the shared pool lock. Failure persistence must occur before
the native executor publishes retryable/terminal state, including exceptions
which never return an adapter result. Known reset parsing must retain its floor.
