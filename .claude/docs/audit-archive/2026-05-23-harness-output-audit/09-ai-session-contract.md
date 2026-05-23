# 09 — AI session contract: AI writes `signals.json`; harness renders sidecars

**Status:** open
**Scope:** every AI spawn — refine, plan, ideate, generator, evaluator, readiness, future flows
**Related:
** [02 signal contract](02-signal-contract.md), [10 leaf tests](10-leaf-tests-mock-ai.md), [11 prompt unit tests](11-prompt-template-unit-tests.md)

## The contract in one paragraph

Every AI spawn writes **exactly one file: `signals.json`**. The file is a Zod-validated discriminated union of`AiSignal`
kinds the leaf accepts. After the spawn exits, the leaf parses and validates the file; on success, it walks a per-leaf \*
\*sidecar render map\*\* and writes operator-readable files (`evaluation.md`, `commit-message.txt`,`setup-skill.md`, …) by
extracting bodies from validated signals. The AI's job is uniform across every flow. The harness owns all on-disk prose.

## The model

```
AI session
   │
   ▼
signals.json   ← AI's only output. Always.
   │
   ▼
validate (Zod) ─── fail → Result.error(InvalidStateError)
   │
   ▼ success
publish each AiSignal to the in-memory bus  ── TUI renders live
   │
   ▼
walk leaf's sidecar map:
   for each (signalKind, filename, extract) in contract.sidecars:
     for each signal of that kind in the validated array:
       writeTextAtomic(<outputDir>/<filename>, extract(signal))
   │
   ▼
Result.ok({ signals, sidecarPaths })
```

The render step is mechanically simple: find the signal by kind, run `extract(signal)`, write the result. No parsing, no
escape gymnastics. Bodies round-trip from validated JSON to disk byte-for-byte (or via a structured renderer for signals
that carry fields rather than a single body string — `evaluation` is the only such case today).

## Signal namespaces (recap from [02](02-signal-contract.md))

- **`AiSignal`** (Zod-validated, AI-written inside `signals.json`): the discriminated union of every signal kind the
  harness understands. Each leaf composes a sub-union of kinds it accepts.
- **`FrameworkEvent`** (no Zod, harness-internal): bus traffic for chain lifecycle, banners, logs.
- **`AppEvent = FrameworkEvent | { type: 'ai-signal', signal: AiSignal, source }`** — single bus union.

## Signal kinds (working taxonomy)

Every signal carries enough body to be self-sufficient. Signals that the harness renders to disk carry the full content
as fields on the signal itself.

**Where they live (target):**

