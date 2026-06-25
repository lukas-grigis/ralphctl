# Adding a provider

ralphctl drives a CLI coding agent (Claude Code, Codex, Copilot) in a generator–evaluator
loop: it spawns the agent headless, the agent does the work and writes its results to a file,
the harness reads that file back and decides whether to continue. A **provider** is the adapter
that translates ralphctl's intent into one specific CLI's flags and parses that CLI's output
stream.

This guide walks through adding a fourth one. The running example is a hypothetical `gemini`
provider (slug `google-gemini`, binary `gemini`) — substitute your own. The existing three live
side by side under `src/integration/ai/providers/{claude,codex,copilot}/`; copy the closest
match and edit, rather than writing from scratch.

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
export type AiProvider = 'claude-code' | 'github-copilot' | 'openai-codex' | 'google-gemini';
```

This is additive — existing settings files still parse, so no `CURRENT_SCHEMA_VERSION` bump and
no migration. But it breaks compilation at three **exhaustive switches with no `default`**, each
of which you now have to extend:

- `createAiProvider` in `src/application/bootstrap/provider-factory.ts` (`const exhaustive: never = row`)
- `toolForProvider` in `src/integration/ai/readiness/_engine/tool.ts`
- `createSkillsAdapter` in `src/integration/ai/skills/adapter-factory.ts`

And one **total record** that won't compile until you add a key:

- `MODEL_AVAILABILITY_PROBES: Record<AiProvider, …>` in `src/application/bootstrap/wire.ts`

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
availability probe's job (step 6), not this file's.

## 2. Settings schema arm (domain)

In `src/domain/entity/settings.ts`, alongside the existing Claude/Codex/Copilot rows, add four
pieces:

```ts
const AiProviderSchema = z.enum([
  'claude-code',
  'github-copilot',
  'openai-codex',
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
what you can't express:

```ts
export const buildGeminiArgs = (session: AiSession): Result<readonly string[], InvalidStateError> => {
  if (!isGeminiModel(session.model)) {
    return Result.error(new InvalidStateError({
      entity: 'gemini-provider',
      currentState: 'model-validation',
      attemptedAction: 'build argv',
      message: `gemini-provider: '${session.model}' is not a known Gemini model`,
    }));
  }
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

## 5. The factory arm

`src/application/bootstrap/provider-factory.ts`, in the `switch (row.provider)`:

```ts
case
'google-gemini'
:
return createGeminiProvider({
  rateLimitRetries: deps.harnessConfig.rateLimitRetries,
  idleMs: deps.harnessConfig.idleWatchdogMs,
  eventBus: deps.eventBus,
  ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
});
```

This carries only operational concerns (retry budget, idle watchdog, log sink, test spawn seam).
Model tier flows per call via `AiSession`, never through the factory.

## 6. The rest of the surface (the forced arms)

These exist because the new union member broke an exhaustive switch or a total record. They are
small and mostly boilerplate.

- **Availability probe** — `src/integration/ai/providers/gemini/model-availability-probe.ts`.
  Start with a passthrough (copy `copilot/model-availability-probe.ts`): it returns the catalog
  unchanged. The port contract requires it to **fail open and never throw**. Register it in
  `wire.ts`'s `MODEL_AVAILABILITY_PROBES` (total record — this is the compile error).

- **Readiness** — `toolForProvider` in `_engine/tool.ts` must map `google-gemini` to an
  `AssistantTool`. If your CLI reads its own context file (e.g. `GEMINI.md`), add a new
  `AssistantTool` variant, a `readiness/gemini/probe.ts` + `readiness/gemini/artifacts.ts` (copy
  `readiness/codex/`), and register `geminiProbe` in `wire.ts`'s `PROBES`. `PROBES` is a
  `Partial` record, so a missing probe degrades gracefully (readiness just does nothing for that
  provider) — but `toolForProvider` is exhaustive and **must** get its arm to compile.

- **Skills** — `createSkillsAdapter` in `skills/adapter-factory.ts` must return an adapter for
  `google-gemini`. The on-disk shape is identical across providers (Agent Skills `SKILL.md`
  folders); only the parent directory differs. Add `skills/gemini/adapter.ts` that delegates to
  `createFilesystemSkillsAdapter` with your directory (e.g. `.gemini/skills/`), copying
  `skills/codex/adapter.ts`.

- **Settings TUI** — the picker reads the `AiProvider` union, so your provider appears once the
  schema includes it. Check `src/application/ui/tui/views/ai-row.tsx` and `preset-bar.tsx` for any
  hardcoded provider labels or preset rows you want to surface.

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
| `provider-factory.ts` arm                | boilerplate — one `case`                                                                      |
| `model-availability-probe.ts`            | boilerplate to start (passthrough); provider-specific only if you build real narrowing        |
| readiness probe + artifacts              | mostly boilerplate — copy a sibling, change the context-file name                             |
| `skills/gemini/adapter.ts`               | boilerplate — delegate to `createFilesystemSkillsAdapter`                                     |
| tests                                    | copy a sibling suite, adjust fixtures                                                         |

The two files you actually think hard about are `headless.ts` and the stream parser. Everything
else is following the compiler from one exhaustive switch to the next.

## Files at a glance

A headless provider that compiles and runs the loop: ~6 files
(`settings-models/<p>.ts`, `settings.ts`, `_engine/<p>-provider-deps.ts`, `<p>/headless.ts`,
`<p>/parse-stream.ts`, `provider-factory.ts`) plus the two compiler-forced one-liners
(`model-availability-probe.ts` + its `wire.ts` registry entry, and the `toolForProvider` /
`createSkillsAdapter` arms).

Full parity with the built-in three — readiness context-file support, a skills directory,
availability filtering, and the test suites — lands around **14 files**:

1. `src/domain/value/settings-models/gemini.ts` — _new_
2. `src/domain/entity/settings.ts` — _edit_ (union, enum, effort/model/row schemas, discriminated union)
3. `src/integration/ai/providers/_engine/gemini-provider-deps.ts` — _new_
4. `src/integration/ai/providers/gemini/headless.ts` — _new_
5. `src/integration/ai/providers/gemini/parse-stream.ts` — _new_ (or fold inline)
6. `src/integration/ai/providers/gemini/model-availability-probe.ts` — _new_ (passthrough)
7. `src/application/bootstrap/provider-factory.ts` — _edit_ (factory arm)
8. `src/application/bootstrap/wire.ts` — _edit_ (`MODEL_AVAILABILITY_PROBES` + `PROBES`)
9. `src/integration/ai/readiness/_engine/tool.ts` — _edit_ (`AssistantTool` + `toolForProvider`)
10. `src/integration/ai/readiness/gemini/probe.ts` — _new_
11. `src/integration/ai/readiness/gemini/artifacts.ts` — _new_
12. `src/integration/ai/skills/adapter-factory.ts` — _edit_ (skills arm)
13. `src/integration/ai/skills/gemini/adapter.ts` — _new_
14. tests under `tests/integration/ai/providers/gemini/` and `tests/unit/…` — _new_

See also `CONTRIBUTING.md` — open an issue first, keep the PR focused, all checks pass.
