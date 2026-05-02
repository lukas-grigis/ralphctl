/**
 * Tests for the pure formatter helpers. They render entities into
 * plain-text strings; we assert key tokens are present without coupling
 * to ANSI byte-for-byte output.
 */
import { describe, expect, it } from 'vitest';

import { Project } from '@src/domain/entities/project.ts';
import { Repository } from '@src/domain/entities/repository.ts';
import { Sprint } from '@src/domain/entities/sprint.ts';
import { Task } from '@src/domain/entities/task.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { NotFoundError } from '@src/domain/errors/not-found-error.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { formatError } from './format-error.ts';
import { formatProjectCard, formatProjectLine } from './format-project.ts';
import { formatSprintCard, formatSprintLine, formatSprintStatus } from './format-sprint.ts';
import { formatTaskCard, formatTaskLine, formatTaskStatus } from './format-task.ts';
import { formatDoctorReport, formatCheckRow } from './format-doctor.ts';

function unwrap<T>(r: { ok: boolean; value?: T; error?: unknown }, label: string): T {
  if (!r.ok) throw new Error(`${label}: ${String(r.error)}`);
  return r.value as T;
}

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;

describe('format-sprint', () => {
  it('renders status with color tags', () => {
    expect(formatSprintStatus('draft')).toContain('draft');
    expect(formatSprintStatus('active')).toContain('active');
    expect(formatSprintStatus('closed')).toContain('closed');
  });

  it('renders a one-line summary', () => {
    const sprint = unwrap(
      Sprint.create({
        name: 'Demo',
        slug: unwrap(Slug.parse('demo'), 'slug'),
        now: T0,
        projectName: unwrap(ProjectName.parse('demo'), 'project'),
      }),
      'sprint'
    );
    const line = formatSprintLine(sprint);
    expect(line).toContain('Demo');
    expect(line).toContain(sprint.id);
  });

  it('renders the multi-line card', () => {
    const sprint = unwrap(
      Sprint.create({
        name: 'Demo',
        slug: unwrap(Slug.parse('demo'), 'slug'),
        now: T0,
        projectName: unwrap(ProjectName.parse('demo'), 'project'),
      }),
      'sprint'
    );
    const card = formatSprintCard(sprint);
    expect(card).toContain('Demo');
    expect(card).toContain('id');
    expect(card).toContain('status');
    expect(card).toContain('project');
    expect(card).toContain('demo');
  });
});

describe('format-task', () => {
  it('renders status', () => {
    expect(formatTaskStatus('todo')).toContain('todo');
    expect(formatTaskStatus('done')).toContain('done');
  });

  it('renders a task line', () => {
    const task = unwrap(
      Task.create({
        name: 'Build X',
        steps: [],
        verificationCriteria: [],
        order: 1,
        projectPath: unwrap(AbsolutePath.parse('/tmp/x'), 'path'),
      }),
      'task'
    );
    const line = formatTaskLine(task);
    expect(line).toContain('Build X');
    expect(line).toContain('#1');
  });

  it('renders a task card with steps + criteria', () => {
    const task = unwrap(
      Task.create({
        name: 'Build X',
        steps: ['edit file'],
        verificationCriteria: ['it works'],
        order: 1,
        projectPath: unwrap(AbsolutePath.parse('/tmp/x'), 'path'),
      }),
      'task'
    );
    const card = formatTaskCard(task);
    expect(card).toContain('edit file');
    expect(card).toContain('it works');
  });
});

