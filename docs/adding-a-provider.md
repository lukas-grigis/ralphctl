# Adding a provider

ralphctl drives a CLI coding agent (Claude Code, Codex, Copilot, OpenCode) in a generator–evaluator
loop: it spawns the agent headless, the agent does the work and writes its results to a file,
the harness reads that file back and decides whether to continue. A **provider** is the adapter
that translates ralphctl's intent into one specific CLI's flags and parses that CLI's output
stream.

This guide walks through adding another one. The running example is a hypothetical `gemini`
provider (slug `google-gemini`, binary `gemini`) — substitute your own. The existing four live
side by side under `src/integration/ai/providers/{claude,codex,copilot,opencode}/`; copy the
closest match and edit, rather than writing from scratch. `opencode/` is the most recent and the
smallest, so it is usually the best starting point — and the only one whose CLI runs without
credentials, which makes it the easiest to study against a live binary.

## The port you implement

Everything hangs off one interface, `src/integration/ai/providers/_engine/headless-ai-provider.ts`:

```ts
export interface HeadlessAiProvider {
  generate(session: AiSession): Promise<Result<ProviderOutput, DomainError>>;
}
```

`generate` runs **one** headless session described by an `AiSession` and returns a
`ProviderOutput` (`{ signalsFile, sessionId?, exitCode, recoveredFromExit? }`). Two facts about
this contract decide most of the work:

1. **You do not parse harness signals from stdout.** Under the audit-[09] contract the agent
   writes its own `signals.json` via its `Write` tool into `session.outputDir`; the harness
   validates that file post-spawn. Your adapter spawns the process, captures meta (session id,
   exit code, token usage), and returns the path — it never scrapes the model's text for
   structured output. Parsing the body string and retaining it on a domain entity is the source
   of a known multi-hour OOM; don't reintroduce it.

2. **Intent in, not mechanism.** `AiSession`
   (`src/integration/ai/providers/_engine/ai-session.ts`) is provider-neutral: `model`,
   `permissions`, `effort?`, `additionalRoots?`, `resume?`, `cwd`, `prompt`. Your adapter is the
   only place that knows your CLI's flag names. When your CLI can't express an intent, surface
   `InvalidStateError` — never silently fall back. See "The InvalidStateError rule" below.

## The type system is your checklist

Add the provider to one union and the compiler will route you to every place that must change.
Start in `src/domain/entity/settings.ts`:

```ts
export type AiProvider = 'claude-code' | 'github-copilot' | 'openai-codex' | 'opencode' | 'google-gemini';
```

This is additive — existing settings files still parse, so no `CURRENT_SCHEMA_VERSION` bump and
no migration. But it breaks compilation everywhere provider-keyed static data lives, because the
tree registers that data as **total `Record<AiProvider, …>` tables** rather than switches: a
missing key is a type error at the table, not a runtime fall-through. Regenerate the current list
whenever you start:

```bash
grep -rn 'Record<AiProvider' src | grep -v Partial
```

Today that is fifteen tables plus the registry in `wire.ts` (typed through
`ModelAvailabilityProbeRegistry`), grouped by layer:

