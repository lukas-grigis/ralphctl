import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';

/** Reports whether a flow run is in flight, in this process or another one. */
export interface RunActivityProbe {
  anyRunActive(): Promise<boolean>;
}

/** The refusal a destructive data operation returns while a run is active. */
export const runActiveRefusal = (attemptedAction: string): InvalidStateError =>
  new InvalidStateError({
    entity: 'data',
    currentState: 'flow running',
    attemptedAction,
    message: 'A flow is running — let it finish (or cancel it) before removing data.',
  });

/** A probe that reports active when any of `probes` does, asking them in order. */
export const anyRunActivity = (...probes: readonly RunActivityProbe[]): RunActivityProbe => ({
  async anyRunActive() {
    for (const probe of probes) {
      if (await probe.anyRunActive()) return true;
    }
    return false;
  },
});
