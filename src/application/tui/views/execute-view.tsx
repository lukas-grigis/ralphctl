/**
 * ExecuteView — live execution dashboard for a single chain session.
 *
 * Layout top-to-bottom:
 *   1. Header — session label + status chip (updates to DONE/FAILED/ABORTED
 *      when the runner emits a terminal event)
 *   2. Terminal result card — rendered when the chain settles, with next-step
 *      suggestions derived from the flow type in the session label.
 *   3. Step trace — every step entry as it completes (progressive).
 *   4. Per-task DAG cards — tasks from ctx, ordered by dependency depth,
 *      with live activity signals per task.
 *   5. Rate-limit banner — visible when the session emits a
 *      `rate-limit-paused` event.
 *   6. Log tail — rolling recent events from the global log bus.
 *   7. Feedback prompt loop — fires after a successful execute session.
 *
 * View-local hints:
 *   Esc  background session
 *   Tab  next session (global)
 *   k    kill current session
 *
 * Auto-attach: on mount the view foregrounds the most recent session when
 * no explicit `sessionId` prop is given.
 *
 * Late-subscriber guarantee: `ChainRunner.subscribe()` replays the full
 * trace + terminal event synchronously on attach, so the view recovers
 * correctly when navigating back to a completed session.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useViewInput } from './use-view-input.ts';
import { inkColors, spacing, glyphs } from '@src/integration/ui/theme/tokens.ts';
import { ViewShell } from '@src/application/tui/components/view-shell.tsx';
import { ResultCard } from '@src/application/tui/components/result-card.tsx';
import { Spinner } from '@src/application/tui/components/spinner.tsx';
import { StatusChip, chipKindForSessionStatus } from '@src/application/tui/components/status-chip.tsx';
import { RateLimitBanner } from '@src/application/tui/components/rate-limit-banner.tsx';
import { HeaderHeartbeat } from '@src/application/tui/components/execute/header-heartbeat.tsx';
import { StepTrace } from '@src/application/tui/components/execute/step-trace.tsx';
import { TaskExecutionGrid } from '@src/application/tui/components/execute/task-execution-grid.tsx';
import { RecentEventsTail } from '@src/application/tui/components/execute/recent-events-tail.tsx';
import { FeedbackPromptLoop } from '@src/application/tui/components/execute/feedback-prompt-loop.tsx';
import { FlowContextLine, nextStepsForFlow } from '@src/application/tui/components/execute/flow-context-line.tsx';
import { getTaskList, buildTaskNameLookup } from '@src/application/tui/components/execute/ctx-helpers.ts';
import { useViewHints } from './view-hints-context.tsx';
import { useRouterOptional } from './router-context.ts';
import { useLoggerEvents } from '@src/application/tui/runtime/hooks.ts';
import { getKeyFor } from '@src/application/tui/keyboard-map.ts';
import { getPrompt, getSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import { PromptCancelledError } from '@src/business/ports/prompt-port.ts';
import type { SessionManagerPort, SessionDescriptor } from '@src/application/runtime/session-manager-port.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus-port.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import type { ChainRunnerEvent } from '@src/kernel/runtime/chain-runner.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import type { LiveStep } from '@src/application/tui/components/execute/step-trace.tsx';

// ── Hint sets ─────────────────────────────────────────────────────────────────

const EXECUTE_HINTS_RUNNING_DETACHABLE = [
  { key: 'Esc', action: 'back' },
  { key: getKeyFor('execute.cancel'), action: 'cancel run' },
  { key: getKeyFor('execute.detach'), action: 'background (keep running)' },
] as const;

const EXECUTE_HINTS_RUNNING_FOREGROUND = [{ key: 'Esc', action: 'back' }] as const;

const EXECUTE_HINTS_TERMINAL = [
  { key: 'Enter', action: 'back' },
  { key: 'Esc', action: 'back' },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Heuristic: per-task child steps inside an execute chain are named `task-<id>`. */
function isTaskStep(name: string): boolean {
  return /^task-[a-zA-Z0-9_-]+$/.test(name);
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  readonly sessionId?: string;
  readonly sessionManager: SessionManagerPort | null;
  /**
   * Optional signal bus for live rate-limit pause/resume events + per-task
   * activity signals. When absent, a step-name heuristic is used for
   * rate-limit detection and no activity signals are shown.
   */
  readonly signalBus?: SignalBusPort | null;
}

// ── Main component ────────────────────────────────────────────────────────────

