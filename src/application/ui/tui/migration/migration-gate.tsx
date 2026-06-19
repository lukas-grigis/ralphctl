/**
 * MigrationGate — the consent screen shown as the FIRST Ink route when a data migration is pending,
 * before the main app mounts. This is the entire safety story for the v1 → v2 `data/` layout move:
 * NOTHING here mutates data without an explicit "Migrate now" click. The Wave-1 tolerant readers are
 * the net underneath — every non-consent outcome (skip / lock-held / dry-run-blocked / failed) just
 * proceeds into the app on the legacy data and re-offers the migration next launch.
 *
 * State machine:
 *
 *   scanning ──dryRun ok, no problems──▶ consent ──[Not now]──────────▶ resolve('skipped')
 *      │                                    │
 *      │                                    └──[Migrate now]──▶ applying ─┬─ ok ───────▶ resolve('migrated')
 *      │                                                                  ├─ lock-held ▶ lockHeld ─[continue]▶ resolve('skipped')
 *      │                                                                  └─ failed ───▶ failed ───┬─[continue]▶ resolve('failed-continue')
 *      │                                                                                           └─[quit]────▶ onQuit()
 *      ├──dryRun has problems──▶ dryRunBlocked ─[continue]─────────────▶ resolve('skipped')
 *      └──dryRun threw─────────▶ dryRunBlocked ─[continue]─────────────▶ resolve('skipped')
 *
 * This is a PRE-APP component: it has no router / deps / prompt context (those mount with the main
 * app). Everything it needs — the engine, the data root, the apply ctx ingredients, and the two exit
 * callbacks — arrives as props from the launch pre-flight.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { DataMigrationEngine } from '@src/integration/persistence/data-migration/run-data-migration.ts';
import type { DryRunReport } from '@src/integration/persistence/data-migration/types.ts';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { Banner } from '@src/application/ui/tui/components/banner.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import {
  createLearningsBackfillRenderer,
  createLearningsMerger,
} from '@src/application/ui/tui/migration/learnings-backfill-adapter.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';

/**
 * How the gate resolved into the main app:
 *  - `migrated`        — apply ran and stamped the marker; the app reads the v2 layout.
 *  - `skipped`         — the user declined, a lock was held, or the dry-run was blocked; the app runs
 *                        on the tolerant readers and the migration is re-offered next launch.
 *  - `failed-continue` — apply faulted mid-run but the user chose to continue; atomic per-item renames
 *                        + tolerant readers ⇒ a half-migrated tree is still runnable; re-offered next
 *                        launch (idempotent resume finishes the rest).
 *
 * @public
 */
export type MigrationGateOutcome = 'migrated' | 'skipped' | 'failed-continue';

/**
 * Props for {@link MigrationGate}. The apply-ctx ingredients (`appVersion`, `stateRoot`, `writeFile`)
 * are threaded in rather than reached from a context because the gate mounts before the app's provider
 * stack exists. `renderLearnings` is built internally from the application-layer adapter.
 *
 * @public
 */
export interface MigrationGateProps {
  readonly engine: DataMigrationEngine;
  readonly dataRoot: AbsolutePath;
  readonly stateRoot: AbsolutePath;
  readonly appVersion: string;
  readonly now: () => string;
  readonly writeFile: WriteFile;
  /** Resolve the gate and proceed to the main app with the given outcome. */
  readonly onResolve: (outcome: MigrationGateOutcome) => void;
  /** Quit ralphctl entirely (only offered from the failure screen). */
  readonly onQuit: () => void;
}

type GateState =
  | { readonly kind: 'scanning' }
  | { readonly kind: 'consent'; readonly report: DryRunReport; readonly action: 'migrate' | 'not-now' }
  | { readonly kind: 'applying' }
  | { readonly kind: 'lock-held' }
  | { readonly kind: 'dry-run-blocked'; readonly issues: readonly string[] }
  | {
      readonly kind: 'failed';
      readonly backupPath: string | undefined;
      /**
       * A real prior app version sourced from the marker's `lastWrittenByAppVersion`, or `undefined`
       * when none is recorded. We NEVER guess: on an apply failure the marker is unstamped, so the
       * data is still readable by the CURRENT version — printing a wrong downgrade command would be
       * actively harmful. When undefined the failure screen omits the version-specific install line.
       */
      readonly downgradeVersion: string | undefined;
    };

/** Outcome reused across every "decline / proceed on tolerant readers" path. */
const SKIPPED: MigrationGateOutcome = 'skipped';

/** Subset of Ink's `Key` flags the consent handler reads — declared so the handler is unit-typeable. */
type KeyFlags = Pick<Key, 'leftArrow' | 'rightArrow' | 'tab' | 'return' | 'escape'>;

/** Shared title for the two "we left your data alone" screens (lock-held + dry-run-blocked). */
const SKIP_TITLE = 'Skipping for now';

/** Pluralize a count with its noun: `1 sprint` / `2 sprints`. */
const countLabel = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