| Layer         | Table                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain`      | `PROVIDER_EFFORT_LEVELS` (`value/settings-models/effort.ts`)                                                                                                                                                                                                                                                                                                                                                     |
| `business`    | `DEFAULT_MODELS_BY_PROVIDER` (`settings/defaults.ts`)                                                                                                                                                                                                                                                                                                                                                            |
| `integration` | `PROVIDER_BINARY` + `PROVIDER_INSTALL_GUIDANCE` (`system/detect-cli.ts`), `PROVIDER_TRAITS` (`ai/providers/_engine/provider-traits.ts`), `AGENT_ADAPTERS` (`ai/agents/adapter-factory.ts`), `SKILLS_ADAPTERS` (`ai/skills/adapter-factory.ts`), `OPERATOR_PROVIDER_DIR` (`ai/skills/operator/source.ts`)                                                                                                         |
| `application` | `HEADLESS_FACTORIES` (`bootstrap/provider-factory.ts`), `INTERACTIVE_FACTORIES` (`bootstrap/interactive-provider-factory.ts`), `MODEL_AVAILABILITY_PROBES` (`bootstrap/wire.ts`), `PROVIDER_AUTH_CHECK` (`flows/doctor/provider-auth.ts`), `PROVIDER_LABEL` (`flows/doctor/probe-helpers.ts` and `ui/shared/launch/readiness.ts` — two separate tables), `PRESET_FOR_PROVIDER` (`ui/tui/views/welcome-view.tsx`) |

One **exhaustive `switch` with no `default`** also breaks: `toolForProvider` in
`src/integration/ai/readiness/_engine/tool.ts`. If your CLI reads its own context file you will
additionally widen the `AssistantTool` union, which forces its inverse `providerForTool` (same
file) and `pickExistingContextPath` in
`src/application/flows/readiness/leaves/propose.ts`.

Follow the red squiggles. The sections below are those errors in dependency order.

## 1. Model catalog (domain)

New file: `src/domain/value/settings-models/gemini.ts`. Mirror `codex.ts` exactly — a string
literal union, a frozen array, and a type guard:

```ts
export type GeminiModel = 'gemini-2.5-pro' | 'gemini-2.5-flash';

export const GEMINI_MODELS: readonly GeminiModel[] = ['gemini-2.5-pro', 'gemini-2.5-flash'] as const;

export const isGeminiModel = (s: string): s is GeminiModel => (GEMINI_MODELS as readonly string[]).includes(s);
```

The adapter validates `AiSession.model` against this set and emits `InvalidStateError` for
unknowns. The static catalog stays the full official list; per-account narrowing is the
availability probe's job (step 6), not this file's. An aggregator backend whose adapter forwards
the model verbatim (OpenCode gates on id SHAPE only, since the reachable set depends on which
upstream providers the operator authenticated) still keeps this catalog-membership guard — it is
what validates ralphctl's OWN preset and default rows, even though the adapter no longer uses it
as a spawn-time gate.

## 2. Settings schema arm (domain)

In `src/domain/entity/settings.ts`, alongside the existing Claude/Codex/Copilot/OpenCode rows, add four
pieces:

```ts
const AiProviderSchema = z.enum([
  'claude-code',
  'github-copilot',
  'openai-codex',
  'opencode',
  'google-gemini',
]) satisfies z.ZodType<AiProvider>;

const GeminiEffortSchema = z.enum(['low', 'medium', 'high']); // your CLI's native vocabulary

const GeminiModelSchema = z.union([
  z.enum(GEMINI_MODELS as readonly [string, ...string[]]),
  CustomModelStringSchema, // existing helper — lets users pin an off-catalog id
]);

