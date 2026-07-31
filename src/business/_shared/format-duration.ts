/**
 * Human-readable duration formatting — shared by every renderer that reports an elapsed-time
 * field (journal entries, round outcomes, …). Lives under `business/_shared/` per the business
 * sibling-isolation rule's own allow-list (each `business/<module>/` is independent; `_shared/`
 * is the sanctioned cross-module seam), rather than duplicated per module.
 *
 * Pure — same input always produces the same string.
 */

const EM_DASH = '—';

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** `undefined` → em-dash. Sub-second → milliseconds. Otherwise the coarsest unit that fits. */
export const formatDuration = (ms: number | undefined): string => {
  if (ms === undefined) return EM_DASH;
  if (ms < 0) return `${String(ms)}ms`;
  if (ms < MS_PER_SECOND) return `${String(ms)}ms`;
  if (ms < MS_PER_MINUTE) {
    return `${String(Math.floor(ms / MS_PER_SECOND))}s`;
  }
  if (ms < MS_PER_HOUR) {
    const minutes = Math.floor(ms / MS_PER_MINUTE);
    const seconds = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND);
    return seconds > 0 ? `${String(minutes)}m ${String(seconds)}s` : `${String(minutes)}m`;
  }
  const hours = Math.floor(ms / MS_PER_HOUR);
  const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  return minutes > 0 ? `${String(hours)}h ${String(minutes)}m` : `${String(hours)}h`;
};
