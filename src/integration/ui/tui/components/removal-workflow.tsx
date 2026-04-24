/**
 * RemovalWorkflow — shared state machine + UI surface for destructive removal
 * flows (sprint delete, project/repo/ticket/task remove).
 *
 * Every removal view used to repeat the same shape: `useWorkflow` state
 * machine → `getPrompt().confirm(...)` → call the persistence helper → render
 * a terminal `<ResultCard>` inside a `<ViewShell>`. Five copies. This
 * component owns the shared pieces so each caller shrinks to (a) whatever
 * selection / validation it needs to gather the entity, (b) `confirmMessage`
 * copy, (c) the business call (`onConfirm`), and (d) the success message +
 * `onDone` callback that returns to the previous frame.
 *
 * States: `idle → confirming → running → done | error`. The `done` variant
 * carries an `outcome` tag so the Y-path (success) and n-path (declined
 * confirm) both land in a terminal state but render different cards.
 *
 * The confirm prompt fires exactly once — the UI contract requires one
 * confirmation per destructive action. If the user Ctrl+C/Escapes the prompt,
 * `PromptCancelledError` is caught and treated as an immediate `onDone()`
 * (pop back to the parent view) — consistent with `useWorkflow`'s behaviour.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useInput } from 'ink';
import { PromptCancelledError } from '@src/business/ports/prompt.ts';
import { getPrompt } from '@src/integration/bootstrap.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';

type Phase =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'running' }
  | { kind: 'done'; outcome: 'success' | 'cancelled' }
  | { kind: 'error'; message: string };

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'back' },
  { key: 'Esc', action: 'back' },
] as const;

interface RemovalWorkflowProps {
  /** Used as the ViewShell title — e.g. "Delete Sprint", "Remove Project". */
  readonly entityLabel: string;
  /** The single confirm prompt. Should cite the destructive detail (counts, names). */
  readonly confirmMessage: string;
  /** Runs after the user confirms. Throws → error state. */
  readonly onConfirm: () => Promise<void>;
  /** Title shown in the success ResultCard — e.g. "Sprint deleted". */
  readonly successMessage: string;
  /** Fired when the user dismisses the terminal state (Enter). */
  readonly onDone: () => void;
}

export function RemovalWorkflow({
  entityLabel,
  confirmMessage,
  onConfirm,
  successMessage,
  onDone,
}: RemovalWorkflowProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (started) return;
    setStarted(true);
    void (async (): Promise<void> => {
      try {
        setPhase({ kind: 'confirming' });
        const confirmed = await getPrompt().confirm({ message: confirmMessage, default: false });
        if (!confirmed) {
          setPhase({ kind: 'done', outcome: 'cancelled' });
          return;
        }
        setPhase({ kind: 'running' });
        await onConfirm();
        setPhase({ kind: 'done', outcome: 'success' });
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          onDone();
          return;
        }
        setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, [started, confirmMessage, onConfirm, onDone]);

  const terminal = phase.kind === 'done' || phase.kind === 'error';
  const hints = useMemo(() => (terminal ? HINTS_DONE : HINTS_RUNNING), [terminal]);
  useViewHints(hints);

  useInput(
    (_input, key) => {
      if (key.return && terminal) onDone();
    },
    { isActive: terminal }
  );

  return <ViewShell title={entityLabel}>{renderBody(phase, successMessage, entityLabel)}</ViewShell>;
}

function renderBody(phase: Phase, successMessage: string, entityLabel: string): React.JSX.Element {
  switch (phase.kind) {
    case 'idle':
    case 'confirming':
      return <Spinner label="Awaiting confirmation…" />;
    case 'running':
      return <Spinner label={`${entityLabel}…`} />;
    case 'done':
      return phase.outcome === 'success' ? (
        <ResultCard kind="success" title={successMessage} />
      ) : (
        <ResultCard kind="info" title="Removal cancelled" />
      );
    case 'error':
      return <ResultCard kind="error" title={`Could not complete ${entityLabel}`} lines={[phase.message]} />;
  }
}
