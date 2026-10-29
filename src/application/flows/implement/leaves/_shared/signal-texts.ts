import type { AiSignal, LearningEntry } from '@src/domain/signal.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/** The narrative signal kinds a generator-shaped session emits, as per-kind text lists. */
export interface SignalTexts {
  readonly decisionsEmitted: readonly string[];
  readonly changesEmitted: readonly string[];
  readonly learningsEmitted: readonly LearningEntry[];
  readonly notesEmitted: readonly string[];
}

export const signalTexts = (signals: readonly AiSignal[]): SignalTexts => ({
  decisionsEmitted: signals.flatMap((s) => (s.type === 'decision' ? [s.text] : [])),
  changesEmitted: signals.flatMap((s) => (s.type === 'change' ? [s.text] : [])),
  learningsEmitted: signals.flatMap((s) =>
    s.type === 'learning'
      ? [
          {
            text: s.text,
            ...(s.context !== undefined ? { context: s.context } : {}),
            ...(s.appliesTo !== undefined ? { appliesTo: s.appliesTo } : {}),
          },
        ]
      : []
  ),
  notesEmitted: signals.flatMap((s) => (s.type === 'note' ? [s.text] : [])),
});

const append = <T>(prior: readonly T[] | undefined, items: readonly T[]): readonly T[] => [...(prior ?? []), ...items];

/**
 * Append one round's texts onto the per-attempt ctx accumulators the progress journal reads; a
 * kind with nothing new leaves its field untouched.
 */
export const foldSignalTexts = (ctx: ImplementCtx, t: SignalTexts): Partial<ImplementCtx> => ({
  ...(t.decisionsEmitted.length > 0
    ? { currentAttemptDecisions: append(ctx.currentAttemptDecisions, t.decisionsEmitted) }
    : {}),
  ...(t.changesEmitted.length > 0
    ? { currentAttemptChanges: append(ctx.currentAttemptChanges, t.changesEmitted) }
    : {}),
  ...(t.learningsEmitted.length > 0
    ? { currentAttemptLearnings: append(ctx.currentAttemptLearnings, t.learningsEmitted) }
    : {}),
  ...(t.notesEmitted.length > 0 ? { currentAttemptNotes: append(ctx.currentAttemptNotes, t.notesEmitted) } : {}),
});