describe('format-project', () => {
  it('renders one-line and card forms', () => {
    const repo = unwrap(Repository.create({ path: unwrap(AbsolutePath.parse('/tmp/x'), 'path') }), 'repo');
    const project = unwrap(
      Project.create({
        name: unwrap(ProjectName.parse('demo'), 'name'),
        displayName: 'Demo',
        repositories: [repo],
      }),
      'project'
    );
    expect(formatProjectLine(project)).toContain('demo');
    expect(formatProjectCard(project)).toContain('Demo');
    expect(formatProjectCard(project)).toContain('/tmp/x');
  });

  it('shows "not onboarded" suffix for repos without onboardedAt', () => {
    const repo = unwrap(Repository.create({ path: unwrap(AbsolutePath.parse('/tmp/x'), 'path') }), 'repo');
    const project = unwrap(
      Project.create({
        name: unwrap(ProjectName.parse('demo'), 'name'),
        displayName: 'Demo',
        repositories: [repo],
      }),
      'project'
    );
    expect(formatProjectLine(project)).toContain('not onboarded');
    expect(formatProjectCard(project)).toContain('not onboarded');
  });

  it('shows "onboarded YYYY-MM-DD" suffix for onboarded repos', () => {
    const repo = unwrap(
      Repository.create({
        path: unwrap(AbsolutePath.parse('/tmp/x'), 'path'),
        onboardedAt: T0,
      }),
      'repo'
    );
    const project = unwrap(
      Project.create({
        name: unwrap(ProjectName.parse('demo'), 'name'),
        displayName: 'Demo',
        repositories: [repo],
      }),
      'project'
    );
    expect(formatProjectLine(project)).toContain('onboarded');
    const card = formatProjectCard(project);
    expect(card).toContain('onboarded 2026-04-29');
  });

  it('shows N/M onboarded count when project has multiple repos', () => {
    const r1 = unwrap(Repository.create({ path: unwrap(AbsolutePath.parse('/tmp/a'), 'path'), onboardedAt: T0 }), 'r1');
    const r2 = unwrap(Repository.create({ path: unwrap(AbsolutePath.parse('/tmp/b'), 'path') }), 'r2');
    const project = unwrap(
      Project.create({
        name: unwrap(ProjectName.parse('multi'), 'name'),
        displayName: 'Multi',
        repositories: [r1, r2],
      }),
      'project'
    );
    expect(formatProjectLine(project)).toContain('1/2 onboarded');
  });
});

describe('format-error', () => {
  it('renders the error tag, code, and message on the first line', () => {
    const err = new NotFoundError({ entity: 'sprint', id: 'x' });
    const out = formatError(err);
    expect(out).toContain('error');
    expect(out).toContain('not-found');
    expect(out).toContain("sprint 'x' not found");
  });

  it('appends a hint line when the error carries a hint', () => {
    const err = new NotFoundError({
      entity: 'sprint',
      id: 'x',
      hint: 'Run `ralphctl sprint list`.',
    });
    const out = formatError(err);
    expect(out).toMatch(/hint:.*sprint list/);
    expect(out.split('\n').length).toBe(2);
  });

  it('omits the hint line when no hint is present', () => {
    const err = new StorageError({ subCode: 'io', message: 'read failed' });
    const out = formatError(err);
    expect(out).not.toContain('hint:');
    expect(out.split('\n').length).toBe(1);
  });
});

describe('format-doctor', () => {
  it('renders pass/warn/fail/skip rows', () => {
    expect(formatCheckRow({ name: 'a', status: 'pass' })).toContain('PASS');
    expect(formatCheckRow({ name: 'b', status: 'warn', message: 'be careful' })).toContain('WARN');
    expect(formatCheckRow({ name: 'c', status: 'fail' })).toContain('FAIL');
    expect(formatCheckRow({ name: 'd', status: 'skip' })).toContain('SKIP');
  });

  it('renders an aggregate report', () => {
    const ok = formatDoctorReport({
      checks: [{ name: 'a', status: 'pass' }],
      status: 'ok',
    });
    expect(ok).toContain('OK');
    const fail = formatDoctorReport({
      checks: [{ name: 'a', status: 'fail', message: 'broken' }],
      status: 'fail',
    });
    expect(fail).toContain('FAIL');
    expect(fail).toContain('broken');
  });
});
