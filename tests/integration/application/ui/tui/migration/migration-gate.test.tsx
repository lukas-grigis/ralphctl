/**
 * MigrationGate component behaviour (Wave 2b consent splash). Every path is asserted against the
 * core safety invariant: NOTHING mutates data unless the user explicitly accepts. We stub the
 * migration engine so each test pins one branch — dry-run shape and apply outcome are the only
 * inputs that vary.
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { DataMigrationEngine } from '@src/integration/persistence/data-migration/run-data-migration.ts';
import type { DryRunReport, RenamePlan } from '@src/integration/persistence/data-migration/types.ts';
import type { ApplyResult } from '@src/integration/persistence/data-migration/apply.ts';
import { MigrationGate, type MigrationGateOutcome } from '@src/application/ui/tui/migration/migration-gate.tsx';
import { ENTER, ESC, tick, waitFor } from '@tests/integration/application/ui/tui/_keys.ts';

const ABS = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`bad path: ${p}`);
  return r.value;
};

const DATA_ROOT = ABS('/tmp/ralphctl-test/data');
const STATE_ROOT = ABS('/tmp/ralphctl-test/state');

const plan = (kind: RenamePlan['kind'], id: string): RenamePlan => ({
  kind,
  id,
  slug: 'slug',
  fromName: id,
  toName: `${id}--slug`,
  from: ABS(`/tmp/ralphctl-test/data/${id}`),
  to: ABS(`/tmp/ralphctl-test/data/${id}--slug`),
});

const reportWith = (overrides: Partial<DryRunReport> = {}): DryRunReport => ({
  planned: [],
  skipped: [],
  problems: [],
  ...overrides,
});

interface Harness {
  readonly engine: DataMigrationEngine;
  readonly apply: ReturnType<typeof vi.fn>;
  readonly resolved: MigrationGateOutcome[];
  readonly quit: ReturnType<typeof vi.fn>;
}

const mount = (opts: {
  readonly dryRun: () => Promise<DryRunReport>;
  readonly applyResult?: ApplyResult;
}): { readonly h: Harness; readonly r: ReturnType<typeof render> } => {
  const apply = vi.fn(
    async (): Promise<ApplyResult> => opts.applyResult ?? { kind: 'ok', backupPath: '/bk', applied: [] }
  );
  const engine: DataMigrationEngine = {
    needsMigration: async (): Promise<boolean> => true,
    dryRun: opts.dryRun,
    apply,
  };
  const resolved: MigrationGateOutcome[] = [];
  const quit = vi.fn();
  const r = render(
    <MigrationGate
      engine={engine}
      dataRoot={DATA_ROOT}
      stateRoot={STATE_ROOT}
      appVersion="0.12.1"
      now={(): string => '2026-06-19T00:00:00.000Z'}
      writeFile={async (): Promise<Result<void, StorageError>> => Result.ok(undefined)}
      onResolve={(o): void => {
        resolved.push(o);
      }}
      onQuit={quit}
    />
  );
  return { h: { engine, apply, resolved, quit }, r };
};

describe('MigrationGate', () => {
  it('renders a summary from the dry-run counts', async () => {
    const { r } = mount({
      dryRun: async (): Promise<DryRunReport> =>
        reportWith({ planned: [plan('sprint', 's1'), plan('sprint', 's2'), plan('project', 'p1')] }),
    });
    await waitFor(() => r.lastFrame()?.includes('renamed for readability') === true);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('2 sprints');
    expect(frame).toContain('1 project');
    expect(frame).toContain('a full backup is taken first');
    r.unmount();
  });

  it('"Not now" resolves skipped WITHOUT calling apply', async () => {
    const { h, r } = mount({
      dryRun: async (): Promise<DryRunReport> => reportWith({ planned: [plan('sprint', 's1')] }),
    });
    await waitFor(() => r.lastFrame()?.includes('renamed for readability') === true);
    r.stdin.write('n');
    await tick();
    expect(h.resolved).toEqual(['skipped']);
    expect(h.apply).not.toHaveBeenCalled();
    r.unmount();
  });

  it('esc also declines without applying', async () => {
    const { h, r } = mount({
      dryRun: async (): Promise<DryRunReport> => reportWith({ planned: [plan('sprint', 's1')] }),
    });
    await waitFor(() => r.lastFrame()?.includes('renamed for readability') === true);
    r.stdin.write(ESC);
    await tick(60);
    expect(h.resolved).toEqual(['skipped']);
    expect(h.apply).not.toHaveBeenCalled();
    r.unmount();
  });

  it('"Migrate now" happy path calls apply and resolves migrated', async () => {
    const { h, r } = mount({
      dryRun: async (): Promise<DryRunReport> => reportWith({ planned: [plan('sprint', 's1')] }),
      applyResult: { kind: 'ok', backupPath: '/bk', applied: [] },
    });
    await waitFor(() => r.lastFrame()?.includes('renamed for readability') === true);
    r.stdin.write('m');
    await waitFor(() => h.resolved.length > 0);
    expect(h.apply).toHaveBeenCalledOnce();
    expect(h.resolved).toEqual(['migrated']);
    r.unmount();
  });

  it('enter on the (default) Migrate-now cursor applies', async () => {
    const { h, r } = mount({
      dryRun: async (): Promise<DryRunReport> => reportWith({ planned: [plan('sprint', 's1')] }),
      applyResult: { kind: 'ok', backupPath: '/bk', applied: [] },
    });
    await waitFor(() => r.lastFrame()?.includes('renamed for readability') === true);
    r.stdin.write(ENTER);
    await waitFor(() => h.resolved.length > 0);
    expect(h.apply).toHaveBeenCalledOnce();
    expect(h.resolved).toEqual(['migrated']);
    r.unmount();
  });

  it("'failed' renders the backup path and the npm downgrade line; continuing resolves failed-continue", async () => {
    const err = new StorageError({ subCode: 'io', message: 'rename blew up', path: '/x' });
    const { h, r } = mount({
      dryRun: async (): Promise<DryRunReport> => reportWith({ planned: [plan('sprint', 's1')] }),
      applyResult: { kind: 'failed', backupPath: '/home/me/.ralphctl/data.backup-v1-2026', error: err, applied: [] },
    });
    await waitFor(() => r.lastFrame()?.includes('renamed for readability') === true);
    r.stdin.write('m');
    await waitFor(() => r.lastFrame()?.includes('Your data is safe') === true);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('/home/me/.ralphctl/data.backup-v1-2026');
    expect(frame).toContain('npm install -g ralphctl@');
    // Continue (Enter) → proceed into the app on the tolerant readers.
    r.stdin.write(ENTER);
    await waitFor(() => h.resolved.length > 0);
    expect(h.resolved).toEqual(['failed-continue']);
    r.unmount();
  });

  it("'failed' + q quits instead of continuing", async () => {
    const err = new StorageError({ subCode: 'io', message: 'boom', path: '/x' });
    const { h, r } = mount({
      dryRun: async (): Promise<DryRunReport> => reportWith({ planned: [plan('sprint', 's1')] }),
      applyResult: { kind: 'failed', backupPath: '/bk', error: err, applied: [] },
    });
    await waitFor(() => r.lastFrame()?.includes('renamed for readability') === true);
    r.stdin.write('m');
    await waitFor(() => r.lastFrame()?.includes('Your data is safe') === true);
    r.stdin.write('q');
    await waitFor(() => h.quit.mock.calls.length > 0);
    expect(h.quit).toHaveBeenCalledOnce();
    expect(h.resolved).toEqual([]);
    r.unmount();
  });

  it("'lock-held' proceeds on tolerant readers", async () => {
    const { h, r } = mount({
      dryRun: async (): Promise<DryRunReport> => reportWith({ planned: [plan('sprint', 's1')] }),
      applyResult: { kind: 'lock-held' },
    });
    await waitFor(() => r.lastFrame()?.includes('renamed for readability') === true);
    r.stdin.write('m');
    await waitFor(() => r.lastFrame()?.includes('Another ralphctl is running') === true);
    r.stdin.write(ENTER);
    await waitFor(() => h.resolved.length > 0);
    expect(h.resolved).toEqual(['skipped']);
    r.unmount();
  });

  it('dry-run with problems shows the issue and never applies', async () => {
    const { h, r } = mount({
      dryRun: async (): Promise<DryRunReport> =>
        reportWith({ problems: [{ name: 'abc', reason: 'collides with abc--slug' }] }),
    });
    await waitFor(() => r.lastFrame()?.includes('collides with abc--slug') === true);
    expect(r.lastFrame()).toContain('abc');
    // Any key continues; apply must never have been reached.
    r.stdin.write(ENTER);
    await waitFor(() => h.resolved.length > 0);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.resolved).toEqual(['skipped']);
    r.unmount();
  });
});
