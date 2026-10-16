---
name: ralphctl-observability-and-instrumentation
description: Instrument code so its production behaviour can be diagnosed from the outside — start from the questions an operator will ask, then emit structured events with stable names, a correlation id, and an entry-point field, bounded-cardinality metrics with latency percentiles, traces across async boundaries, and symptom-based alerts, never secrets or personal data. Use when adding I/O, retries, queues, background jobs, external integrations, or endpoints, or when a reported problem could not be diagnosed from existing telemetry.
license: MIT
---

# Observability and Instrumentation

> Adapted from [addyosmani/agent-skills — "Observability and Instrumentation"](https://github.com/addyosmani/agent-skills)
> (MIT). Adapted for ralphctl's harness contract.

Code you cannot observe is code you cannot operate. Instrumentation is written with the feature, the way
tests are — when it ships without telemetry, the first reported bug becomes archaeology instead of a
query.

**Not for:** diagnosing a failure happening now (ralphctl-debugging-and-error-recovery when installed),
or optimising measured slowness (ralphctl-performance-optimization when installed).

## When this applies

- **Plan** — for tasks that add I/O, retries, queues, jobs, or integrations, put the telemetry in the
  task's steps and add a verification criterion that the failure path is observable. Name the operator
  questions it must answer.
- **Execute** — instrument as you build, with the logging, metrics, and tracing libraries the project
  already uses. Adding a new telemetry stack is a decision for the task to make, not a side effect.

## 1. Define "working" first

Telemetry without a question is noise. Before instrumenting, write down two to four questions an operator
will ask about this feature — what fraction succeeds first time, why permanent failures fail, whether a
dependency is slower than usual. Every signal you add must help answer one of them.

## 2. Pick the signal per question

| Signal         | Answers                                  | Cost                          |
| -------------- | ---------------------------------------- | ----------------------------- |
| Structured log | What happened in this specific case?     | Per event; grows with traffic |
| Metric         | How often, how fast, in aggregate?       | Fixed per series; cheap       |
| Trace          | Where did the time go across components? | Per request; usually sampled  |

Metrics tell you _that_ something is wrong, traces tell you _where_, logs tell you _why_.

## 3. Structured logging

- **Events, not prose.** A stable event name plus machine-readable fields — never a sentence built by
  string interpolation that nobody can query.
- **Levels used consistently** — error: an invariant broke and someone may need to act; warn: degraded
  but handled (a retry succeeded, a fallback ran); info: a significant business event; debug: diagnostic
  detail, off in production by default.
- **A correlation id on everything.** Accept or create one at the system boundary and attach it to every
  log line, span, and outbound call, so one request can be reconstructed from interleaved output.
- **Name the entry point** when several entry points (a scheduler, a replay endpoint, a manual run) feed
  one log. Set it where the run starts and propagate it with the correlation id across the same
  boundaries — queue metadata, headers — rather than re-deriving it downstream.
- **Never log secrets, tokens, passwords, or full personal data.** Log an allowlist of fields, never a
  whole request body.

## 4. Metrics

Instrument rate, errors, and duration for every request-driven endpoint and every external dependency;
utilisation, saturation, and errors for resources such as pools and queues. Labels come from small fixed
sets (route template, status class, dependency name) — never user ids, raw URLs, or message text, which
explode the number of series and belong in logs and traces. Record latency as a histogram and read
percentiles; an average hides the slowest users.

## 5. Tracing

Prefer a vendor-neutral standard such as OpenTelemetry when choosing, and the project's existing setup
when there is one. Use auto-instrumentation where the stack offers it; add manual spans only around
meaningful units of work, with the attributes an operator will filter by. Propagate context across every
async boundary or the trace dies at the gap.

## 6. Alerting

Alert on symptoms users feel (error rate, latency, queue age), not causes (CPU, one restart). Every alert
is actionable, has a threshold and duration justified by an objective or by history, and uses one of two
severities: act now, or act this week. When the project keeps runbooks, link each new alert to one; do
not create a runbook location the task did not ask for.

## 7. Verify the telemetry itself

Instrumentation is code and can be wrong. Exercise the failure path in a test and assert the emitted
event and its fields — the project's logger or metrics library usually offers a capture or in-memory
sink. Checks that need a live environment (a dashboard, a tracing UI, firing an alert) cannot happen in
this session: list them as unverified in a `note` signal when the prompt's output-contract section lists
it; otherwise fold them into the required signal's own fields.

## Red flags

- A change adding retries, queues, or external calls with no new telemetry.
- Log lines built by interpolation instead of structured fields.
- No correlation id, or one shared log fed by several entry points with nothing naming which.
- Metric labels carrying user ids, raw URLs, or error text.
- Latency tracked only as an average.
- Secrets, tokens, or whole request bodies in log output.

## Self-check

- [ ] The operator questions are named, and each signal maps to one.
- [ ] Log output is structured, with stable event names and a correlation id.
- [ ] No secret or unredacted personal data reaches any log line.
- [ ] New endpoints and dependencies have rate, error, and duration metrics with bounded labels.
- [ ] Latency is a histogram with queryable percentiles.
- [ ] The failure path's telemetry is asserted in a test, or listed as unverified.
