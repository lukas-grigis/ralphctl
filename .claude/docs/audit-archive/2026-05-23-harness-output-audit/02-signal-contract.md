# 02 — Signal contract: namespaces and file-based AI output

**Status:** decided-change → see [09](09-ai-session-contract.md) for the implementation contract (2026-05-22)
**Related:
** [01 logs dir](01-logs-directory-layout.md), [07 progress vs chain.log](07-progress-vs-chain-log.md), [09 AI session contract](09-ai-session-contract.md)

## Resolved direction

### Two signal namespaces, one bus

The codebase mixes "signal" terminology between two distinct concepts. We are formalizing the separation:

| Namespace        | Producer          | Validation                                                | Crosses file boundary?                    |
| ---------------- | ----------------- | --------------------------------------------------------- | ----------------------------------------- |
| `AiSignal`       | AI session        | **Zod schema** (per-leaf composition from shared schemas) | Yes — written to `signals.json` by the AI |
| `FrameworkEvent` | Harness internals | None (typed at the source)                                | No — bus-internal only                    |

`AppEvent` (today's bus union) stays as `FrameworkEvent | { type: 'ai-signal', signal: AiSignal, source }`. TUI
subscribes to `AppEvent` and branches on `type` — no separate paths.

`AiSignal` kinds in the **target** taxonomy (defined authoritatively in [09](09-ai-session-contract.md)): `change`,
`decision`, `learning`, `note`, `task-verified`, `task-complete`, `task-blocked`, `evaluation`, `progress-entry`,
`commit-message`, `refined-ticket`, `task-plan`, `ideated-tickets`, `setup-skill-proposal`, `verify-skill-proposal`,
`agents-md-proposal`, `skill-suggestions`, `context-compacted`.

Dropped from today's `HarnessSignal` taxonomy in the target: `progress` (replaced by `progress-entry`), `setup-script`,
`verify-script` (these were structural pre-amble signals; the new contract uses dedicated sidecar files for skill /
agents-md proposals instead).

Rename: `HarnessSignal` → `AiSignal` for clearer source attribution. The "harness" perspective was producer-agnostic;
the new name makes the origin obvious.

### AI session I/O — file-based both directions

| Direction    | Carrier                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness → AI | Rendered `prompt.md` (template + substitution, saved to disk under `rounds/<N>/<role>/prompt.md`)                                                                                                                                                                                                                                              |
| AI → Harness | **`signals.json` — exactly one file, always, every flow.** Zod-validated discriminated union of `AiSignal` kinds the leaf accepts. The harness then renders operator-readable sidecars (`evaluation.md`, `commit-message.txt`, `setup-skill.md`, …) from the validated signals via a per-leaf render map. See [09](09-ai-session-contract.md). |

The AI writes its output files directly via its `Write` tool. The harness does **not** parse the AI's stdout for
signals. See [09](09-ai-session-contract.md) for the per-leaf file declarations and validation.

### Stream parsing — trashed

- `parseHarnessSignals(body)` (regex over accumulated stdout body) is removed.
- The stream parser in `src/integration/ai/providers/claude/headless.ts:284` still reads stdout to know **when** the AI
  exits, but no longer parses content out of it.
- No "raw AI stdout body" persistence ([01](01-logs-directory-layout.md) decision). The validated `signals.json` is the
  canonical record.

### Sink — kept as a bus publisher, removed as a file writer

- **Kept:** the in-memory bus publisher. After the leaf reads + validates the AI's output files, each `AiSignal` is
  wrapped in an `AppEvent` and published to the bus. TUI subscribes and renders live. The settle-attempt leaf separately
  appends a journal section to `progress.md` from the same validated signals — see [07](07-progress-vs-chain-log.md) for
  the append-only journal model.
- **Removed:** every persistent file sink driven by signal emission.
  - `decisions-log-sink.ts` → deleted ([07](07-progress-vs-chain-log.md)).
  - `file-log-sink.ts` → opt-in only via `RALPHCTL_DEBUG_TRACE=1` ([07](07-progress-vs-chain-log.md)).
- The TUI receives signals **only from the bus**. No separate stream parse, no duplicate event source.

## Why this is better

1. **One source of truth for signals.** The validated `signals.json` is canonical. Bus events are live broadcasts of it;
   `progress.md` sections are the journalled record of it.
2. **Type-clean boundary.** AiSignal is Zod-validated, every leaf composes its schema; FrameworkEvent is internal. The
   two never confuse each other.
3. **Uniform AI contract.** Every spawn writes exactly one file — `signals.json`. No multi-file races, no manifest
   cross-validation, no "did the AI remember to write the second file?" failure mode. The AI's job is the same shape in
   every flow.
4. **Operator readability via harness rendering.** Signal bodies live in the AI's output JSON (escapes and all), but the
   harness immediately extracts them into bare files — `cat evaluation.md` is clean prose; `cat commit-message.txt` is
   ready for `git commit -F`. Operators never need to read `signals.json` directly.
5. **TUI cannot drift from canon.** One subscription, one event type, one signal definition.

## What remains open (tracked in [09])

- Concrete per-leaf file declarations (which files, which schemas).
- File-presence atomicity: how the leaf checks all required files exist after spawn exit (single check vs short-retry on
  filesystem race).
- Schema-version policy per leaf.

---

## Historical context (preserved)

The sections below capture the state of the signal pipeline before the
[09](09-ai-session-contract.md) decision. Kept for reference; not load-bearing
for the new direction.

### Current (pre-migration) contract

1. AI emits XML tags in stdout: `<change>...</change>`, `<decision>...</decision>`, etc.
2. Provider adapter (`src/integration/ai/providers/claude/headless.ts:298–326`) accumulates the result body in memory.
3. `parseHarnessSignals(body, now())` regex-scans the body once after child exit.
4. Provider atomically writes the parsed array to `signalsFile` (caller-supplied path).
5. Leaf reads the file, forwards each signal to the broadcast sink, passes the array to the use case.

### Pre-existing confusions

1. "File-based contract" overstated — harness _does_ parse stdout, just in-process. Resolved
   by [09](09-ai-session-contract.md): AI writes directly.
2. One file packing heterogeneous shapes — resolved by the uniform single-file contract; the harness renders prose
   sidecars from validated signal bodies, so operators see clean per-artifact files without the AI writing them.
3. Stream thrown away after parse — resolved by trashing the stream parser entirely.
4. Dual signal events on the bus (`HarnessSignalEvent` for change/learning/note; `decisions-log-sink` for decision) —
   resolved by the unified `AppEvent` bus + deletion of decisions-log-sink.

### Pre-existing evidence

- `src/integration/ai/providers/claude/headless.ts:273–410`
- `src/integration/ai/signals/_engine/parse-signals.ts` (deletion candidate)
- `src/integration/ai/signals/_engine/read-signals-file.ts`
- `src/business/observability/events.ts:229–252`
- `src/integration/observability/sinks/decisions-log-sink.ts` (deletion candidate)
