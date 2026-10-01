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