/** Human summary of how many of each kind the dry-run plans to rename. */
const summarize = (report: DryRunReport): { readonly sprints: number; readonly projects: number } => {
  let sprints = 0;
  let projects = 0;
  for (const plan of report.planned) {
    if (plan.kind === 'sprint') sprints += 1;
    else if (plan.kind === 'project') projects += 1;
  }
  return { sprints, projects };
};

export const MigrationGate = (props: MigrationGateProps): React.JSX.Element => {
  const { engine, dataRoot, stateRoot, appVersion, now, writeFile, onResolve, onQuit } = props;
  const [state, setState] = useState<GateState>({ kind: 'scanning' });
  // The dry-run must fire exactly once even if React re-runs the effect on a parent re-render — a
  // re-scan would reset a consent screen the user is mid-decision on.
  const scannedRef = useRef(false);

  useEffect(() => {
    if (scannedRef.current) return;
    scannedRef.current = true;
    const scan = async (): Promise<void> => {
      try {
        const report = await engine.dryRun(dataRoot);
        if (report.problems.length > 0) {
          setState({ kind: 'dry-run-blocked', issues: report.problems.map((p) => `${p.name} — ${p.reason}`) });
          return;
        }
        // No-op migration (brand-new install, or everything already reconciled): there is nothing to
        // rename or merge and no problems, so the consent prompt would be pointless. Silently stamp
        // the marker to CURRENT and proceed straight into the app — a new user never sees the splash.
        if (report.planned.length === 0 && report.merges.length === 0) {
          await engine.stampCurrent(dataRoot, appVersion);
          onResolve('migrated');
          return;
        }
        setState({ kind: 'consent', report, action: 'migrate' });
      } catch (err) {
        // A dry-run that threw is treated like a blocking problem: surface it, do NOT apply, proceed
        // on the tolerant readers. The dry-run touches nothing, so a throw here left disk untouched.
        const msg = err instanceof Error ? err.message : String(err);
        setState({ kind: 'dry-run-blocked', issues: [`could not scan data — ${msg}`] });
      }
    };
    void scan();
  }, [engine, dataRoot]);

  const runApply = async (report: DryRunReport): Promise<void> => {
    setState({ kind: 'applying' });
    const result = await engine.apply(dataRoot, report, {
      timestamp: now(),
      appVersion,
      stateRoot,
      renderLearnings: createLearningsBackfillRenderer(),
      mergeLearnings: createLearningsMerger(),
      writeFile,
    });
    if (result.kind === 'ok') {
      onResolve('migrated');
      return;
    }
    if (result.kind === 'lock-held') {
      setState({ kind: 'lock-held' });
      return;
    }
    // On a failure the marker was NOT stamped (it is written ONLY on full success), so the CURRENT
    // version still reads the data via the tolerant readers. Only name a downgrade version if the
    // marker actually records a prior `lastWrittenByAppVersion`; otherwise omit it rather than guess.
    const marker = await engine.readMarker(dataRoot);
    const prior = marker.lastWrittenByAppVersion.trim();
    setState({
      kind: 'failed',
      backupPath: result.backupPath,
      downgradeVersion: prior.length > 0 ? prior : undefined,
    });
  };

  const handleConsentInput = (consent: GateState & { kind: 'consent' }, input: string, key: KeyFlags): void => {
    if (key.leftArrow || key.rightArrow || input === 'h' || input === 'l' || key.tab) {
      setState({ ...consent, action: consent.action === 'migrate' ? 'not-now' : 'migrate' });
      return;
    }
    // `n` / esc declines outright; `m` (or `y`) accepts — direct shortcuts alongside the cursor.
    if (input === 'n' || key.escape) {
      onResolve(SKIPPED);
      return;
    }
    const accept = input === 'm' || input === 'y' || (key.return && consent.action === 'migrate');
    if (accept) {
      void runApply(consent.report);
      return;
    }
    if (key.return) onResolve(SKIPPED); // Enter on the "Not now" cursor
  };

  useInput((input, key) => {
    switch (state.kind) {
      case 'consent':
        handleConsentInput(state, input, key);
        break;
      case 'lock-held':
      case 'dry-run-blocked':
        // Only path forward is to continue on the tolerant readers; any key proceeds.
        onResolve(SKIPPED);
        break;
      case 'failed':
        // `q` quits; anything else (incl. Enter) continues into the app — a half-migration is still
        // runnable on the tolerant readers, so the user is never trapped on the failure screen.
        if (input === 'q') onQuit();
        else onResolve('failed-continue');
        break;
      case 'scanning':
      case 'applying':
        // No input while a scan / apply is in flight.
        break;
    }
  });

  return (
    <Box flexDirection="column" paddingX={spacing.indent} paddingY={spacing.section}>
      <Banner compact />
      <Box marginTop={spacing.section}>{renderBody(state)}</Box>
    </Box>
  );
};

