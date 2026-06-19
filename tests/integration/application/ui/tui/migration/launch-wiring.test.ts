/**
 * Launch wiring for the migration gate (Wave 2b). The launch pre-flight routes the consent gate on
 * the initial Ink mount via `shouldShowMigrationGate(pending, gateResolved)`. We assert the decision
 * table directly — the surrounding bootstrap does full storage resolution + wiring, so the pure
 * decision is the testable seam:
 *
 *   - needsMigration === false ⇒ gate NOT shown (App mounts directly).
 *   - needsMigration === true  ⇒ gate shown first, until it resolves.
 */

import { describe, expect, it } from 'vitest';
import { shouldShowMigrationGate } from '@src/application/ui/tui/launch.ts';

describe('shouldShowMigrationGate', () => {
  it('does NOT show the gate when no migration is pending', () => {
    expect(shouldShowMigrationGate(false, false)).toBe(false);
    expect(shouldShowMigrationGate(false, true)).toBe(false);
  });

  it('shows the gate when a migration is pending and unresolved', () => {
    expect(shouldShowMigrationGate(true, false)).toBe(true);
  });

  it('stops showing the gate once it has resolved (pause/resume remount renders the App)', () => {
    expect(shouldShowMigrationGate(true, true)).toBe(false);
  });
});
