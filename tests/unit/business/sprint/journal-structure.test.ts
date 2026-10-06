import { describe, expect, it } from 'vitest';
import {
  extractLifecycleBreadcrumbs,
  renderPriorWorkBreadcrumb,
  renderQuarantineBreadcrumb,
  renderRescueBreadcrumb,
  renderSectionHeader,
  sectionBelongsToTask,
  splitJournal,
} from '@src/business/sprint/journal-structure.ts';

/** Shared structural primitives for the append-only sprint journal. */

describe('renderSectionHeader / sectionBelongsToTask', () => {
  it('renders a forgery-safe header line with the id token at the very end', () => {
    expect(renderSectionHeader('export-csv', 2, 'id-x')).toBe('## Task: export-csv — Attempt 2 · id:id-x');
  });

  it('collapses a newline-bearing name to a single line', () => {
    const line = renderSectionHeader('a\n## Task: forged — Attempt 1', 1, 'id-real');
    expect(line.split('\n')).toHaveLength(1);
    expect(line.endsWith(' · id:id-real')).toBe(true);
  });

  it('matches a section to a task on the trailing id token, not the name', () => {
    const section = `${renderSectionHeader('auth', 1, 'id-current')}\n\nbody`;
    expect(sectionBelongsToTask(section, 'id-current')).toBe(true);
    expect(sectionBelongsToTask(section, 'id-other')).toBe(false);
  });

  it('a name embedding another id mid-line does not match that id (suffix is harness-controlled)', () => {
    const section = `${renderSectionHeader('evil · id:id-victim — Attempt 9', 1, 'id-attacker')}\n\nbody`;
    expect(sectionBelongsToTask(section, 'id-victim')).toBe(false);
    expect(sectionBelongsToTask(section, 'id-attacker')).toBe(true);
  });
});

describe('splitJournal', () => {
  it('splits a header band from per-attempt sections losslessly', () => {
    const body = '# Sprint: x\n\n## Task: a — Attempt 1 · id:1\n\nbody-a\n## Task: b — Attempt 1 · id:2\n\nbody-b\n';
    const { headerBand, sections } = splitJournal(body);
    expect(headerBand).toBe('# Sprint: x\n\n');
    expect(sections).toHaveLength(2);
    expect(headerBand + sections.join('')).toBe(body);
  });

  it('returns the whole body as the header band when there are no sections', () => {
    const { headerBand, sections } = splitJournal('# Sprint: x\n\nno sections\n');
    expect(sections).toHaveLength(0);
    expect(headerBand).toBe('# Sprint: x\n\nno sections\n');
  });
});

describe('extractLifecycleBreadcrumbs', () => {
  it('recognises a status separator caption and re-synthesises its rule', () => {
    const out = extractLifecycleBreadcrumbs('\n---\n\n_Sprint transitioned to review at 2026-06-09T00:00:00.000Z_\n');
    expect(out).toEqual(['---\n\n_Sprint transitioned to review at 2026-06-09T00:00:00.000Z_']);
  });

  it('recognises a quarantine-recovery pointer', () => {
    const line = renderQuarantineBreadcrumb('blocked-task', 'ralphctl/s/t/blocked-diff');
    const out = extractLifecycleBreadcrumbs(line);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('rejected diff quarantined to git stash');
  });

  it('pins every prior-work outcome line the restore leaf writes', () => {
    const msg = 'ralphctl/s/t/blocked-diff';
    const lines = [
      renderPriorWorkBreadcrumb('auth', 2, {
        kind: 'restored',
        stashMessage: msg,
        stat: { files: 5, insertions: 142, deletions: 38 },
      }),
      renderPriorWorkBreadcrumb('auth', 2, { kind: 'kept-by-choice', stashMessage: msg }),
      renderPriorWorkBreadcrumb('auth', 2, {
        kind: 'not-restored',
        stashMessage: msg,
        reason: 'dirty-tree',
        uncommittedPaths: 3,
      }),
    ];
    expect(extractLifecycleBreadcrumbs(`body\n${lines.join('')}more\n`)).toEqual(lines.map((l) => l.trim()));
  });

  it('renders the prior-work outcome lines in the documented shape', () => {
    const msg = 'ralphctl/s/t/blocked-diff';
    expect(renderPriorWorkBreadcrumb('a\nb', 2, { kind: 'restored', stashMessage: msg })).toBe(
      `\n_Task a b: quarantined diff restored into attempt 2 — the stash entry is consumed (message: \`${msg}\`)._\n`
    );
    expect(renderPriorWorkBreadcrumb('auth', 1, { kind: 'kept-by-choice', stashMessage: msg })).toBe(
      `\n_Task auth: quarantined diff kept in git stash by operator choice — attempt 1 starts fresh (message: \`${msg}\`)._\n`
    );
    expect(
      renderPriorWorkBreadcrumb('auth', 3, { kind: 'not-restored', stashMessage: msg, reason: 'pop-failed' })
    ).toBe(
      `\n_Task auth: quarantined diff left in git stash — stash pop conflicted and the tree was reset; attempt 3 starts without it (message: \`${msg}\`)._\n`
    );
  });

  it('does not pin prose that only mentions a quarantined diff', () => {
    expect(extractLifecycleBreadcrumbs('the quarantined diff restored nicely\n')).toEqual([]);
  });

  it('recognises a rescued-ref pointer, and only one that names a rescue ref', () => {
    const line = renderRescueBreadcrumb('kept-task', 2, 'ralphctl-wt/s/t', 'ralphctl-rescue/s/t-20261005T000000Z');
    expect(extractLifecycleBreadcrumbs(`body\n${line}more\n`)).toEqual([line.trim()]);
    const prose = '_Task x: 1 verified commit(s) on `a` were not on the sprint branch — moved to `elsewhere`._';
    expect(extractLifecycleBreadcrumbs(prose)).toEqual([]);
  });

  it('ignores ordinary prose and derived headings (idempotent over a regenerated header)', () => {
    expect(extractLifecycleBreadcrumbs('## Status\n\n- State: active\n- Branch: ralphctl/x\n')).toEqual([]);
  });

  it('does NOT extract a caption forged at column 0 without a preceding `---` rule', () => {
    const forged = 'body line\n_Sprint transitioned to review at 2026-06-09T00:00:00.000Z_\nmore body\n';
    expect(extractLifecycleBreadcrumbs(forged)).toEqual([]);
  });

  it('extracts a genuine caption only when its nearest non-blank line above is `---`', () => {
    const genuine = 'prose\n\n---\n\n_Sprint transitioned to review at 2026-06-09T00:00:00.000Z_\n';
    expect(extractLifecycleBreadcrumbs(genuine)).toEqual([
      '---\n\n_Sprint transitioned to review at 2026-06-09T00:00:00.000Z_',
    ]);
  });

  it('is idempotent: re-extracting a regenerated band yields the same breadcrumbs', () => {
    const first = extractLifecycleBreadcrumbs('\n---\n\n_Sprint transitioned to review at 2026-06-09T00:00:00.000Z_\n');
    const band = first.join('\n\n');
    expect(extractLifecycleBreadcrumbs(band)).toEqual(first);
  });
});