const renderBody = (state: GateState): React.JSX.Element => {
  switch (state.kind) {
    case 'scanning':
      return (
        <Card title="Checking your data" tone="primary">
          <Spinner label="taking a quick look at how your data is stored…" />
        </Card>
      );
    case 'consent':
      return <ConsentBody report={state.report} action={state.action} />;
    case 'applying':
      return (
        <Card title="Tidying up" tone="primary">
          <Spinner label="backing up and reorganizing — this takes a moment…" />
        </Card>
      );
    case 'lock-held':
      return (
        <Card title={SKIP_TITLE} tone="warning">
          <Text color={inkColors.warning}>
            {glyphs.warningGlyph} Another ralphctl is running — we&apos;ll tidy up next time instead.
          </Text>
          <Text dimColor>Your data is untouched. Press any key to continue.</Text>
        </Card>
      );
    case 'dry-run-blocked':
      return (
        <Card title={SKIP_TITLE} tone="warning">
          <Text color={inkColors.warning}>
            {glyphs.warningGlyph} We hit something we&apos;d rather not touch automatically:
          </Text>
          <Box flexDirection="column" marginTop={spacing.section}>
            {state.issues.map((issue, i) => (
              <Text key={i} dimColor>
                {glyphs.bullet} {issue}
              </Text>
            ))}
          </Box>
          <Box marginTop={spacing.section}>
            <Text dimColor>Your data is untouched and everything still works. Press any key to continue.</Text>
          </Box>
        </Card>
      );
    case 'failed':
      return <FailureBody backupPath={state.backupPath} downgradeVersion={state.downgradeVersion} />;
  }
};

const ConsentBody = ({
  report,
  action,
}: {
  readonly report: DryRunReport;
  readonly action: 'migrate' | 'not-now';
}): React.JSX.Element => {
  const { sprints, projects } = summarize(report);
  const parts: string[] = [];
  if (sprints > 0) parts.push(countLabel(sprints, 'sprint'));
  if (projects > 0) parts.push(countLabel(projects, 'project'));
  const renamedLine = parts.length > 0 ? `${parts.join(' and ')} renamed for readability` : 'a small cleanup';

  return (
    <Card title="A quick tidy-up" tone="primary">
      <Text>ralphctl can tidy how your data is stored so it&apos;s easier to read.</Text>
      <Box flexDirection="column" marginTop={spacing.section}>
        <Text dimColor>
          {glyphs.bullet} {renamedLine}
        </Text>
        <Text dimColor>{glyphs.bullet} a full backup is taken first</Text>
        <Text dimColor>{glyphs.bullet} fully reversible</Text>
      </Box>
      <Box marginTop={spacing.actionBreak}>
        <Action label="Migrate now" selected={action === 'migrate'} tone="primary" />
        <Box marginLeft={spacing.indent}>
          <Action label="Not now" selected={action === 'not-now'} tone="muted" />
        </Box>
      </Box>
      <Box marginTop={spacing.section}>
        <Text dimColor>
          {glyphs.arrowRight} use ← → to choose, enter to confirm · &quot;Not now&quot; keeps things as they are
        </Text>
      </Box>
    </Card>
  );
};

const Action = ({
  label,
  selected,
  tone,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly tone: 'primary' | 'muted';
}): React.JSX.Element => {
  const color = tone === 'primary' ? inkColors.primary : inkColors.muted;
  return (
    <Text color={selected ? color : inkColors.muted} bold={selected} inverse={selected}>
      {' '}
      {selected ? glyphs.actionCursor : ' '} {label}{' '}
    </Text>
  );
};

const FailureBody = ({
  backupPath,
  downgradeVersion,
}: {
  readonly backupPath: string | undefined;
  readonly downgradeVersion: string | undefined;
}): React.JSX.Element => (
  <Card title="Your data is safe" tone="error">
    <Text color={inkColors.success}>
      {glyphs.check} Nothing was lost — we stopped before finishing and your current version still reads your data.
    </Text>
    {backupPath !== undefined && (
      <Box marginTop={spacing.section}>
        <Text>
          A full backup is at <Text bold>{backupPath}</Text>
        </Text>
      </Box>
    )}
    <Box flexDirection="column" marginTop={spacing.section}>
      <Text dimColor>You can keep using ralphctl as-is. If you&apos;d rather roll back:</Text>
      {backupPath !== undefined ? (
        <Text dimColor>
          {glyphs.bullet} move <Text bold>{backupPath}</Text> back to your <Text bold>data/</Text> folder
        </Text>
      ) : (
        <Text dimColor>{glyphs.bullet} your data folder was not modified</Text>
      )}
      {downgradeVersion !== undefined && (
        <Text dimColor>
          {glyphs.bullet} to go back to the previous version:{' '}
          <Text bold>npm install -g ralphctl@{downgradeVersion}</Text>
        </Text>
      )}
    </Box>
    <Box marginTop={spacing.actionBreak}>
      <Text dimColor>
        {glyphs.arrowRight} press <Text bold>enter</Text> to continue anyway (it&apos;s safe to keep going) · press{' '}
        <Text bold>q</Text> to quit
      </Text>
    </Box>
  </Card>
);
