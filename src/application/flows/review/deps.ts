import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { HarnessSignalSink } from '@src/integration/ai/signals/_engine/sink.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { FileLocker } from '@src/integration/io/file-locker.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';

export interface ReviewDeps {
  readonly sprintRepo: SprintRepository;
  readonly taskRepo: TaskRepository;
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly signals: HarnessSignalSink;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly clock: () => IsoTimestamp;
  readonly interactive: InteractivePrompt;
  readonly gitRunner: GitRunner;
  readonly shellScriptRunner: ShellScriptRunner;
  readonly fileLocker: FileLocker;
  readonly locksRoot: AbsolutePath;
  /** Append adapter — threaded into `reviewRoundLeaf` to grow `feedback.md` per round. */
  readonly appendFile: AppendFile;
  /** `<dataRoot>/runs` — per-round forensic dirs land under `<runsRoot>/apply-feedback/<run-id>/`. */
  readonly runsRoot: AbsolutePath;
  readonly model: string;
}
