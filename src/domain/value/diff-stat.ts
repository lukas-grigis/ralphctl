/** Size of a diff: files touched and line counts. `partial` marks a stat that left untracked files out. */
export interface DiffStat {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly partial?: true;
}

/** `5 files +142 -38`, `1 file +0 -0`; a partial stat gains ` (tracked files only)`. */
export const formatDiffStat = (s: DiffStat): string => {
  const files = `${String(s.files)} ${s.files === 1 ? 'file' : 'files'}`;
  const base = `${files} +${String(s.insertions)} -${String(s.deletions)}`;
  return s.partial === true ? `${base} (tracked files only)` : base;
};
