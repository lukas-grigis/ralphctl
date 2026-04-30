/**
 * ExecuteView — live execution dashboard for a single chain session.
 *
 * Layout top-to-bottom:
 *   1. Header — session label + status chip
 *   2. Step trace — every step entry as it completes (progressive).
 *      Steps still in-flight show a spinning glyph; completed ones
 *      show ■/✗/— based on ChainTraceStatus.
 *   3. Per-task sub-grid — when the session is running an execute chain,
 *      child steps named `task-<id>` are rendered separately below the
 *      main trace.  Heuristic: name starts with `task-`.
 *   4. Rate-limit banner — visible when the session emits a
 *      `rate-limit-paused` event (detected via step name prefix heuristic
 *      for now; will be a dedicated event type when the execute chain is
 *      wired into the src runner).
 *   5. Log tail — rolling recent events from the global log bus.
 *
 * View-local hints:
 *   Esc  background session
 *   Tab  next session (global)
 *   k    kill current session
 *
 * Auto-attach: on mount the view foregrounds the most recent session when
 * no explicit `sessionId` prop is given so "launch from home → live
 * progress" is seamless.
 *
 * Late-subscriber guarantee: `ChainRunner.subscribe()` replays the full
 * trace + terminal event synchronously on attach, so the view recovers
 * correctly when navigating back to a completed session.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { inkColors, spacing, glyphs } from '../../../integration/ui/theme/tokens.ts';
import { ViewShell } from '../components/view-shell.tsx';
import { ResultCard } from '../components/result-card.tsx';
import { Spinner } from '../components/spinner.tsx';
import { StatusChip, chipKindForSessionStatus } from '../components/status-chip.tsx';
import { RateLimitBanner } from '../components/rate-limit-banner.tsx';
import { useViewHints } from './view-hints-context.tsx';
import { useRouterOptional } from './router-context.ts';
import { useLoggerEvents } from '../runtime/hooks.ts';
import { getKeyFor } from '../keyboard-map.ts';
import { getPrompt } from '../../bootstrap/get-shared-deps.ts';
import { PromptCancelledError } from '../../../business/ports/prompt-port.ts';
import type { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import type { SessionManagerPort, SessionDescriptor } from '../../runtime/session-manager-port.ts';
import type { SignalBusPort } from '../../../business/ports/signal-bus-port.ts';
import type { ChainTraceEntry } from '../../../kernel/chain/element.ts';
import type { ChainRunnerEvent } from '../../../kernel/runtime/chain-runner.ts';

const EXECUTE_HINTS = [
  { key: 'Esc', action: 'back' },
  { key: getKeyFor('execute.cancel'), action: 'cancel run' },
  { key: getKeyFor('execute.detach'), action: 'background (keep running)' },
] as const;

// ── Step trace types ──────────────────────────────────────────────────────────

/** An entry in the live trace.  `status` is undefined while the step is running. */
interface LiveStep {
  readonly name: string;
  readonly status: ChainTraceEntry['status'] | undefined;
  readonly durationMs: number | undefined;
  readonly errorMessage: string | undefined;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Heuristic: per-task child steps inside an execute chain are named `task-<id>`. */
function isTaskStep(name: string): boolean {
  return /^task-[a-zA-Z0-9_-]+$/.test(name);
}

function stepGlyph(status: ChainTraceEntry['status'] | undefined): React.JSX.Element {
  if (status === undefined)
    return (
      <Text color={inkColors.warning} bold>
        {glyphs.phaseActive}
      </Text>
    );
  if (status === 'completed')
    return (
      <Text color={inkColors.success} bold>
        {glyphs.phaseDone}
      </Text>
    );
  if (status === 'failed')
    return (
      <Text color={inkColors.error} bold>
        {glyphs.cross}
      </Text>
    );
  if (status === 'aborted')
    return (
      <Text color={inkColors.muted} bold>
        {glyphs.emDash}
      </Text>
    );
  // 'skipped'
  return (
    <Text color={inkColors.muted} bold>
      {glyphs.phasePending}
    </Text>
  );
}

function durationLabel(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface StepTraceProps {
  readonly steps: readonly LiveStep[];
  readonly isRunning: boolean;
}

function StepTrace({ steps, isRunning }: StepTraceProps): React.JSX.Element {
  if (steps.length === 0) {
    if (isRunning) return <Spinner label="Starting…" />;
    return <Text dimColor>No steps recorded.</Text>;
  }
  return (
    <Box flexDirection="column">
      {steps.map((step, i) => (
        <Box key={i}>
          {stepGlyph(step.status)}
          <Text bold={step.status === undefined}>{`  ${step.name}`}</Text>
          {step.durationMs !== undefined ? (
            <Text dimColor>{`  ${glyphs.inlineDot} ${durationLabel(step.durationMs)}`}</Text>
          ) : null}
          {step.errorMessage ? <Text color={inkColors.error}>{`  ${glyphs.emDash} ${step.errorMessage}`}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

interface TaskSubGridProps {
  readonly steps: readonly LiveStep[];
}

function TaskSubGrid({ steps }: TaskSubGridProps): React.JSX.Element | null {
  const taskSteps = steps.filter((s) => isTaskStep(s.name));
  if (taskSteps.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={spacing.section}>
      <Text dimColor bold>
        {glyphs.activityArrow} Task execution
      </Text>
      {taskSteps.map((step, i) => (
        <Box key={i} paddingLeft={spacing.indent}>
          {stepGlyph(step.status)}
          <Text>{`  ${step.name}`}</Text>
          {step.durationMs !== undefined ? (
            <Text dimColor>{`  ${glyphs.inlineDot} ${durationLabel(step.durationMs)}`}</Text>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  readonly sessionId?: string;
  readonly sessionManager: SessionManagerPort | null;
  /**
   * Optional signal bus for live rate-limit pause/resume events. When
   * present, the rate-limit banner reflects coordinator state authoritatively.
   * When absent, the legacy heuristic on `rate-limit-paused` step names is
   * used as a best-effort fallback.
   */
  readonly signalBus?: SignalBusPort | null;
}

// ── Main component ────────────────────────────────────────────────────────────

export function ExecuteView({ sessionId, sessionManager, signalBus }: Props): React.JSX.Element {
  useViewHints(EXECUTE_HINTS);
  const router = useRouterOptional();
  const logs = useLoggerEvents(50);
  // Re-entrancy guard for the cancel flow — prevents two confirms when the
  // user mashes the cancel key.
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

  // Auto-foreground most recent session on mount when no explicit sessionId
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

  // Subscribe to session-manager events to track descriptor changes
  useEffect(() => {
    const id = effectiveId;
    if (!id || !sessionManager) return;
    setDescriptor(sessionManager.get(id) ?? null);
    const unsub = sessionManager.subscribe(() => {
      const resolved = sessionId ?? sessionManager.active?.id ?? effectiveId;
      if (resolved) {
        setDescriptor(sessionManager.get(resolved) ?? null);
        if (resolved !== effectiveId) setEffectiveId(resolved);
      }
    });
    return unsub;
  }, [effectiveId, sessionId, sessionManager]);

  // ── Step trace state ──────────────────────────────────────────────────────

  const [steps, setSteps] = useState<LiveStep[]>(() => {
    // Seed from the runner's current trace synchronously so the first render
    // already shows completed steps (important for late-attach to a terminal
    // or near-terminal runner).
    const runner = descriptor?.runner;
    if (!runner) return [];
    return runner.trace.map((entry) => ({
      name: entry.stepName,
      status: entry.status,
      durationMs: entry.durationMs,
      errorMessage: entry.error?.message,
    }));
  });
  const [rateLimitVisible, setRateLimitVisible] = useState(false);
  const [rateLimitResumeAt, setRateLimitResumeAt] = useState<IsoTimestamp | null>(null);

  // Subscribe to the runner for progressive step events.
  // Also handles late-subscriber replay (runner.subscribe is synchronous
  // for terminal runners).
  useEffect(() => {
    if (!descriptor?.runner) {
      setSteps([]);
      return;
    }

    const runner = descriptor.runner;

    // Re-seed when the descriptor (runner) changes — covers cases where
    // the user navigates away and back, landing on a different session.
    setSteps(
      runner.trace.map((entry) => ({
        name: entry.stepName,
        status: entry.status,
        durationMs: entry.durationMs,
        errorMessage: entry.error?.message,
      }))
    );

    const unsub = runner.subscribe((event: ChainRunnerEvent<unknown>) => {
      if (event.type === 'step') {
        const entry = event.entry;
        setSteps((prev) => {
          // Replace the in-flight entry (status undefined) with the settled one,
          // or append if this is a new step.
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

        // Heuristic: detect rate-limit pause/resume via step name. Skipped
        // when a signalBus is wired in — the bus subscription below is
        // authoritative and this fallback would race with it.
        if (signalBus === undefined || signalBus === null) {
          if (entry.stepName === 'rate-limit-paused') setRateLimitVisible(true);
          if (entry.stepName === 'rate-limit-resumed') setRateLimitVisible(false);
        }
      }

      if (event.type === 'started') {
        // A fresh start: clear any stale trace from a previous run
        setSteps([]);
        setRateLimitVisible(false);
      }

      if (event.type === 'completed' || event.type === 'failed' || event.type === 'aborted') {
        // Settle rate-limit banner on any terminal event
        setRateLimitVisible(false);
        setRateLimitResumeAt(null);
      }
    });
    return unsub;
  }, [descriptor, signalBus]);

  // Live rate-limit pause/resume from the signal bus (preferred over the
  // step-name heuristic above when the bus is wired in).
  useEffect(() => {
    if (!signalBus) return;
    const unsub = signalBus.subscribe((event) => {
      if (event.type === 'rate-limit-paused') {
        setRateLimitVisible(true);
        setRateLimitResumeAt(event.resumeAt ?? null);
        return;
      }
      if (event.type === 'rate-limit-resumed') {
        setRateLimitVisible(false);
        setRateLimitResumeAt(null);
      }
    });
    return unsub;
  }, [signalBus]);

  // ── Keyboard handler ─────────────────────────────────────────────────────

  const KEY_CANCEL = getKeyFor('execute.cancel');
  const KEY_DETACH = getKeyFor('execute.detach');

  // Confirm-then-kill flow. Idempotent: while a confirm is in flight a second
  // `c` press is ignored, so the user can't queue a second prompt by mashing.
  const handleCancel = useCallback(async (): Promise<void> => {
    if (cancelInFlight.current) return;
    if (!effectiveId || !sessionManager) return;
    cancelInFlight.current = true;
    try {
      const prompt = await getPrompt();
      const ok = await prompt.confirm({
        message: 'Cancel running task and mark blocked?',
        default: false,
      });
      if (!ok) return;
      // Re-check the descriptor — the run may have settled while the user
      // sat on the prompt, in which case kill is a no-op but harmless.
      sessionManager.kill(effectiveId);
    } catch (err) {
      // PromptCancelledError (Esc / Ctrl+C on the prompt) is silent — user
      // dismissed the confirm. Other errors are unexpected; swallow with a
      // log to avoid taking down the dashboard, since this is interactive UI.
      if (!(err instanceof PromptCancelledError)) {
        console.warn('[execute-view] cancel prompt threw:', err);
      }
    } finally {
      cancelInFlight.current = false;
    }
  }, [effectiveId, sessionManager]);

  useInput((input, key) => {
    // cancel — confirm, then kill the running session
    if (input === KEY_CANCEL && effectiveId && sessionManager) {
      void handleCancel();
      return;
    }
    // detach (uppercase D) — background session and pop view
    if (input === KEY_DETACH) {
      router?.pop();
      return;
    }
    // enter on a terminal state — pop back
    if (key.return && descriptor && descriptor.status !== 'running') {
      router?.pop();
    }
  });

  // ── No session ────────────────────────────────────────────────────────────

  if (!descriptor) {
    return (
      <ViewShell title="EXECUTE">
        <ResultCard
          kind="info"
          title="No active session"
          nextSteps={[{ action: 'Start a sprint from Home', description: "press 'h'" }]}
        />
      </ViewShell>
    );
  }

  const isRunning = descriptor.status === 'running';
  const mainSteps = steps.filter((s) => !isTaskStep(s.name));

  return (
    <ViewShell title="EXECUTE">
      <Box flexDirection="column">
        {/* ── Header ────────────────────────────────────────────────── */}
        <Box marginBottom={spacing.section}>
          <StatusChip label={descriptor.status} kind={chipKindForSessionStatus(descriptor.status)} />
          <Text color={inkColors.highlight} bold>
            {`  ${descriptor.label}`}
          </Text>
        </Box>

        {/* ── Terminal result cards ──────────────────────────────────── */}
        {!isRunning && descriptor.status === 'completed' ? (
          <ResultCard kind="success" title="Session completed" />
        ) : !isRunning && descriptor.status === 'failed' ? (
          <ResultCard kind="error" title="Session failed" lines={['Check the step trace for details']} />
        ) : !isRunning && descriptor.status === 'aborted' ? (
          <ResultCard kind="warning" title="Session aborted" />
        ) : null}

        {/* ── Step trace ────────────────────────────────────────────── */}
        <Box marginTop={spacing.section} flexDirection="column">
          <Text dimColor bold>
            {glyphs.badge} Steps
          </Text>
          <Box marginTop={0}>
            <StepTrace steps={mainSteps} isRunning={isRunning} />
          </Box>
        </Box>

        {/* ── Per-task sub-grid ──────────────────────────────────────── */}
        <TaskSubGrid steps={steps} />

        {/* ── Rate-limit banner ─────────────────────────────────────── */}
        <RateLimitBanner visible={rateLimitVisible} resumeAt={rateLimitResumeAt} />

        {/* ── Log tail ──────────────────────────────────────────────── */}
        {logs.length > 0 ? (
          <Box flexDirection="column" marginTop={spacing.section}>
            <Text dimColor bold>
              {glyphs.activityArrow} Recent events
            </Text>
            {logs.slice(-10).map((event, i) => (
              <Box key={i}>
                <Text color={inkColors.muted} dimColor>
                  {String(event.timestamp).slice(11, 19)}{' '}
                </Text>
                <StatusChip
                  label={event.level}
                  kind={
                    event.level === 'error'
                      ? 'error'
                      : event.level === 'warn'
                        ? 'warning'
                        : event.level === 'info'
                          ? 'info'
                          : 'muted'
                  }
                />
                <Text>{` ${event.message}`}</Text>
              </Box>
            ))}
          </Box>
        ) : null}
      </Box>
    </ViewShell>
  );
}
