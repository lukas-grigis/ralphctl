/**
 * Contract for the durable per-flow skills opt-OUT preference `settings.ai.skills`.
 *
 * Shape: `Partial<Record<FlowId, { disabled: readonly string[] }>>` — optional at every flow
 * level. Absent means "registry defaults apply" (resolved in the launcher, not the schema).
 * `disabled` entries are free trimmed non-empty skill names; the domain never validates them
 * against the integration-side registry. Precedence at launch is per-run override > this saved
 * preference > registry default — none of which the schema enforces; it only round-trips the key.
 */

import { describe, expect, it } from 'vitest';
import { SettingsSchema } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';

const withSkills = (skills: unknown): unknown => ({
  ...DEFAULT_SETTINGS,
  ai: { ...DEFAULT_SETTINGS.ai, skills },
});

describe('settings.ai.skills — durable opt-out preference', () => {
  it('accepts an absent key (DEFAULT_SETTINGS carries no skills block)', () => {
    const parsed = SettingsSchema.safeParse(DEFAULT_SETTINGS);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.skills).toBeUndefined();
  });

  it('accepts an empty skills object (no flow opts out anything)', () => {
    const parsed = SettingsSchema.safeParse(withSkills({}));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.skills).toEqual({});
  });

  it('round-trips populated per-flow disabled lists', () => {
    const skills = {
      refine: { disabled: ['ralphctl-ponytail'] },
      implement: { disabled: ['ralphctl-karpathy-guidelines', 'ralphctl-cherny-workflow'] },
    };
    const parsed = SettingsSchema.safeParse(withSkills(skills));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.skills).toEqual(skills);
  });

  it('accepts an empty disabled list on a flow (equivalent to nothing disabled)', () => {
    const parsed = SettingsSchema.safeParse(withSkills({ plan: { disabled: [] } }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.skills).toEqual({ plan: { disabled: [] } });
  });

  it('is stable under a second parse (schema-level save/load round-trip)', () => {
    const skills = { createPr: { disabled: ['ralphctl-ponytail'] } };
    const once = SettingsSchema.safeParse(withSkills(skills));
    expect(once.success).toBe(true);
    if (!once.success) return;
    const twice = SettingsSchema.safeParse(once.data);
    expect(twice.success).toBe(true);
    if (!twice.success) return;
    expect(twice.data.ai.skills).toEqual(skills);
  });

  it('trims skill-name entries', () => {
    const parsed = SettingsSchema.safeParse(withSkills({ ideate: { disabled: ['  ralphctl-ponytail  '] } }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.skills).toEqual({ ideate: { disabled: ['ralphctl-ponytail'] } });
  });

  it('rejects a blank (whitespace-only) skill name — entries must be non-empty when trimmed', () => {
    const parsed = SettingsSchema.safeParse(withSkills({ refine: { disabled: ['   '] } }));
    expect(parsed.success).toBe(false);
  });

  it('tolerantly strips an unknown flow key rather than failing the whole parse', () => {
    const parsed = SettingsSchema.safeParse(
      withSkills({ bogusFlow: { disabled: ['x'] }, plan: { disabled: ['ralphctl-ponytail'] } })
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.skills).toEqual({ plan: { disabled: ['ralphctl-ponytail'] } });
  });
});
