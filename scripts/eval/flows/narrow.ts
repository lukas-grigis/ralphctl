import { Result } from '@src/domain/result.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { EvalFlow } from '../fixture-schema.ts';
import type { Fixture } from '../types.ts';

/** Narrow a loaded fixture to its flow — a mismatch is a wiring bug, surfaced as a typed error. */
export const asFlow = <F extends EvalFlow>(
  fixture: Fixture,
  flow: F
): Result<Extract<Fixture, { flow: F }>, InvalidStateError> =>
  fixture.flow === flow
    ? Result.ok(fixture as Extract<Fixture, { flow: F }>)
    : Result.error(
        new InvalidStateError({
          entity: 'eval-fixture',
          currentState: fixture.flow,
          attemptedAction: `run as ${flow}`,
          message: `fixture '${fixture.id}' is a ${fixture.flow} fixture, not ${flow}`,
        })
      );

/** `AbsolutePath.parse` as a `Result` with the harness's error vocabulary. */
export const absPath = (path: string): Result<AbsolutePath, InvalidStateError> => {
  const parsed = AbsolutePath.parse(path);
  return parsed.ok
    ? Result.ok(parsed.value)
    : Result.error(
        new InvalidStateError({
          entity: 'eval-workspace',
          currentState: path,
          attemptedAction: 'parse absolute path',
          message: `not an absolute path: ${path}`,
        })
      );
};
