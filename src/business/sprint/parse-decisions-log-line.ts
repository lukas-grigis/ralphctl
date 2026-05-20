import type { DecisionEntry } from '@src/business/sprint/state-projection.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Parse one line of `<sprintDir>/decisions.log` into a {@link DecisionEntry}.
 *
 * The on-disk format is positional and space-separated, produced by `decisions-log-sink.ts`:
 *
 *     <iso-timestamp> <task-id-or-?> <commit-sha-or-?> <text...>
 *
 * The first three columns are atomic tokens; everything after the third space is the decision
 * body. The `?` sentinel marks columns the harness couldn't resolve at write time.
 *
 * Returns `undefined` for blank lines or lines that don't have the leading three columns.
 * Pure — no IO, no throws.
 *
 * The chain id is intentionally not on disk — decisions are sprint-scoped, not chain-scoped.
 * The returned {@link DecisionEntry}'s `chainId` is set to the empty string so consumers that
 * group by chain skip it; renderers that fall back to taskId (e.g. `pickDecisionTag` in
 * `render-progress-markdown.ts`) display the meaningful column.
 *
 * @public
 */
export const parseDecisionsLogLine = (line: string): DecisionEntry | undefined => {
  const trimmed = line.trimEnd();
  if (trimmed.length === 0) return undefined;

  const firstSp = trimmed.indexOf(' ');
  if (firstSp === -1) return undefined;
  const secondSp = trimmed.indexOf(' ', firstSp + 1);
  if (secondSp === -1) return undefined;
  const thirdSp = trimmed.indexOf(' ', secondSp + 1);
  if (thirdSp === -1) return undefined;

  const timestamp = trimmed.slice(0, firstSp);
  const taskId = trimmed.slice(firstSp + 1, secondSp);
  const commitSha = trimmed.slice(secondSp + 1, thirdSp);
  const text = trimmed.slice(thirdSp + 1);

  if (timestamp.length === 0 || text.length === 0) return undefined;

  const meta: Record<string, unknown> = {};
  if (taskId !== '?' && taskId.length > 0) meta['taskId'] = taskId;
  if (commitSha !== '?' && commitSha.length > 0) meta['commitSha'] = commitSha;

  return {
    chainId: '',
    at: timestamp as IsoTimestamp,
    message: text,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  };
};
