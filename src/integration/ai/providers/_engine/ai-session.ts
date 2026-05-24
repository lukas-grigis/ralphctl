import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { SessionPermissions } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Per-call AI session descriptor — the shape `HeadlessAiProvider.generate` consumes.
 *
 * The descriptor captures **intent** (model tier, permissions, additional roots, resume id).
 * The adapter is the only place that knows how to translate intent into the concrete
 * vocabulary of its CLI (Claude flag names, model strings, tool names).
 *
 * Adapter advisory contract: when an adapter does not support a feature (e.g.
 * `additionalRoots` on a future Copilot adapter), it MUST surface `InvalidStateError`
 * rather than silently using only `cwd`. Fail loud beats silent surprise.
 */
export interface AiSession {
  /** Fully-rendered prompt — branded so a non-validated string cannot be passed. */
  readonly prompt: Prompt;
  /** Primary working directory the AI session opens in. */
  readonly cwd: AbsolutePath;
  /**
   * Extra repository roots the session should mount alongside `cwd`. Optional; adapters
   * that cannot mount multiple roots MUST error rather than silently drop the extras.
   */
  readonly additionalRoots?: readonly AbsolutePath[];
  /**
   * Concrete model identifier the adapter will pass through. Each provider publishes
   * its supported models (`ClaudeModel`, `CopilotModel`, …); the composition root picks
   * one per chain via config and threads it here. The adapter validates the string
   * against its known set and surfaces `InvalidStateError` for unknowns.
   */
  readonly model: string;
  /**
   * Effort / reasoning level the AI should run at, resolved by the launcher via
   * `resolveEffort(flowId, settings)`. Provider-native vocabulary (Claude:
   * `low|medium|high|xhigh|max`; Copilot adds `none`; Codex: `minimal|low|medium|high`).
   * The adapter is responsible for translating this string into its CLI flag
   * (`--model-reasoning-effort` for Codex, etc.). Adapters that do not support a
   * reasoning flag MUST silently ignore the field — never surface an error for an
   * unset / unsupported optional knob.
   */
  readonly effort?: string;
  /** Semantic permission set — adapter maps to its concrete permission flags / modes. */
  readonly permissions: SessionPermissions;
  /** Optional id of a prior session to resume. */
  readonly resume?: SessionId;
  /** Optional caller-controlled abort signal. Adapters propagate to spawn → SIGTERM. */
  readonly abortSignal?: AbortSignal;
  /**
   * Caller-supplied path the provider writes parsed signals to (JSON array of `HarnessSignal`).
   * The caller controls placement (audit tree, tempfile, …) and lifetime. Every signal a flow
   * cares about must have a registered parser in `signal-parsers/registry.ts`; the file-based
   * contract gives flows a single uniform read-path (read `signalsFile`, filter by `type`)
   * regardless of which custom tags they consume.
   */
  readonly signalsFile: AbsolutePath;
  /**
   * Optional path where the provider mirrors the raw assistant response body (plain text).
   * Intended for diagnostic use in one-shot flows (detect-scripts, detect-skills) where an
   * empty signal set may mean the AI responded but emitted no recognised tags. When set,
   * the body is written here after `signalsFile` is written; the file is owned and cleaned
   * up by the caller. Adapters that do not support this field MUST silently ignore it —
   * never surface an error for an unset optional diagnostic path.
   *
   * Implemented by Claude and Codex. Copilot support is deferred and currently a no-op.
   */
  readonly bodyFile?: AbsolutePath;
  /**
   * Directory the AI is told to write `signals.json` to under the audit [09] contract. The
   * field is optional today; per-leaf migrations adopting the new contract set it to the
   * spawn's per-round output directory (e.g.
   * `<sprintDir>/implement/<task-id>/rounds/<N>/<role>/`). The harness validator post-spawn
   * reads from `<outputDir>/signals.json` and renders sidecars under the same dir.
   *
   * Once every leaf migrates, `signalsFile` becomes derivable (`<outputDir>/signals.json`)
   * and may be removed in a follow-up.
   */
  readonly outputDir?: AbsolutePath;
}
