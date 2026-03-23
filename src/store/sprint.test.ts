import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnvironment } from '@src/test-utils/setup.ts';
import { assertSprintStatus, createSprint, activateSprint, closeSprint, getCurrentSprintOrThrow } from './sprint.ts';
import { SprintStatusError, NoCurrentSprintError } from '@src/errors.ts';
import { setCurrentSprint } from '@src/store/config.ts';
import type { Sprint } from '@src/schemas/index.ts';

let env: TestEnvironment;

beforeEach(async () => {
  env = await createTestEnv();
  process.env['RALPHCTL_ROOT'] = env.testDir;
});

afterEach(async () => {
  await env.cleanup();
  delete process.env['RALPHCTL_ROOT'];
});

// ---------------------------------------------------------------------------
// assertSprintStatus (pure, sync)
// ---------------------------------------------------------------------------

describe('assertSprintStatus', () => {
  function makeSprint(status: Sprint['status']): Sprint {
    return {
      id: '20240101-120000-test',
      name: 'Test Sprint',
      status,
      createdAt: new Date().toISOString(),
      activatedAt: null,
      closedAt: null,
      tickets: [],
      checkRanAt: {},
      branch: null,
    };
  }

  it('passes for draft sprint with allowed status [draft]', () => {
    expect(() => {
      assertSprintStatus(makeSprint('draft'), ['draft'], 'add tickets');
    }).not.toThrow();
  });

  it('passes for active sprint with allowed status [active]', () => {
    expect(() => {
      assertSprintStatus(makeSprint('active'), ['active'], 'update task status');
    }).not.toThrow();
  });

  it('throws SprintStatusError for draft sprint when only active is allowed', () => {
    expect(() => {
      assertSprintStatus(makeSprint('draft'), ['active'], 'update task status');
    }).toThrow(SprintStatusError);
  });

  it('throws SprintStatusError for active sprint when only draft is allowed', () => {
    expect(() => {
      assertSprintStatus(makeSprint('active'), ['draft'], 'add tickets');
    }).toThrow(SprintStatusError);
  });

  it('throws SprintStatusError for closed sprint when draft or active required', () => {
    expect(() => {
      assertSprintStatus(makeSprint('closed'), ['draft', 'active'], 'start');
    }).toThrow(SprintStatusError);
  });

  it('passes for draft sprint with multiple allowed statuses [draft, active]', () => {
    expect(() => {
      assertSprintStatus(makeSprint('draft'), ['draft', 'active'], 'start');
    }).not.toThrow();
  });

  it('passes for active sprint with multiple allowed statuses [draft, active]', () => {
    expect(() => {
      assertSprintStatus(makeSprint('active'), ['draft', 'active'], 'start');
    }).not.toThrow();
  });

  it('error message includes the current status', () => {
    try {
      assertSprintStatus(makeSprint('closed'), ['active'], 'close');
    } catch (err) {
      expect(err).toBeInstanceOf(SprintStatusError);
      expect((err as SprintStatusError).message).toContain('closed');
    }
  });

  it('error carries currentStatus and operation properties', () => {
    try {
      assertSprintStatus(makeSprint('active'), ['draft'], 'plan');
    } catch (err) {
      expect(err).toBeInstanceOf(SprintStatusError);
      const statusErr = err as SprintStatusError;
      expect(statusErr.currentStatus).toBe('active');
      expect(statusErr.operation).toBe('plan');
    }
  });
});

// ---------------------------------------------------------------------------
// createSprint (async, file I/O)
// ---------------------------------------------------------------------------

