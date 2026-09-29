# Provider retries and repeated wake context

Provider quota and transient upstream failures use a separate retry policy from
local infrastructure failures. The provider policy starts at five minutes and
doubles with the persisted failure attempt. Jitter is ±20%. The jittered local
delay is capped at one hour. A provider reset deadline remains a floor even when
it is days beyond the local cap. A shorter caller delay cannot bypass this policy.

The existing automatic retry budget remains two retries. This change does not
increase that budget. The one-hour delay cap also applies if a caller supplies a
larger finite attempt budget. Infrastructure retries retain their existing
schedule because a local setup wait need not consume provider capacity.

`server/src/services/provider-retry-policy.ts` holds the policy constants. The
heartbeat scheduler stores the sampled deadline and attempt in the scheduled
run. Its existing predecessor transaction reuses the same successor on duplicate
scheduling and restart; it does not draw a new effective deadline.

Wake rendering can remove a duplicated objective when the server marks its
source as the issue description and the adapter confirms that its prompt already
contains the full task description. The full description remains in the task
section. Human-comment objectives, legacy envelopes without provenance, and
prompts without that full-task guarantee retain their objective. Decisions,
questions, message authors, trust metadata, and cursor coverage are untouched.

## Qualification boundary

This increment does not implement shared provider/account cooldowns, a rolling
per-issue dispatch cap, or a global bounded context envelope. It does not make a
new wake share another issue's retry budget. Those controls need transactional
admission tests across direct, scheduled, comment, native, and restart paths.
The proposed automated dispatch cap is four per issue per rolling hour; it must
never bypass a provider deadline. Human direction must remain durably queued.

An owner burn report must distinguish admission from provider execution, show
missing usage coverage, and keep cached input as a subset when input totals
already include it. Zero estimated dollars does not establish zero subscription
credit consumption. Subscription credits remain unknown without provider data.

No runtime adoption follows from a passing test. Landing and operator adoption
require separate review and the deployment's explicit approval gate.
