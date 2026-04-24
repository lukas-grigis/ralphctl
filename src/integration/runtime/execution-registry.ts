/**
 * In-memory `ExecutionRegistryPort` adapter.
 *
 * Each active or terminal execution is tracked in a `Map<executionId, Entry>`.
 * An `Entry` bundles everything the scope needs (scoped signal bus, scoped log
 * event bus, abort controller, pipeline promise) plus the public
 * `RunningExecution` snapshot that callers see through `get` / `list` /
 * listeners.
 *
 * Change notifications follow the `InMemorySignalBus` pattern: a `Set` of
 * listeners fired on every transition (start / complete / fail / cancel).
 * Unlike the signal bus, listener calls are not batched — execution
 * transitions are rare events (seconds to minutes apart), so a per-event
 * dispatch is clearer and has negligible cost.
 *
 * One-per-project rule: `start()` throws `ExecutionAlreadyRunningError`
 * synchronously when the target project already has a `running` entry. The
 * throw happens before any registry state mutation so a rejection leaves the
 * map untouched (verified by `execution-registry.test.ts`).
 */

import { randomUUID } from 'node:crypto';
import type {
  ExecutionListener,
  ExecutionRegistryPort,
  ExecutionStatus,
  RunningExecution,
  StartExecutionParams,
  Unsubscribe,
} from '@src/business/ports/execution-registry.ts';
import { ExecutionAlreadyRunningError, StepError } from '@src/domain/errors.ts';
import type { ExecutionSummary } from '@src/business/usecases/execute.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus.ts';
import type { LogEventBus } from '@src/business/ports/log-event-bus.ts';
import type { SharedDeps } from '@src/integration/shared-deps.ts';
import { InMemorySignalBus } from '@src/integration/signals/bus.ts';
import { InMemoryLogEventBus } from '@src/integration/ui/tui/runtime/event-bus.ts';
import { createExecutionScope } from './execution-scope.ts';

interface Entry {
  execution: RunningExecution;
  signalBus: InMemorySignalBus;
  logEventBus: LogEventBus;
  abortController: AbortController;
  pipelinePromise: Promise<void>;
}

/**
 * Indirection seam so tests can inject a synthetic runner without spawning
 * the full execute pipeline + forEachTask scheduler, and so the composition
 * root in `src/application/shared.ts` wires the real execute pipeline without
 * forcing an application-layer import into the integration adapter (which
 * would violate the layer fence). The runner returns the pipeline's
 * `ExecutionSummary`, or `null` when the pipeline short-circuits without one.
 */
export type PipelineRunner = (
  scopedShared: SharedDeps,
  params: {
    sprintId: string;
    options: StartExecutionParams['options'];
    abortSignal: AbortSignal;
  }
) => Promise<ExecutionSummary | null>;

export interface InMemoryExecutionRegistryOptions {
  baseShared: SharedDeps;
  /** Runner that drives the per-execution pipeline end-to-end. */
  runner: PipelineRunner;
  /** Override hook used by tests — defaults to `randomUUID()`. */
  generateId?: () => string;
  /** Override hook used by tests — defaults to `new AbortController()`. */
  createAbortController?: () => AbortController;
}

export class InMemoryExecutionRegistry implements ExecutionRegistryPort {
  private readonly baseShared: SharedDeps;
  private readonly runner: PipelineRunner;
  private readonly generateId: () => string;
  private readonly createAbortController: () => AbortController;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<ExecutionListener>();

  constructor(options: InMemoryExecutionRegistryOptions) {
    this.baseShared = options.baseShared;
    this.runner = options.runner;
    this.generateId = options.generateId ?? ((): string => randomUUID());
    this.createAbortController = options.createAbortController ?? ((): AbortController => new AbortController());
  }