- **TypeScript types** → `src/domain/signal.ts` (renamed from today's `HarnessSignal` union). Pure TS, no Zod imports.
- **Zod schemas** → `src/integration/ai/contract/_engine/signals/<kind>/schema.ts` (one schema per signal kind).
  Integration owns runtime validation.

The validator at the integration boundary (`validate-signals-file.ts`) parses bytes → returns domain-typed `AiSignal[]`.

```ts
// src/domain/signal.ts (TS types only)

// lightweight narrative — short bodies, never rendered to a sidecar file
type ChangeSignal = { type: 'change'; text: string; timestamp: IsoTimestamp };
type LearningSignal = { type: 'learning'; text: string; timestamp: IsoTimestamp };
type NoteSignal = { type: 'note'; text: string; timestamp: IsoTimestamp };
type DecisionSignal = { type: 'decision'; text: string; timestamp: IsoTimestamp };
type ProgressEntry = { type: 'progress-entry'; sections: { ... }; timestamp: IsoTimestamp };

// task lifecycle markers — never rendered to a sidecar file
type TaskVerifiedSignal = { type: 'task-verified'; taskId: TaskId; timestamp: IsoTimestamp };
type TaskCompleteSignal = { type: 'task-complete'; taskId: TaskId; commitSha?: string; timestamp: IsoTimestamp };
type TaskBlockedSignal = { type: 'task-blocked'; taskId: TaskId; reason: string; timestamp: IsoTimestamp };

// content-bearing signals — harness renders each to a sidecar file
type CommitMessageSignal = {
    type: 'commit-message';
    subject: string;             // conventional-commits format: `<type>(<scope>): <summary>` — single line, no trailing newline
    body?: string;                // optional multi-paragraph explanation; may include bullet lists, code fences, footers (Fixes:, Co-authored-by:, …)
    timestamp: IsoTimestamp;
};
type EvaluationSignal = {
    type: 'evaluation';
    verdict: 'pass' | 'blocked';
    dimensions: { name: string; score: number; critique: string }[];
    critique: string;           // overall critique prose
    timestamp: IsoTimestamp;
};
type RefinedTicketSignal = { type: 'refined-ticket'; ticket: RefinedTicket; timestamp: IsoTimestamp };
type TaskPlanSignal = { type: 'task-plan'; tasks: PlannedTask[]; timestamp: IsoTimestamp };
type IdeatedTicketsSignal = { type: 'ideated-tickets'; tickets: IdeatedTicket[]; timestamp: IsoTimestamp };
type AgentsMdProposalSignal = { type: 'agents-md-proposal'; body: string; summary: string; timestamp: IsoTimestamp };
type SetupSkillProposalSignal = {
    type: 'setup-skill-proposal';
    body: string;
    summary: string;
    timestamp: IsoTimestamp
};
type VerifySkillProposalSignal = {
    type: 'verify-skill-proposal';
    body: string;
    summary: string;
    timestamp: IsoTimestamp
};

// recommendations the harness consumes but doesn't render to a sidecar
type SkillSuggestionsSignal = { type: 'skill-suggestions'; names: string[]; timestamp: IsoTimestamp };

// context-window compaction marker (carried over from today's HarnessSignal taxonomy)
type ContextCompactedSignal = { type: 'context-compacted'; timestamp: IsoTimestamp };

export type AiSignal = ChangeSignal | LearningSignal | NoteSignal | DecisionSignal | ProgressEntry
    | TaskVerifiedSignal | TaskCompleteSignal | TaskBlockedSignal
    | CommitMessageSignal | EvaluationSignal | RefinedTicketSignal | TaskPlanSignal | IdeatedTicketsSignal
    | AgentsMdProposalSignal | SetupSkillProposalSignal | VerifySkillProposalSignal
    | SkillSuggestionsSignal | ContextCompactedSignal;
```

## The per-leaf contract shape

**Module placement (target):** all the per-leaf-contract plumbing lives under `src/integration/ai/contract/_engine/` (
per the existing sibling-isolation rule that port-shaped helpers go in `_engine/`):

```
src/integration/ai/contract/_engine/
  types.ts                          # FileSpec, SidecarRule, AiOutputContract
  validate-signals-file.ts          # reads + Zod-parses signals.json
  render-sidecars.ts                # writes sidecar files; takes WriteFile port as dep
  render-contract-section.ts        # prompt-side example renderer
  render-evaluation-markdown.ts     # one structured-to-markdown render today
  signals/<kind>/schema.ts          # Zod schema per AiSignal kind
```

Per-leaf `<leaf>.contract.ts` files colocate with the leaf source under `src/application/flows/<flow>/leaves/`. They
compose contracts from the `_engine/` building blocks but never reach into `signals/<kind>/` directly (enforced by a new
chains-layer fence — see "ESLint fences" below).

```ts
// src/integration/ai/contract/_engine/types.ts (proposed)
export interface SidecarRule<TSig extends AiSignal = AiSignal> {
  readonly signalKind: TSig['type'];
  readonly filename: string; // resolved relative to the spawn's output dir
  readonly extract: (signal: TSig) => string; // produces the file body from the validated signal
  readonly multiplicity: 'one' | 'optional' | 'any';
  // 'one'      → exactly one signal of this kind must exist (schema enforces);
  // 'optional' → at most one (no file if absent);
  // 'any'      → render every occurrence (rare; not used today).
}

export interface AiOutputContract {
  readonly schemaVersion: number;
  readonly signalsSchema: z.ZodSchema<AiSignal[]>;
  readonly sidecars: readonly SidecarRule[];
  /**
   * Migration chain. Runs at validator load time when an on-disk `signals.json`
   * declares a `schemaVersion` lower than `contract.schemaVersion`. Each entry
   * transforms the raw parsed JSON for one version step. Steps run sequentially:
   * fileVersion → fileVersion+1 → … → contract.schemaVersion. A missing step
   * fails validation with `MigrationGapError`.
   */
  readonly migrations: { readonly [fromVersion: number]: (raw: unknown) => unknown };
}
```

### Migration shape (per leaf)

Each entry in `migrations` is a pure function from the previous version's shape
to the next version's shape. The validator walks the chain on load:

```ts
// pseudo-code inside validate-signals-file.ts
const raw = JSON.parse(bytes);
const fileVersion = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
let current: unknown = raw;
for (let v = fileVersion; v < contract.schemaVersion; v++) {
  const step = contract.migrations[v];
  if (!step) return Result.error(new MigrationGapError({ from: v, to: contract.schemaVersion, file: path }));
  current = step(current);
}
const parsed = contract.signalsSchema.safeParse((current as { signals: unknown }).signals);
if (!parsed.success) return Result.error(toDomainError(parsed.error));
return Result.ok(parsed.data);
```

In-flight sprints survive an upgrade automatically: their old `signals.json`
files get migrated forward on load. No "fail-and-restart" required, no
in-flight blast radius from bumping `schemaVersion`.

### Per-leaf contracts

```ts
// generator.contract.ts
const generatorOutputContract: AiOutputContract = {
  schemaVersion: 1,
  signalsSchema: z
    .array(
      z.union([
        changeSignalSchema,
        learningSignalSchema,
        noteSignalSchema,
        decisionSignalSchema,
        taskVerifiedSchema,
        taskCompleteSchema,
        taskBlockedSchema,
        commitMessageSignalSchema,
        progressEntrySchema,
      ])
    )
    .refine(atMostOne('commit-message'), 'at most one commit-message signal per spawn'),
  sidecars: [
    {
      signalKind: 'commit-message',
      filename: 'commit-message.txt',
      multiplicity: 'optional',
      extract: (s) => {
        const sig = s as CommitMessageSignal;
        return sig.body !== undefined && sig.body.length > 0 ? `${sig.subject}\n\n${sig.body}\n` : `${sig.subject}\n`;
      },
    },
  ],
};

// evaluator.contract.ts
const evaluatorOutputContract: AiOutputContract = {
  schemaVersion: 1,
  signalsSchema: z
    .array(
      z.union([
        changeSignalSchema,
        learningSignalSchema,
        noteSignalSchema,
        taskVerifiedSchema,
        taskBlockedSchema,
        evaluationSignalSchema,
      ])
    )
    .refine(exactlyOne('evaluation'), 'exactly one evaluation signal per spawn'),
  sidecars: [
    {
      signalKind: 'evaluation',
      filename: 'evaluation.md',
      multiplicity: 'one',
      extract: (s) => renderEvaluationMarkdown(s as EvaluationSignal),
    },
  ],
};

// refine.contract.ts
const refineOutputContract: AiOutputContract = {
  schemaVersion: 1,
  signalsSchema: z
    .array(z.union([learningSignalSchema, noteSignalSchema, decisionSignalSchema, refinedTicketSignalSchema]))
    .refine(exactlyOne('refined-ticket')),
  sidecars: [], // refine has no operator-facing sidecar; harness projects refined-ticket onto Ticket entity
};

// readiness.contract.ts
const readinessOutputContract: AiOutputContract = {
  schemaVersion: 1,
  signalsSchema: z.array(
    z.union([
      learningSignalSchema,
      noteSignalSchema,
      skillSuggestionsSchema,
      agentsMdProposalSignalSchema,
      setupSkillProposalSignalSchema,
      verifySkillProposalSignalSchema,
    ])
  ),
  sidecars: [
    {
      signalKind: 'agents-md-proposal',
      filename: 'agents-md-proposal.md',
      multiplicity: 'optional',
      extract: (s) => (s as AgentsMdProposalSignal).body,
    },
    {
      signalKind: 'setup-skill-proposal',
      filename: 'setup-skill.md',
      multiplicity: 'optional',
      extract: (s) => (s as SetupSkillProposalSignal).body,
    },
    {
      signalKind: 'verify-skill-proposal',
      filename: 'verify-skill.md',
      multiplicity: 'optional',
      extract: (s) => (s as VerifySkillProposalSignal).body,
    },
  ],
};
```

## File locations

| Spawn                | Output directory                                        | AI writes      | Harness renders                                                                             |
| -------------------- | ------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| generator (round N)  | `<sprintDir>/implement/<task-id>/rounds/<N>/generator/` | `signals.json` | `commit-message.txt` (if commit-message signal present)                                     |
| evaluator (round N)  | `<sprintDir>/implement/<task-id>/rounds/<N>/evaluator/` | `signals.json` | `evaluation.md`                                                                             |
| refine (ticket T)    | `<sprintDir>/refinement/<ticket-id>/`                   | `signals.json` | —                                                                                           |
| plan (run R)         | `<sprintDir>/plan/<run-id>/`                            | `signals.json` | —                                                                                           |
| ideate (run R)       | `<sprintDir>/ideate/<run-id>/`                          | `signals.json` | —                                                                                           |
| readiness (per repo) | `<sprintDir>/readiness/<repo-id>/`                      | `signals.json` | `agents-md-proposal.md` / `setup-skill.md` / `verify-skill.md` (each if its signal present) |

The `sessionId` file stays alongside per spawn — enables `--resume` on validation failure.

### Session shape declares `outputDir`

The `HeadlessAiProvider` / `InteractiveAiProvider` `AiSession` shape declares an `outputDir: AbsolutePath` field. This
is the directory the AI is told to write `signals.json` to, and the directory the validator walks post-spawn. Adapters
resolve `<sprintDir>/implement/<task-id>/rounds/<N>/<role>/` (or the equivalent per-flow path) and assign it before
invoking the provider. Mocks in [10](10-leaf-tests-mock-ai.md) key fixtures off this field.

## Leaf flow (post-spawn)

```ts
const spawnResult = await provider.run(session);
if (!spawnResult.ok) return spawnResult;

const validation = await validateSignalsFile(outputDir, contract.signalsSchema);
if (!validation.ok) {
  return Result.error(toDomainError(validation.error));
}
const signals = validation.value;

// publish each signal to the bus (live TUI updates)
for (const sig of signals) eventBus.publish({ type: 'ai-signal', signal: sig, source: leafName });

// render harness-owned sidecars from validated signals
const sidecarPaths = await renderSidecars(outputDir, signals, contract.sidecars);

return Result.ok({ signals, sidecarPaths });
```

`renderSidecars` is the one shared helper that walks `contract.sidecars`, finds matching signals, runs`extract(signal)`,
and writes each via the **injected `WriteFile` port** (not a direct `writeTextAtomic` call). The leaf passes `WriteFile`
into `renderSidecars` as a dep — keeps the helper port-testable, and lets [10](10-leaf-tests-mock-ai.md)'s fake
`EventBus` + fake `WriteFile` assert what the leaf wrote without filesystem I/O.

### Sidecars are purely operator UX; downstream leaves read in-memory signals

Sidecars (`commit-message.txt`, `evaluation.md`, `agents-md-proposal.md`, `setup-skill.md`, `verify-skill.md`) are \*
\*purely operator-facing artifacts\*\*. No downstream leaf consumes them as files. `commit-task` reads the `commit-message`
signal body from the validated signals in ctx (passed forward by the generator leaf), not from `commit-message.txt`.
Same for every other "downstream consumer" pattern:

| Consumer           | Reads from                                                            | Not from                                                                    |
| ------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `commit-task`      | `commit-message` signal in ctx                                        | `commit-message.txt`                                                        |
| Operator           | sidecar files on disk                                                 | (signals.json is JSON-escaped; sidecars are the readable form)              |
| Skill-install flow | `setup-skill-proposal` / `verify-skill-proposal` signal bodies in ctx | `setup-skill.md` / `verify-skill.md` (those exist for operator review only) |

This makes the failure model uniform: **all sidecar write failures are warn-only**. No "load-bearing" / "advisory" tier
needed. The leaf never returns `Result.error` for a sidecar write failure — it logs warn and continues.

## Failure modes

| Mode                   | Cause                                                                  | Surfaced as                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signals-missing`      | `signals.json` absent after spawn exit                                 | `InvalidStateError`, hint names the file path                                                                                                       |
| `signals-invalid`      | `signals.json` exists but Zod parse fails                              | Same, hint includes the Zod issue path (e.g. `signals[3].evaluation.verdict: required`)                                                             |
| `sidecar-write-failed` | Validation OK but a sidecar file write failed (disk full, permissions) | Log warn + leaf returns `Result.ok`. Sidecars are operator UX only; downstream leaves consume signals from ctx, not from sidecar files (see above). |

Retry policy is leaf-local (see [02](02-signal-contract.md)):

- Inside the gen-eval loop: round fails → next round runs with a critique describing the validation error.
- One-shot leaves: flow aborts; operator inspects, fixes, re-runs.

The leaf does not internally retry the spawn.

## What this kills compared to today

- The `<change>` / `<learning>` / `<note>` / `<decision>` XML-tag regex pipeline (`parseHarnessSignals`).
- The "harness writes signals.json from parsed stdout" intermediate step.
- The 4 KiB / 500-char truncation hacks on commit messages and decisions — bodies live verbatim inside JSON-encoded
  signal fields; no caps anywhere.
- The implicit dependency between `chain.log` and `progress.md` (signals come from validated files, not mining —
  see [07](07-progress-vs-chain-log.md)).
- The race between AI writing multiple files and harness reading them. Only `signals.json` is AI-written; the harness
  controls every other file write.
- The per-round `outcome.md` file is **also gone** under the journal model — see [07](07-progress-vs-chain-log.md). The
  settle-attempt summary lives in `progress.md`'s journal section instead.

What stays:

- `sessionId` files per role per round — enables `--resume`.
- Per-round sandbox layout — unchanged.
- In-memory bus — TUI's only signal source.

## Skill / agents-md installation (post-readiness)

When the readiness flow's harness-rendered sidecars (`agents-md-proposal.md`, `setup-skill.md`, `verify-skill.md`) exist
and the operator approves, a follow-up step copies them into the target repo:

| Sidecar                 | Applied to                                                                                  | Notes                                 |
| ----------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------- |
| `agents-md-proposal.md` | `<repo>/CLAUDE.md` (or `AGENTS.md` / `.github/copilot-instructions.md` per active provider) | Operator reviews diff before applying |
| `setup-skill.md`        | `<repo>/<parentDir>/skills/setup/SKILL.md`                                                  | No prefix                             |
| `verify-skill.md`       | `<repo>/<parentDir>/skills/verify/SKILL.md`                                                 | No prefix                             |

### Two skill categories — different naming rules

| Category                            | Source                                                                       | Installed path                                                                          | Prefix                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Bundled skills**                  | Shipped with the harness binary; used by ralphctl's own internal AI sessions | `<repo>/<parentDir>/skills/ralphctl-*/SKILL.md`                                         | **Keep `ralphctl-` prefix** — these are harness-owned and need to be distinguishable from project skills |
| **AI-generated skills** (readiness) | Authored by the readiness AI session for _this_ project                      | `<repo>/<parentDir>/skills/setup/SKILL.md`, `<repo>/<parentDir>/skills/verify/SKILL.md` | **No prefix** — the bytes must be useful to any AI agent (Claude / Copilot / Codex / future)             |

The skills adapter (`src/integration/ai/skills/adapter-factory.ts`) needs both code paths: `ralphctl-*` tracking for
bundled installs (existing) plus bare-name installs for readiness-generated skills (new). The `.git/info/exclude`
wildcard stays simple — `ralphctl-*` excludes bundled skills only. Readiness-generated skills (`setup/`, `verify/`) are\*
\*deliberately not excluded\*\* — they're project assets the operator commits.

## Prompt ↔ contract synchronisation

The prompt template documents the contract. The same Zod schema renders both:

- A rendered example embedded in the prompt (so the AI knows what to write).
- The validation step in the leaf (so the harness knows what to accept).

```ts
// src/integration/ai/contract/render-contract-section.ts (proposed)
export const renderContractSection = (contract: AiOutputContract): string => {
  // produces: "You must write `signals.json` matching this schema:
  //   [ ... rendered from contract.signalsSchema ... ]
  // You may only stop when signals.json is present and valid.
  // (Note: do NOT write any other files; the harness derives all on-disk output from signals.json.)"
};
```

The prompt substitutes `{{OUTPUT_CONTRACT_SECTION}}` from this helper. Prompt unit
tests ([11](11-prompt-template-unit-tests.md)) verify the rendered example round-trips through its schema.

## ESLint fences (new, required to keep the target invariants over time)

1. **`*Contract$` joins the port-name family.** Extend the regex at `eslint.config.ts:481-489` to include `Contract`
   alongside `Port|Adapter|Provider|Sink|Loader|Probe|Reader|Writer|Renderer|Detector`. Without it, `AiOutputContract` /
   `SidecarRule` types could be declared outside `_engine/`.
2. **Chains may import from `contract/_engine/` but not per-signal schemas.** Add a `chainsLayerRule` clause forbidding
   imports from `**/integration/ai/contract/signals/**` outside `_engine/` itself. Leaves talk to contracts via the
   engine boundary; per-signal Zod schemas stay private.
3. **`fs.appendFile` is fenced from application + business.** With the new `AppendFile` port (
   see [07](07-progress-vs-chain-log.md)), direct `node:fs` append calls outside `integration/` would silently bypass
   the port. Add a `no-restricted-imports` (or `no-restricted-syntax`) rule banning `fs.appendFile` and
   `fs.promises.appendFile` outside `integration/io/`.

## Open questions

(none remaining — see "Resolved" below)

## Resolved (with answers folded in)

- **`schemaVersion` bump policy:** versioning + migration via per-leaf `AiOutputContract.migrations`. Validator walks
  the chain at load time, migrating old `signals.json` files forward to the current schema. In-flight sprints survive
  upgrades. See "Migration shape (per leaf)" above. Pattern mirrors Zustand's `persist` middleware migrate hook but is
  implemented natively in ~50 lines — no library dep, no React, fits the existing repository pattern. The same pattern
  extends to entity-level migrations — see [06](06-execution-json-slimming.md).
- **Codex approval flow:** doesn't interfere with the AI's `Write` calls under the contract. **Headless** (`codex exec`)
  has no per-tool approval mechanism at all — sandbox alone gates writes; `-s workspace-write` allows the AI to write
  `signals.json` inside cwd + `--add-dir` roots without prompting. **Interactive** (`codex`) accepts
  `-a <APPROVAL_POLICY>`; today's adapter passes `-a on-request` (model decides when to escalate). For the new
  contract — where the harness drives the session unattended and wants zero per-tool noise — switch interactive sessions
  to `-a never` so the AI never escalates per-write; sandbox stays as the only gate. Trade-off: with `never`, a write
  outside the sandbox fails immediately rather than prompting the user; that's the correct behaviour for harness-driven
  runs (the sandbox + cwd + add-dirs are pre-configured to cover every legal write path).
- **`<parentDir>` per provider for installed skills:** Claude → `.claude/`; Copilot → `.github/`; Codex → `.agents/` (
  resolved in the per-provider skills adapters today). De-prefixed `skills/setup/` and `skills/verify/` slot under
  whichever `parentDir` the active provider uses.
- **`RALPHCTL_DEBUG_TRACE` env-var read:** in `wire()` at `src/application/bootstrap/wire.ts`, matching the existing
  `RALPHCTL_HOME` / `RALPHCTL_SKIP_LEGACY_CHECK` pattern. The bootstrap wires either the file-log sink or a no-op sink
  depending on the env var; integration adapters don't read env vars directly.
- **`commit-task` cutover:** same PR as the generator-leaf [09] migration. The generator leaf publishes the validated
  `commit-message` signal into ctx; `commit-task` reads it from ctx in the same merge. `Attempt.commitMessage` field is
  dropped in the same PR; persisted old-schema state ignores it on load.
- **AI session mount of `<sprintDir>`:** **implement only**. Implement's cwd is the user's repo, so it needs
  `--add-dir <sprintDir>` to reach `progress.md`. Refine / plan / ideate / readiness have cwd inside `<sprintDir>`
  already (e.g. `<sprintDir>/refinement/<ticket-slug>/`), so they reach progress.md via cwd-relative traversal — no
  extra `--add-dir`.
- **Sidecar criticality:** all sidecars are operator UX only. Downstream leaves consume signals from ctx, never from
  sidecar files. All sidecar write failures are warn-only.

## Action items

- [ ] Rename TS union `HarnessSignal` → `AiSignal` at `src/domain/signal.ts` (TS only; drop any Zod imports if currently
      present, push them to integration).
- [ ] Create `src/integration/ai/contract/_engine/signals/<kind>/schema.ts` with Zod schemas per kind. One file per kind
      keeps git diffs scoped when schemas evolve.
- [ ] Create
      `src/integration/ai/contract/_engine/{types.ts, validate-signals-file.ts, render-sidecars.ts, render-contract-section.ts, render-evaluation-markdown.ts}`.
      `renderSidecars` accepts `WriteFile` as a constructor / call dep.
- [ ] Per leaf: declare `<leaf>.contract.ts` next to the leaf source under `src/application/flows/<flow>/leaves/`.
      Compose contracts from `_engine/` building blocks (never reach into `signals/<kind>/` directly). Each contract
      declares `schemaVersion: 1` initially with `migrations: {}`; future bumps add migration steps.
- [ ] Define `MigrationGapError` (domain error) and wire the version-walk loop into `validate-signals-file.ts` per the "
      Migration shape" section above.
- [ ] Codex interactive adapter (`src/integration/ai/providers/codex/interactive.ts`): change `-a on-request` to
      `-a never` for harness-driven sessions. Sandbox stays at `workspace-write`. Smoke test: run a refine spawn through
      Codex and confirm `signals.json` lands without prompts.
- [ ] Update prompt templates to substitute `{{OUTPUT_CONTRACT_SECTION}}` + stop-condition.
- [ ] Replace `parseHarnessSignals` call sites with `validateSignalsFile + renderSidecars`.
- [ ] Delete `src/integration/ai/signals/_engine/parse-signals.ts` and friends.
- [ ] Add `outputDir: AbsolutePath` to the `AiSession` shape consumed by `HeadlessAiProvider` / `InteractiveAiProvider`.
- [ ] Wire `RALPHCTL_DEBUG_TRACE` env-var read in `src/application/bootstrap/wire.ts` (gate the file-log sink).
- [ ] Update `commit-task` to read `commit-message` body from ctx (validated signal) — same PR as the
      generator-leaf [09] migration. Drop `Attempt.commitMessage` field from the Task entity.
- [ ] Extend the skills adapter (`src/integration/ai/skills/adapter-factory.ts`) for bare-name installs of
      readiness-generated skills (in addition to existing `ralphctl-*` bundled installs). The existing `ralphctl-*` wildcard
      in `.git/info/exclude` stays — it covers bundled skills only; readiness-generated skills are deliberately tracked by
      git.
- [ ] Add ESLint fences: `Contract` to the port-name regex; `chainsLayerRule` clause blocking `contract/signals/**`
      imports outside `_engine/`; `fs.appendFile` ban outside `integration/io/`.
- [ ] Add `--add-dir <sprintDir>` to **implement-only** AI session wiring. Refine / plan / ideate / readiness use
      cwd-relative traversal for `progress.md` (cwd already inside `<sprintDir>`).
- [ ] See [10](10-leaf-tests-mock-ai.md) for the test pattern.
- [ ] See [11](11-prompt-template-unit-tests.md) for the prompt-side invariants.
