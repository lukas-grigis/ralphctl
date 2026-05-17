import { describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { CommitSha } from '@src/domain/value/commit-sha.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { Slug } from '@src/domain/value/slug.ts';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
import { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { TaskId } from '@src/domain/value/id/task-id.ts';
import { TicketId } from '@src/domain/value/id/ticket-id.ts';

describe('Slug', () => {
  it('accepts valid slugs', () => {
    for (const s of ['a', 'a-b-c', 'a1', '0', 'long-name-1']) {
      expect(Slug.parse(s).ok).toBe(true);
    }
  });
  it('rejects bad shapes', () => {
    for (const s of ['', '-x', 'x-', 'A', 'a_b', ' ', 'a'.repeat(65)]) {
      expect(Slug.parse(s).ok).toBe(false);
    }
  });
});

describe.each([
  ['ProjectId', ProjectId],
  ['RepositoryId', RepositoryId],
  ['SprintId', SprintId],
  ['TaskId', TaskId],
  ['TicketId', TicketId],
] as const)('%s (UUIDv7)', (_name, idType) => {
  it('generate → parse round-trips', () => {
    for (let i = 0; i < 20; i++) {
      const id = idType.generate();
      expect(idType.parse(id).ok).toBe(true);
    }
  });
  it('rejects non-UUIDv7 strings', () => {
    for (const s of ['', 'not-a-uuid', '00000000-0000-0000-0000-000000000000', 'demo-proj']) {
      expect(idType.parse(s).ok).toBe(false);
    }
  });
});

describe('IsoTimestamp', () => {
  it('accepts ISO 8601 with offset', () => {
    expect(IsoTimestamp.parse('2026-04-29T14:15:22Z').ok).toBe(true);
    expect(IsoTimestamp.parse('2026-04-29T14:15:22+02:00').ok).toBe(true);
  });
  it('rejects offset-less ISO', () => {
    expect(IsoTimestamp.parse('2026-04-29T14:15:22').ok).toBe(false);
  });
});

describe('AbsolutePath', () => {
  it('accepts unix absolute paths', () => {
    expect(AbsolutePath.parse('/tmp/x').ok).toBe(true);
  });
  it('rejects ~, $VAR, relative', () => {
    expect(AbsolutePath.parse('~/foo').ok).toBe(false);
    expect(AbsolutePath.parse('$HOME/foo').ok).toBe(false);
    expect(AbsolutePath.parse('${HOME}/foo').ok).toBe(false);
    expect(AbsolutePath.parse('relative').ok).toBe(false);
  });
});

describe('CommitSha', () => {
  it('accepts 40 lowercase hex', () => {
    expect(CommitSha.parse('a'.repeat(40)).ok).toBe(true);
  });
  it('rejects shorter / uppercase / non-hex', () => {
    expect(CommitSha.parse('a'.repeat(7)).ok).toBe(false);
    expect(CommitSha.parse('A'.repeat(40)).ok).toBe(false);
    expect(CommitSha.parse('z'.repeat(40)).ok).toBe(false);
  });
});