describe('createSprint', () => {
  it('returns a sprint with status draft', async () => {
    const sprint = await createSprint('My Sprint');
    expect(sprint.status).toBe('draft');
  });

  it('uses the provided name', async () => {
    const sprint = await createSprint('My Sprint');
    expect(sprint.name).toBe('My Sprint');
  });

  it('generates an ID matching YYYYMMDD-HHmmss-slug format', async () => {
    const sprint = await createSprint('hello world');
    expect(sprint.id).toMatch(/^\d{8}-\d{6}-[a-z0-9-]+$/);
  });

  it('sets activatedAt and closedAt to null', async () => {
    const sprint = await createSprint('Test');
    expect(sprint.activatedAt).toBeNull();
    expect(sprint.closedAt).toBeNull();
  });

  it('creates an auto-generated name when none is provided', async () => {
    const sprint = await createSprint();
    expect(sprint.name).toBeTruthy();
    expect(sprint.name.length).toBeGreaterThan(0);
  });

  it('creates sprint files on disk', async () => {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const sprint = await createSprint('Disk Test');
    const sprintFile = join(env.testDir, 'sprints', sprint.id, 'sprint.json');
    expect(existsSync(sprintFile)).toBe(true);
  });

  it('initialises checkRanAt as empty object', async () => {
    const sprint = await createSprint('Clean Sprint');
    expect(sprint.checkRanAt).toEqual({});
  });

  it('initialises tickets as empty array', async () => {
    const sprint = await createSprint('Tickets Sprint');
    expect(sprint.tickets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// activateSprint (async, file I/O)
// ---------------------------------------------------------------------------

describe('activateSprint', () => {
  it('changes status to active and sets activatedAt', async () => {
    const created = await createSprint('Activate Me');
    const activated = await activateSprint(created.id);
    expect(activated.status).toBe('active');
    expect(activated.activatedAt).not.toBeNull();
  });

  it('throws SprintStatusError when activating a non-draft sprint', async () => {
    const sprint = await createSprint('Already Active');
    await activateSprint(sprint.id); // now active
    await expect(activateSprint(sprint.id)).rejects.toThrow(SprintStatusError);
  });
});

// ---------------------------------------------------------------------------
// closeSprint (async, file I/O)
// ---------------------------------------------------------------------------

describe('closeSprint', () => {
  it('changes status to closed and sets closedAt', async () => {
    const sprint = await createSprint('Close Me');
    await activateSprint(sprint.id);
    const closed = await closeSprint(sprint.id);
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();
  });

  it('clears checkRanAt when closing', async () => {
    const sprint = await createSprint('Check Ran Sprint');
    await activateSprint(sprint.id);
    // Manually write checkRanAt data
    const { getSprint, saveSprint } = await import('./sprint.ts');
    const loaded = await getSprint(sprint.id);
    loaded.checkRanAt = { '/some/path': new Date().toISOString() };
    await saveSprint(loaded);

    const closed = await closeSprint(sprint.id);
    expect(closed.checkRanAt).toEqual({});
  });

  it('throws SprintStatusError when closing a draft sprint', async () => {
    const sprint = await createSprint('Draft Cannot Close');
    await expect(closeSprint(sprint.id)).rejects.toThrow(SprintStatusError);
  });

  it('throws SprintStatusError when closing an already-closed sprint', async () => {
    const sprint = await createSprint('Double Close');
    await activateSprint(sprint.id);
    await closeSprint(sprint.id);
    await expect(closeSprint(sprint.id)).rejects.toThrow(SprintStatusError);
  });
});

// ---------------------------------------------------------------------------
// getCurrentSprintOrThrow
// ---------------------------------------------------------------------------

describe('getCurrentSprintOrThrow', () => {
  it('throws NoCurrentSprintError when no current sprint is set', async () => {
    await expect(getCurrentSprintOrThrow()).rejects.toThrow(NoCurrentSprintError);
  });

  it('returns the current sprint when one is set', async () => {
    const sprint = await createSprint('Current Sprint');
    await setCurrentSprint(sprint.id);
    const current = await getCurrentSprintOrThrow();
    expect(current.id).toBe(sprint.id);
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle integration
// ---------------------------------------------------------------------------

describe('full sprint lifecycle', () => {
  it('create → activate → close succeeds', async () => {
    const created = await createSprint('Lifecycle Test');
    expect(created.status).toBe('draft');

    const activated = await activateSprint(created.id);
    expect(activated.status).toBe('active');

    const closed = await closeSprint(created.id);
    expect(closed.status).toBe('closed');
  });

  it('create → close throws (cannot skip activation)', async () => {
    const sprint = await createSprint('Skip Activation');
    await expect(closeSprint(sprint.id)).rejects.toThrow(SprintStatusError);
  });
});