  async start(params: StartExecutionParams): Promise<RunningExecution> {
    const sprint = await this.baseShared.persistence.getSprint(params.sprintId);
    const project = await this.baseShared.persistence.getProjectById(sprint.projectId);

    // One-per-project check must precede any registry mutation so a rejection
    // leaves the map untouched — tests assert this invariant.
    const existing = this.findRunningForProject(project.name);
    if (existing) {
      throw new ExecutionAlreadyRunningError(project.name, existing.id);
    }

    const executionId = this.generateId();
    const signalBus = new InMemorySignalBus();
    const logEventBus = new InMemoryLogEventBus();
    const abortController = this.createAbortController();

    const scopedShared = createExecutionScope(this.baseShared, {
      executionId,
      logEventBus,
      signalBus,
      abortController,
    });

    const execution: RunningExecution = {
      id: executionId,
      projectName: project.name,
      sprintId: sprint.id,
      sprint,
      status: 'running',
      startedAt: new Date(),
    };

    const entry: Entry = {
      execution,
      signalBus,
      logEventBus,
      abortController,
      // Lazy-initialised below; `runner` needs the entry to exist in the map
      // before it starts emitting so listeners can observe early signals.
      pipelinePromise: Promise.resolve(),
    };
    this.entries.set(executionId, entry);
    this.notify(execution);

    entry.pipelinePromise = this.runPipeline(executionId, scopedShared, params, abortController.signal);

    return execution;
  }

  private async runPipeline(
    executionId: string,
    scopedShared: SharedDeps,
    params: StartExecutionParams,
    abortSignal: AbortSignal
  ): Promise<void> {
    try {
      const summary = await this.runner(scopedShared, {
        sprintId: params.sprintId,
        options: params.options,
        abortSignal,
      });
      if (abortSignal.aborted) {
        this.transition(executionId, 'cancelled', summary ?? undefined);
      } else {
        this.transition(executionId, 'completed', summary ?? undefined);
      }
    } catch (err) {
      // A rejected pipeline after cancellation should still read as cancelled —
      // e.g. when the runner throws because the abort interrupted a step.
      // Cancellation is not a failure: don't forward the error.
      if (abortSignal.aborted) {
        this.transition(executionId, 'cancelled');
        return;
      }

      const errInfo: RunningExecution['error'] =
        err instanceof StepError
          ? { message: err.message, stepName: err.stepName }
          : { message: err instanceof Error ? err.message : String(err) };

      // Publish the error to the scoped LogEventBus so a live <LogTail />
      // shows it alongside the terminal banner.
      const entry = this.entries.get(executionId);
      entry?.logEventBus.emit({
        kind: 'log',
        level: 'error',
        message: errInfo.stepName ? `[${errInfo.stepName}] ${errInfo.message}` : errInfo.message,
        context: {},
        timestamp: new Date(),
      });

      this.transition(executionId, 'failed', undefined, errInfo);
    }
  }

  get(id: string): RunningExecution | null {
    return this.entries.get(id)?.execution ?? null;
  }

  list(): RunningExecution[] {
    return Array.from(this.entries.values(), (entry) => entry.execution);
  }

  cancel(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.execution.status !== 'running') return;
    entry.abortController.abort();
  }

  subscribe(listener: ExecutionListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSignalBus(id: string): SignalBusPort | null {
    return this.entries.get(id)?.signalBus ?? null;
  }

  getLogEventBus(id: string): LogEventBus | null {
    return this.entries.get(id)?.logEventBus ?? null;
  }

  private transition(
    executionId: string,
    status: ExecutionStatus,
    summary?: ExecutionSummary,
    error?: RunningExecution['error']
  ): void {
    const entry = this.entries.get(executionId);
    if (!entry) return;
    if (entry.execution.status === status) return;
    const next: RunningExecution = {
      ...entry.execution,
      status,
      endedAt: new Date(),
      summary: summary ?? entry.execution.summary,
      error: error ?? entry.execution.error,
    };
    entry.execution = next;
    this.notify(next);
  }

  private findRunningForProject(projectName: string): RunningExecution | null {
    for (const entry of this.entries.values()) {
      if (entry.execution.projectName === projectName && entry.execution.status === 'running') {
        return entry.execution;
      }
    }
    return null;
  }

  private notify(execution: RunningExecution): void {
    for (const listener of this.listeners) {
      try {
        listener(execution);
      } catch {
        // Swallow listener errors — a broken subscriber must not stall
        // notifications to siblings or stop the registry from progressing.
      }
    }
  }
}