export function ExecuteView({ sessionId, sessionManager, signalBus }: Props): React.JSX.Element {
  const router = useRouterOptional();
  const cancelInFlight = useRef(false);

  // ── Session resolution ────────────────────────────────────────────────────

  const resolveId = (): string | undefined => {
    if (sessionId) return sessionId;
    if (!sessionManager) return undefined;
    const active = sessionManager.active;
    if (active) return active.id;
    const all = sessionManager.list();
    return all[all.length - 1]?.id;
  };

  const [effectiveId, setEffectiveId] = useState<string | undefined>(resolveId);
  const [descriptor, setDescriptor] = useState<SessionDescriptor | null>(() => {
    const id = resolveId();
    if (!id || !sessionManager) return null;
    return sessionManager.get(id) ?? null;
  });

  // Auto-foreground most recent session on mount when no explicit sessionId.
  useEffect(() => {
    if (sessionId || !sessionManager) return;
    const all = sessionManager.list();
    if (all.length === 0) return;
    if (!sessionManager.active) {
      const last = all[all.length - 1];
      if (last) {
        sessionManager.foreground(last.id);
        setEffectiveId(last.id);
      }
    }
  }, [sessionId, sessionManager]);

  // Subscribe to session-manager events to track descriptor changes.
  useEffect(() => {
    if (!sessionManager) return;
    const resolveAndApply = (): void => {
      const resolved = sessionId ?? sessionManager.active?.id ?? sessionManager.list().slice(-1)[0]?.id;
      if (resolved) {
        setDescriptor(sessionManager.get(resolved) ?? null);
        setEffectiveId((prev) => (prev === resolved ? prev : resolved));
      } else {
        setDescriptor(null);
      }
    };
    resolveAndApply();
    return sessionManager.subscribe(resolveAndApply);
  }, [sessionId, sessionManager]);

  // ── Per-session log tail ──────────────────────────────────────────────────

  const logs = useLoggerEvents({ max: 50, sessionId: effectiveId });

  // ── Step trace + rate-limit state ─────────────────────────────────────────

  const [steps, setSteps] = useState<LiveStep[]>([]);
  const [rateLimitVisible, setRateLimitVisible] = useState(false);
  const [rateLimitResumeAt, setRateLimitResumeAt] = useState<IsoTimestamp | null>(null);

  // Track terminal status from the runner's own event stream. The SessionManager
  // descriptor is frozen at creation and never updated by the manager, so we
  // override descriptor.status for rendering once the runner settles.
  const [runnerStatus, setRunnerStatus] = useState<'completed' | 'failed' | 'aborted' | null>(null);

  const runnerRef = descriptor?.runner;
  useEffect(() => {
    if (!runnerRef) {
      setSteps([]);
      setRunnerStatus(null);
      return;
    }
    setSteps([]);
    setRunnerStatus(null);
    const runner = runnerRef;

    const unsub = runner.subscribe((event: ChainRunnerEvent<unknown>) => {
      if (event.type === 'step') {
        const entry = event.entry;
        setSteps((prev) => {
          const idx = prev.findIndex((s) => s.name === entry.stepName && s.status === undefined);
          const settled: LiveStep = {
            name: entry.stepName,
            status: entry.status,
            durationMs: entry.durationMs,
            errorMessage: entry.error?.message,
          };
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = settled;
            return next;
          }
          return [...prev, settled];
        });
        // Rate-limit heuristic fallback when no signalBus is wired.
        if (signalBus === undefined || signalBus === null) {
          if (entry.stepName === 'rate-limit-paused') setRateLimitVisible(true);
          if (entry.stepName === 'rate-limit-resumed') setRateLimitVisible(false);
        }
      }
      if (event.type === 'started') {
        setSteps([]);
        setRateLimitVisible(false);
        setRunnerStatus(null);
      }
      if (event.type === 'completed' || event.type === 'failed' || event.type === 'aborted') {
        setRunnerStatus(event.type);
        setRateLimitVisible(false);
        setRateLimitResumeAt(null);
      }
    });
    return unsub;
  }, [runnerRef, signalBus]);

  // SignalBus — rate-limit events (authoritative) + per-task signal map.
  const [taskSignals, setTaskSignals] = useState<Map<string, HarnessSignal>>(new Map());

  useEffect(() => {
    if (!signalBus) return;
    const unsub = signalBus.subscribe((event) => {
      if (effectiveId !== undefined && event.sessionId !== undefined && event.sessionId !== effectiveId) return;
      if (event.type === 'rate-limit-paused') {
        setRateLimitVisible(true);
        setRateLimitResumeAt(event.resumeAt ?? null);
        return;
      }
      if (event.type === 'rate-limit-resumed') {
        setRateLimitVisible(false);
        setRateLimitResumeAt(null);
        return;
      }
      if (event.type === 'signal' && event.taskId !== undefined) {
        const taskId = String(event.taskId);
        setTaskSignals((prev) => {
          const next = new Map(prev);
          next.set(taskId, event.signal);
          return next;
        });
      }
    });
    return unsub;
  }, [signalBus, effectiveId]);

  // ── Effective terminal state ──────────────────────────────────────────────

  const effectiveStatusForHooks = runnerStatus ?? descriptor?.status ?? 'idle';
  const isTerminalEffective =
    effectiveStatusForHooks === 'completed' ||
    effectiveStatusForHooks === 'failed' ||
    effectiveStatusForHooks === 'aborted';

  const runningHints =
    descriptor?.detachable === false ? EXECUTE_HINTS_RUNNING_FOREGROUND : EXECUTE_HINTS_RUNNING_DETACHABLE;
  useViewHints(isTerminalEffective ? EXECUTE_HINTS_TERMINAL : runningHints);

  // ── Cancel handler ────────────────────────────────────────────────────────

  const KEY_CANCEL = getKeyFor('execute.cancel');
  const KEY_DETACH = getKeyFor('execute.detach');

  const handleCancel = useCallback(async (): Promise<void> => {
    if (cancelInFlight.current) return;
    if (!effectiveId || !sessionManager) return;
    cancelInFlight.current = true;
    try {
      const prompt = await getPrompt();
      const ok = await prompt.confirm({ message: 'Cancel running task and mark blocked?', default: false });
      if (!ok) return;
      sessionManager.kill(effectiveId);
    } catch (err) {
      if (!(err instanceof PromptCancelledError)) {
        void getSharedDeps().then(({ logger }) => {
          logger.warn('execute-view: cancel prompt error', {
            message: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } finally {
      cancelInFlight.current = false;
    }
  }, [effectiveId, sessionManager]);

  useViewInput((input, key) => {
    if (
      input === KEY_CANCEL &&
      effectiveId &&
      sessionManager &&
      !isTerminalEffective &&
      descriptor?.detachable !== false
    ) {
      void handleCancel();
      return;
    }
    if (input === KEY_DETACH) {
      if (descriptor?.detachable === false || isTerminalEffective) return;
      router?.pop();
      return;
    }
    if (key.return && isTerminalEffective) {
      router?.pop();
    }
  });

  // ── No session ────────────────────────────────────────────────────────────

  if (!descriptor) {
    return (
      <ViewShell title="EXECUTE">
        <Spinner label="Awaiting session…" />
      </ViewShell>
    );
  }

  const effectiveStatus = effectiveStatusForHooks;
  const isRunning = effectiveStatus === 'running' || effectiveStatus === 'idle';
  const mainSteps = steps.filter((s) => !isTaskStep(s.name));
  const taskList = getTaskList(descriptor.runner.ctx);
  const taskNameLookup = buildTaskNameLookup(taskList);

  return (
    <ViewShell title="EXECUTE">
      <Box flexDirection="column">
        {/* ── Header ─────────────────────────────────────────────────── */}
        <Box marginBottom={spacing.section} flexDirection="column">
          <Box>
            <StatusChip label={effectiveStatus} kind={chipKindForSessionStatus(effectiveStatus)} />
            <Text color={inkColors.highlight} bold>{`  ${descriptor.label}`}</Text>
            {isRunning ? <HeaderHeartbeat /> : null}
          </Box>
          <FlowContextLine label={descriptor.label} />
        </Box>

        {/* ── Terminal result cards ───────────────────────────────────── */}
        {isTerminalEffective && effectiveStatus === 'completed' ? (
          <ResultCard
            kind="success"
            title="Completed"
            nextSteps={nextStepsForFlow(descriptor.label, 'completed', steps)}
          />
        ) : isTerminalEffective && effectiveStatus === 'failed' ? (
          <ResultCard
            kind="error"
            title="Failed"
            lines={['Check the step trace for details']}
            nextSteps={nextStepsForFlow(descriptor.label, 'failed', steps)}
          />
        ) : isTerminalEffective && effectiveStatus === 'aborted' ? (
          <ResultCard kind="warning" title="Aborted" nextSteps={nextStepsForFlow(descriptor.label, 'aborted', steps)} />
        ) : null}

        {/* ── Step trace ─────────────────────────────────────────────── */}
        <Box marginTop={spacing.section} flexDirection="column">
          <Text dimColor bold>
            {glyphs.badge} Steps
          </Text>
          <Box marginTop={0}>
            <StepTrace steps={mainSteps} isRunning={isRunning} />
          </Box>
        </Box>

        {/* ── Per-task DAG cards ──────────────────────────────────────── */}
        <TaskExecutionGrid
          tasks={taskList}
          taskNameLookup={taskNameLookup}
          taskSignals={taskSignals.size > 0 ? taskSignals : null}
        />

        {/* ── Rate-limit banner ───────────────────────────────────────── */}
        <RateLimitBanner visible={rateLimitVisible} resumeAt={rateLimitResumeAt} />

        {/* ── Log tail ────────────────────────────────────────────────── */}
        <RecentEventsTail events={logs} />

        {/* ── Post-execute feedback loop (side-effect only, no output) ── */}
        <FeedbackPromptLoop descriptor={descriptor} sessionManager={sessionManager} runnerStatus={runnerStatus} />
      </Box>
    </ViewShell>
  );
}