const GeminiFlowRowSchema = z.object({
  provider: z.literal('google-gemini'),
  model: GeminiModelSchema,
  effort: GeminiEffortSchema.optional(),
});
```

Then add `GeminiFlowRowSchema` to the `FlowRowSchema` discriminated union (the schema keys off
`provider`). That's the whole settings surface; every per-flow row and the implement
generator/evaluator pair now accept your provider.

## 3. The provider adapter

New file: `src/integration/ai/providers/gemini/headless.ts`. This is the only genuinely
provider-specific code. It has two parts: an argv builder and a factory.

The argv builder is where intent becomes flags. Validate the model, map permissions, and refuse
what you can't express. Model validation goes through the shared `_engine/validate-model.ts`
helper — it pairs the catalog-membership check with the suspended-model check every adapter needs,
so a hand-rolled `if (!isGeminiModel(…))` silently drops the second half:

```ts
export const buildGeminiArgs = (session: AiSession): Result<readonly string[], InvalidStateError> => {
  const validated = validateModel(session.model, isGeminiModel, {
    entity: 'gemini-provider',
    attemptedAction: 'build argv',
    notKnownMessage: `gemini-provider: '${session.model}' is not a known Gemini model`,
  });
  if (!validated.ok) return Result.error(validated.error);
  const args: string[] = ['--model', session.model, /* …print/stream flags… */];
  // permissions: map SessionPermissions → your CLI's sandbox / deny flags
  // resolveWritableRoots(session) → your CLI's --add-dir equivalent (mounts outputDir too)
  if (session.effort !== undefined) args.push(/* your reasoning flag */);
  if (session.resume !== undefined) args.push(/* your resume flag */, String(session.resume));
  return Result.ok(args);
};
```

The factory delegates the hard parts to shared `_engine` helpers — you write almost no control
flow:

```ts
export const createGeminiProvider = (deps: GeminiProviderDeps): HeadlessAiProvider => {
  const spawnFn = deps.spawn ?? defaultSpawn;
  const command = deps.command ?? 'gemini';
  return {
    async generate(session) {
      const args = buildGeminiArgs(session);
      if (!args.ok) return Result.error(args.error) as Result<ProviderOutput, DomainError>;
      return runWithRateLimitRetry({
        session,
        rateLimitRetries: deps.rateLimitRetries,
        eventBus: deps.eventBus,
        providerSlug: 'gemini',
        providerName: 'gemini-provider',
        resumeStaleRe: RESUME_STALE_RE, // your CLI's "session gone" wording → one cold respawn
        attempt: async (attemptSession) => {
          const built = buildGeminiArgs(attemptSession);
          if (!built.ok) return { kind: 'error', error: built.error };
          return spawnAttempt({ deps, spawnFn, command, args: built.value, session: attemptSession });
        },
      });
    },
  };
};
```

Inside `spawnAttempt`, three `_engine` helpers carry the weight (study `claude/headless.ts` for
the full shape):

- `runHeadlessSpawn({ child, onStdout, onStderr, stdin: session.prompt, resolveOn, idleMs?, abortSignal?, onIdle })`
  — owns the spawn lifecycle, the idle-stdout watchdog (SIGTERMs a wedged child after
  `idleMs` of silence), and abort propagation. There is **no** wall-clock timeout; implement
  sessions can run for hours.
- `runWithRateLimitRetry(…)` — owns the retry loop, backoff schedule, banners, abort-during-
  backoff, and the resume rebuild. You supply a `rateLimitRe` and a `resumeStaleRe`.
- `classifySpawnExit({ session, exit, stderr, rateLimitRe, stdoutTail?, capturedSessionId?, providerName, eventBus, watchdogBannerId, onSuccess })`
  — decides success / rate-limit / abort / signals-recovery / hard-fail uniformly across all
  adapters. Your per-provider success work (publish `token-usage`, `persistSessionIdFile`,
  optional `bodyFile` mirror, return `ProviderOutput`) goes in the `onSuccess` closure. It runs
  on clean exit **and** on signals-present recovery, so a watchdog SIGTERM that landed after the
  agent finished still counts as success.

### Prompt delivery — keep the body out of argv

`stdin: session.prompt` above is not a stylistic choice. A Windows command line caps at 32,767
bytes (8,191 once an npm/winget `.cmd` shim routes through `cmd.exe`, where the excess is silently
truncated instead of reported), and a rendered harness prompt clears that on its own — passing the
body as an argument produced `spawn ENAMETOOLONG` before the CLI had started.

So: pipe the prompt through stdin when your CLI accepts it. When it does not — the interactive
port cannot, since piping stdin flips most CLIs out of interactive mode — write the prompt to a
file and pass a pointer at it with `buildPromptPointer(path)` from
`_engine/prompt-pointer.ts`, and make sure the file's directory is among the roots you mount.

Companion file `src/integration/ai/providers/_engine/gemini-provider-deps.ts` declares the
composition-root inputs (`rateLimitRetries`, `eventBus`, and the test seams `spawn?` / `command?`
/ `idleMs?` / `backoffSchedule?`). Copy `claude-provider-deps.ts` and rename. It lives in
`_engine/` so the factory and tests can both depend on it without piercing the `gemini/`
sibling-isolation boundary.

### The InvalidStateError rule

`AiSession` carries optional intents your CLI may not support. The contract
(`ai-session.ts` doc comments) is specific about which way each one fails — match it exactly:

| Field                                 | If your CLI can't express it                                               |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `model` (unknown)                     | `InvalidStateError` — fail fast, before any spawn                          |
| `permissions` (a combo you can't map) | `InvalidStateError` (Codex does this — only two locked profiles)           |
| `additionalRoots`                     | `InvalidStateError` — never silently run with only `cwd`                   |
| `effort`                              | **silently ignore** — an unset/unsupported optional knob is not an error   |
| `bodyFile`                            | **silently ignore** — optional diagnostic mirror (Copilot no-ops it today) |

The principle: an intent that changes correctness or safety (model, permissions, mounted roots)
must fail loud; an optional knob (effort, diagnostic mirror) is ignored quietly. "Silently using
only `cwd`" when extra roots were requested is the specific bug this rule exists to prevent.

## 4. Stream parsing

You parse your CLI's stdout for exactly three things: the **session id** (for `--resume` and
forensic re-attach), the **model + token usage** (for the `token-usage` event), and — best-effort
— the **assistant body** (only for `bodyFile` diagnostics). Not harness signals.

Two patterns exist in the tree; pick by your CLI's output shape:

- **Sibling parser** (`claude/parse-stream.ts`, `copilot/parse-stream.ts`) — when stdout is a
  clean JSONL stream worth a reusable factory. Returns a port-shaped parser; the port types live
  in `_engine/<provider>-stream.ts`. Use this if you want unit tests over the parser in
  isolation.
- **Inline line-buffer** (`codex/headless.ts`'s `consumeMetaLines`) — when extraction is a
  handful of fields and a separate file is overkill.

Parsing must be lenient: non-JSON lines, blank lines, and banner/ANSI noise are skipped
silently. A truly empty stream yields `body=''`, `sessionId=undefined` — a well-shaped envelope,
never a throw. Keep body capture O(1) or O(N) accumulated (a single reassigned string, or
`lines.push()` + `join`); never per-line string concatenation.

## 5. The factory row

`src/application/bootstrap/provider-factory.ts`, in the `HEADLESS_FACTORIES` table:

```ts
const HEADLESS_FACTORIES: Readonly<Record<AiProvider, (deps: HeadlessProviderDeps) => HeadlessAiProvider>> = {
  'claude-code': createClaudeProvider,
  'github-copilot': createCopilotProvider,
  'openai-codex': createCodexProvider,
  opencode: createOpencodeProvider,
  'google-gemini': createGeminiProvider,
};
```

`createAiProvider` then hands every factory the same operational deps (retry budget, idle
watchdog, event bus, test spawn seam), so your row is a bare reference — no per-provider call
site to keep in sync. Model tier flows per call via `AiSession`, never through the factory.
`INTERACTIVE_FACTORIES` in `interactive-provider-factory.ts` is the same shape for the
interactive port.

## 6. The rest of the surface (the forced rows)

These exist because the new union member left a total record short a key, or broke the one
exhaustive switch. They are small and mostly boilerplate — work the compiler's list top to
bottom.

- **Availability probe** — `src/integration/ai/providers/gemini/model-availability-probe.ts`.
  Start with a passthrough (copy `copilot/model-availability-probe.ts`): it returns the catalog
  unchanged. The port contract requires it to **fail open and never throw**. Register it in
  `wire.ts`'s `MODEL_AVAILABILITY_PROBES` (total record — this is the compile error).

- **Readiness** — `toolForProvider` in `_engine/tool.ts` must map `google-gemini` to an
  `AssistantTool`. If your CLI reads its own context file (e.g. `GEMINI.md`), add a new
  `AssistantTool` variant, a `readiness/gemini/probe.ts` + `readiness/gemini/artifacts.ts` (copy
  `readiness/codex/`), and register `geminiProbe` in `wire.ts`'s `PROBES`. `PROBES` is a
  `Partial` record, so a missing probe degrades gracefully (readiness just does nothing for that
  provider) — but `toolForProvider`, its inverse `providerForTool`, and
  `pickExistingContextPath` (`flows/readiness/leaves/propose.ts`) are exhaustive and **must** get
  their arms to compile.

- **Skills and agents** — `SKILLS_ADAPTERS` in `skills/adapter-factory.ts` and `AGENT_ADAPTERS`
  in `agents/adapter-factory.ts` each need a row. The on-disk shape is identical across providers
  (Agent Skills `SKILL.md` folders); only the parent directory differs. Add
  `skills/gemini/adapter.ts` that delegates to `createFilesystemSkillsAdapter` with your directory
  (e.g. `.gemini/skills/`), copying `skills/codex/adapter.ts`, and name that directory again in
  `OPERATOR_PROVIDER_DIR` (`skills/operator/source.ts`) so operator-authored skills resolve.

- **Traits, effort, defaults** — `PROVIDER_TRAITS` (`providers/_engine/provider-traits.ts`) is the
  one object literal holding per-provider static data (binary, install guidance, context-file
  target, skills / agents parent dirs, wire tag, model catalog, effort-forwarding flag);
  `PROVIDER_EFFORT_LEVELS` (`domain/value/settings-models/effort.ts`) declares your CLI's native
  effort vocabulary, and `DEFAULT_MODELS_BY_PROVIDER` (`business/settings/defaults.ts`) the
  per-flow default model rows.

- **Detection and doctor** — `PROVIDER_BINARY` + `PROVIDER_INSTALL_GUIDANCE`
  (`integration/system/detect-cli.ts`) drive the PATH pre-flight and the install hint; both are
  one-line projections of your `PROVIDER_TRAITS` row, but each is its own total record and each
  needs its key. `PROVIDER_AUTH_CHECK` (`flows/doctor/provider-auth.ts`) is the doctor's auth
  probe — when your CLI exposes no non-interactive auth verb use `kind: 'none'` with a `reason`,
  which reports as `unknown` rather than guessing. Two `PROVIDER_LABEL` tables
  (`flows/doctor/probe-helpers.ts`, `ui/shared/launch/readiness.ts`) carry the display name.

- **Settings TUI** — the picker reads the `AiProvider` union, so your provider appears once the
  schema includes it. `PRESET_FOR_PROVIDER` (`ui/tui/views/welcome-view.tsx`) maps it to the
  first-run preset; check `ai-row.tsx` and `preset-bar.tsx` for hardcoded labels or preset rows
  you want to surface.

## 7. Tests

Match the existing layout under `tests/`:

- `tests/integration/ai/providers/gemini/gemini-provider.test.ts` — drive `createGeminiProvider`
  with a fake `spawn` (no real binary). Script stdout/stderr/exit code and assert: argv is built
  correctly, an unknown model returns `InvalidStateError`, an unsupported intent errors rather
  than silently dropping, session id is captured, and a watchdog-SIGTERM-after-signals still
  classifies as success. Copy `tests/integration/ai/providers/codex/codex-provider.test.ts`.
- `tests/unit/integration/ai/providers/gemini/parse-stream.test.ts` — if you wrote a sibling
  parser, test it against real and malformed lines. Copy
  `tests/unit/integration/ai/providers/claude/parse-stream.test.ts`.
- `tests/unit/application/bootstrap/provider-factory.test.ts` — add a `google-gemini` row fixture
  and assert the factory returns your adapter (the wire integration test uses a fake spawn, so no
  real `gemini` binary is needed).

Run the gates the same way CI does:

```bash
pnpm typecheck && pnpm lint && pnpm test
```

## Boilerplate vs. provider-specific

Be honest with yourself about where the real work is:

| File                                     | Nature                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `settings-models/gemini.ts`              | boilerplate — copy `codex.ts`, swap the model ids                                             |
| `settings.ts` arm                        | boilerplate — four parallel schema lines                                                      |
| `_engine/gemini-provider-deps.ts`        | boilerplate — copy `claude-provider-deps.ts`                                                  |
| `gemini/headless.ts` (`buildGeminiArgs`) | **provider-specific** — your CLI's flags, permission mapping, rate-limit/stale-resume regexes |
| `gemini/parse-stream.ts`                 | **provider-specific** — your CLI's stdout shape                                               |
| `provider-factory.ts` row                | boilerplate — one `HEADLESS_FACTORIES` entry                                                  |
| `model-availability-probe.ts`            | boilerplate to start (passthrough); provider-specific only if you build real narrowing        |
| readiness probe + artifacts              | mostly boilerplate — copy a sibling, change the context-file name                             |
| `skills/gemini/adapter.ts`               | boilerplate — delegate to `createFilesystemSkillsAdapter`                                     |
| tests                                    | copy a sibling suite, adjust fixtures                                                         |

The two files you actually think hard about are `headless.ts` and the stream parser. Everything
else is following the compiler from one missing record key to the next.

## Files at a glance

The files you author are few — the count comes from the provider-keyed registries the compiler
forces you through. New code is six files (`settings-models/<p>.ts`,
`_engine/<p>-provider-deps.ts`, `<p>/headless.ts`, `<p>/parse-stream.ts`,
`<p>/model-availability-probe.ts`, `skills/<p>/adapter.ts`) plus tests; everything else is a
one-line row in an existing table.

Full parity with the built-in four — readiness context-file support, a skills directory,
availability filtering, and the test suites — lands around **24 files**:

1. `src/domain/value/settings-models/gemini.ts` — _new_
2. `src/domain/entity/settings.ts` — _edit_ (union, enum, effort/model/row schemas, discriminated union)
3. `src/domain/value/settings-models/effort.ts` — _edit_ (`PROVIDER_EFFORT_LEVELS`)
4. `src/business/settings/defaults.ts` — _edit_ (`DEFAULT_MODELS_BY_PROVIDER`)
5. `src/integration/ai/providers/_engine/gemini-provider-deps.ts` — _new_
6. `src/integration/ai/providers/_engine/provider-traits.ts` — _edit_ (`PROVIDER_TRAITS`)
7. `src/integration/ai/providers/gemini/headless.ts` — _new_
8. `src/integration/ai/providers/gemini/parse-stream.ts` — _new_ (or fold inline)
9. `src/integration/ai/providers/gemini/model-availability-probe.ts` — _new_ (passthrough)
10. `src/integration/system/detect-cli.ts` — _edit_ (`PROVIDER_BINARY` + `PROVIDER_INSTALL_GUIDANCE`)
11. `src/integration/ai/readiness/_engine/tool.ts` — _edit_ (`AssistantTool` + `toolForProvider` + `providerForTool`)
12. `src/integration/ai/readiness/gemini/probe.ts` — _new_
13. `src/integration/ai/readiness/gemini/artifacts.ts` — _new_
14. `src/integration/ai/skills/adapter-factory.ts` — _edit_ (`SKILLS_ADAPTERS`)
15. `src/integration/ai/skills/gemini/adapter.ts` — _new_
16. `src/integration/ai/skills/operator/source.ts` — _edit_ (`OPERATOR_PROVIDER_DIR`)
17. `src/integration/ai/agents/adapter-factory.ts` — _edit_ (`AGENT_ADAPTERS`)
18. `src/application/bootstrap/provider-factory.ts` — _edit_ (`HEADLESS_FACTORIES`)
19. `src/application/bootstrap/interactive-provider-factory.ts` — _edit_ (`INTERACTIVE_FACTORIES`)
20. `src/application/bootstrap/wire.ts` — _edit_ (`MODEL_AVAILABILITY_PROBES` + `PROBES`)
21. `src/application/flows/doctor/provider-auth.ts` + `probe-helpers.ts` — _edit_ (auth check + label)
22. `src/application/flows/readiness/leaves/propose.ts` — _edit_ (only when you widen `AssistantTool`)
23. `src/application/ui/shared/launch/readiness.ts` + `ui/tui/views/welcome-view.tsx` — _edit_ (label + first-run preset)
24. tests under `tests/integration/ai/providers/gemini/` and `tests/unit/…` — _new_

See also `CONTRIBUTING.md` — open an issue first, keep the PR focused, all checks pass.
