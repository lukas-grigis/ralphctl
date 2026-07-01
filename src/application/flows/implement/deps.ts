import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { HarnessSignalSink } from '@src/business/observability/harness-signal-sink.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { IterationConfig } from '@src/application/chain/run/iteration-config.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { FileLocker } from '@src/integration/io/file-locker.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { FoldQueue } from '@src/application/flows/implement/wave-branch.ts';

/**
 * Narrow dependency contract for the implement chain. Composition root constructs each field
 * from the integration layer and passes the bag to `createImplementFlow`.
 *
 * `clock` is injected so tests can pin the timestamps stamped on attempt transitions.
 *
 * `config` is the harness slice — the chain reads `maxTurns` to bound the gen-eval loop. It is a
 * snapshot frozen at launch; the chain factory derives a Promise-shaped `readConfig` accessor from
 * it (its consumers `await` the value), but the snapshot is never mutated, so a mid-run settings
 * edit only takes effect on the next launch — not on the next iteration.
 *
 * Working-tree integrations: `gitRunner` (preflight + commit), `shellScriptRunner` (setup +
 * post-task verify), `fileLocker` + `locksRoot` (per-repository serialisation against
 * concurrent runs).
 */
export interface ImplementDeps {
  readonly sprintRepo: SprintRepository;
  readonly sprintExecutionRepo: SprintExecutionRepository;
  readonly taskRepo: TaskRepository;
  /**
   * Generator-role provider — drives the generator leaf of every gen-eval turn. Built by the
   * launcher from `settings.ai.implement.generator`. May share an instance with
   * {@link evaluatorProvider} when both roles target the same provider; the per-call cost of a
   * fresh adapter is negligible, so the launcher constructs one per role unconditionally.
   */
  readonly generatorProvider: HeadlessAiProvider;
  /**
   * Evaluator-role provider — drives the evaluator leaf of every gen-eval turn. Built from
   * `settings.ai.implement.evaluator`. Separate from {@link generatorProvider} so the two
   * roles can run on different providers (e.g. Claude generator + Codex evaluator).
   */
  readonly evaluatorProvider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly signals: HarnessSignalSink;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly clock: () => IsoTimestamp;
  readonly config: { readonly harness: IterationConfig };
  readonly gitRunner: GitRunner;
  readonly shellScriptRunner: ShellScriptRunner;
  readonly fileLocker: FileLocker;
  readonly locksRoot: AbsolutePath;
  readonly skillsAdapter: SkillsAdapter;
  readonly skillSource: SkillSource;
  /**
   * Used by `resolveBranchLeaf` on the first run of an implement chain to ask the user how to
   * pin the working tree: keep the current branch, auto-generate `ralphctl/<sprint-id>`, or
   * type a custom name. Subsequent runs reuse the persisted decision and skip the prompt.
   */
  readonly interactive: InteractivePrompt;
  /**
   * Atomic file writer — used by gen-eval leaves to write harness-rendered sidecars
   * (commit-message, evaluation.md) post-spawn. Production wires the tmp+rename adapter.
   */
  readonly writeFile: WriteFile;
  /**
   * Append-only writer — used by `append-journal-separator-leaf` to grow `<sprintDir>/progress.md`
   * (audit-[07]). The `progress-journal-leaf` uses {@link writeFile} instead (read-regenerate-write,
   * guarded by {@link journalMutex}).
   */
  readonly appendFile: AppendFile;
  /**
   * Mutex guarding `progress-journal-<taskId>`'s read → regenerate-header → append-section →
   * write critical section on `<sprintDir>/progress.md`. Built once per run by the launcher, so on
   * the parallel wave path every branch inherits the SAME instance (branches spread this deps bag)
   * and their journal leaves never race the shared sprint journal file; the serial path is a single
   * caller that never contends with itself. See `wave-branch.ts`'s `FoldQueue`/`createFoldQueue`.
   */
  readonly journalMutex: FoldQueue;
}
