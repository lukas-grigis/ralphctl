import { describe, expect, it } from 'vitest';
import {
  extractLifecycleBreadcrumbs,
  renderQuarantineBreadcrumb,
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

  it('ignores ordinary prose and derived headings (idempotent over a regenerated header)', () => {
    expect(extractLifecycleBreadcrumbs('## Status\n\n- State: active\n- Branch: ralphctl/x\n')).toEqual([]);
  });
});
