import type { TaskEpisode } from '@src/domain/repository/episode/episode-types.ts';

/** Maximum characters from the goal shown per episode line before ellipsis is appended. */
const GOAL_MAX_CHARS = 80;

const excerptGoal = (goal: string): string => {
  const trimmed = goal.trim();
  if (trimmed.length <= GOAL_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, GOAL_MAX_CHARS).trimEnd()}…`;
};

/**
 * Render a compact markdown bullet list of the most-recent episodes (up to `maxItems`).
 *
 * Each line is formatted as:
 *   `- [goal excerpt] → outcome (keyLearnings)`
 *
 * Returns an empty string when `episodes` is empty so callers can collapse the section
 * cleanly without a stray heading. Pure function — no I/O.
 *
 * @public
 */
export const summariseEpisodes = (episodes: readonly TaskEpisode[], maxItems = 5): string => {
  if (episodes.length === 0) return '';
  const recent = episodes.slice(-maxItems);
  return recent.map((ep) => `- ${excerptGoal(ep.goal)} → ${ep.outcome} (${ep.keyLearnings.trim()})`).join('\n');
};
