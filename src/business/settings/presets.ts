import type { Settings } from '@src/domain/entity/settings.ts';
import {
  CLAUDE_ECONOMIC,
  CLAUDE_FAST,
  CLAUDE_FRONTIER,
  CLAUDE_ONLY,
  CLAUDE_STRONG_GATE,
} from '@src/business/settings/claude-preset-matrices.ts';
import {
  CODEX_ECONOMIC,
  CODEX_FAST,
  CODEX_FRONTIER,
  CODEX_ONLY,
  CODEX_STRONG_GATE,
} from '@src/business/settings/codex-preset-matrices.ts';
import {
  COPILOT_ECONOMIC,
  COPILOT_FAST,
  COPILOT_FRONTIER,
  COPILOT_ONLY,
  COPILOT_STRONG_GATE,
} from '@src/business/settings/copilot-preset-matrices.ts';
import {
  GROK_ECONOMIC,
  GROK_FAST,
  GROK_FRONTIER,
  GROK_ONLY,
  GROK_STRONG_GATE,
} from '@src/business/settings/grok-preset-matrices.ts';
import {
  MIXED,
  MIXED_ECONOMIC,
  MIXED_FAST,
  MIXED_FRONTIER,
  MIXED_STRONG_GATE,
} from '@src/business/settings/mixed-preset-matrices.ts';
import { OPENCODE_ONLY } from '@src/business/settings/opencode-preset-matrices.ts';

/**
 * Settings preset identifiers. Each preset is a one-shot snapshot of the AI section —
 * applying it stamps `ai.effort` plus all five per-flow rows. Preset identity is NOT
 * persisted; the next per-row edit sticks and nothing remembers which preset was applied.
 *
 * The matrices themselves live in `*-preset-matrices.ts`, one file per provider (plus mixed).
 * This module is the registry: names, order, and the harness flags each family stamps.
 *
 * Twenty-six shipped presets across five families, all equally first-class — no preset is
 * marked "recommended" or "default". Economic, strong-gate, fast, and frontier each carry five
 * variants (`mixed`, then claude / copilot / codex / grok). The standard family also carries
 * `opencode-only`: OpenCode stays a single preset because every free-tier model sits at the
 * same (zero) price, so a cheaper or frontier variant would differ in name only. Each family
 * lists `mixed` first, then one variant per single provider. The families:
 *   standard      — `mixed` routes each flow to the best provider for that flow's purpose;
 *                   `<provider>-only` routes every flow to that one provider.
 *   economic      — mirror the standard routings but start `implement` one tier below the
 *                   flagship to save tokens, leaning on the escalation ladder to climb only when
 *                   a task plateaus. Also pins `harness.bestOfNCandidates` to `0`.
 *   strong-gate   — cheap implement generator paired with a permanently-strong evaluator — the
 *                   only family that splits generator and evaluator by TIER (`mixed` and
 *                   `mixed-frontier` split by provider, at the same tier).
 *   fast          — cheapest viable tier at `low` effort, optimising speed/cost over quality;
 *                   the only family with `escalateOnPlateau` stamped OFF so a plateau settles.
 *   frontier      — flagship everywhere at `max` effort (tops out at Opus 5 / GPT-5.6 Sol /
 *                   Grok 4.7). `claude-fable-5` and `grok-4.7-build-fast` stay opt-in: each is
 *                   twice the price of the flagship it sits above.
 *
 * Applying a preset stamps the AI section AND `harness.escalateOnPlateau` — plus, for the economic
 * family only, `harness.bestOfNCandidates: 0` (its explicit cost opt-out). Preset identity is
 * NOT persisted; the next per-row edit sticks and nothing remembers which preset was applied.
 */
export type PresetName =
  | 'mixed'
  | 'claude-only'
  | 'copilot-only'
  | 'codex-only'
  | 'opencode-only'
  | 'grok-only'
  | 'mixed-economic'
  | 'claude-economic'
  | 'copilot-economic'
  | 'codex-economic'
  | 'grok-economic'
  | 'mixed-strong-gate'
  | 'claude-strong-gate'
  | 'copilot-strong-gate'
  | 'codex-strong-gate'
  | 'grok-strong-gate'
  | 'mixed-fast'
  | 'claude-fast'
  | 'copilot-fast'
  | 'codex-fast'
  | 'grok-fast'
  | 'mixed-frontier'
  | 'claude-frontier'
  | 'copilot-frontier'
  | 'codex-frontier'
  | 'grok-frontier';

export const PRESET_NAMES: readonly PresetName[] = [
  'mixed',
  'claude-only',
  'copilot-only',
  'codex-only',
  'opencode-only',
  'grok-only',
  'mixed-economic',
  'claude-economic',
  'copilot-economic',
  'codex-economic',
  'grok-economic',
  'mixed-strong-gate',
  'claude-strong-gate',
  'copilot-strong-gate',
  'codex-strong-gate',
  'grok-strong-gate',
  'mixed-fast',
  'claude-fast',
  'copilot-fast',
  'codex-fast',
  'grok-fast',
  'mixed-frontier',
  'claude-frontier',
  'copilot-frontier',
  'codex-frontier',
  'grok-frontier',
] as const;

export const isPresetName = (raw: string): raw is PresetName => (PRESET_NAMES as readonly string[]).includes(raw);

/**
 * Each preset carries its AI matrix plus the `escalateOnPlateau` flag {@link applyPreset} stamps
 * onto `harness`. Standard / economic / strong-gate / frontier families want the escalation
 * ladder on; the fast family stamps it OFF so a plateau settles instead of climbing.
 *
 * `bestOfNCandidates` is OPTIONAL here and stamped only where a preset takes a position on it: the
 * economic presets pin `0` (their whole story is refusing the N× generator spend of a granted
 * best-of-N attempt, and the shipped default is now `2`). Every other preset omits it, so applying
 * one leaves the operator's current value alone.
 */
const PRESETS: Readonly<
  Record<PresetName, { ai: Settings['ai']; escalateOnPlateau: boolean; bestOfNCandidates?: number }>
> = {
  mixed: { ai: MIXED, escalateOnPlateau: true },
  'claude-only': { ai: CLAUDE_ONLY, escalateOnPlateau: true },
  'copilot-only': { ai: COPILOT_ONLY, escalateOnPlateau: true },
  'codex-only': { ai: CODEX_ONLY, escalateOnPlateau: true },
  'opencode-only': { ai: OPENCODE_ONLY, escalateOnPlateau: true },
  'grok-only': { ai: GROK_ONLY, escalateOnPlateau: true },
  'mixed-economic': { ai: MIXED_ECONOMIC, escalateOnPlateau: true, bestOfNCandidates: 0 },
  'claude-economic': { ai: CLAUDE_ECONOMIC, escalateOnPlateau: true, bestOfNCandidates: 0 },
  'copilot-economic': { ai: COPILOT_ECONOMIC, escalateOnPlateau: true, bestOfNCandidates: 0 },
  'codex-economic': { ai: CODEX_ECONOMIC, escalateOnPlateau: true, bestOfNCandidates: 0 },
  'grok-economic': { ai: GROK_ECONOMIC, escalateOnPlateau: true, bestOfNCandidates: 0 },
  'mixed-strong-gate': { ai: MIXED_STRONG_GATE, escalateOnPlateau: true },
  'claude-strong-gate': { ai: CLAUDE_STRONG_GATE, escalateOnPlateau: true },
  'copilot-strong-gate': { ai: COPILOT_STRONG_GATE, escalateOnPlateau: true },
  'codex-strong-gate': { ai: CODEX_STRONG_GATE, escalateOnPlateau: true },
  'grok-strong-gate': { ai: GROK_STRONG_GATE, escalateOnPlateau: true },
  'mixed-fast': { ai: MIXED_FAST, escalateOnPlateau: false },
  'claude-fast': { ai: CLAUDE_FAST, escalateOnPlateau: false },
  'copilot-fast': { ai: COPILOT_FAST, escalateOnPlateau: false },
  'codex-fast': { ai: CODEX_FAST, escalateOnPlateau: false },
  'grok-fast': { ai: GROK_FAST, escalateOnPlateau: false },
  'mixed-frontier': { ai: MIXED_FRONTIER, escalateOnPlateau: true },
  'claude-frontier': { ai: CLAUDE_FRONTIER, escalateOnPlateau: true },
  'copilot-frontier': { ai: COPILOT_FRONTIER, escalateOnPlateau: true },
  'codex-frontier': { ai: CODEX_FRONTIER, escalateOnPlateau: true },
  'grok-frontier': { ai: GROK_FRONTIER, escalateOnPlateau: true },
};

/**
 * Stamp a preset onto `current`. The AI section is replaced wholesale with the preset's matrix,
 * `harness.escalateOnPlateau` is overwritten with the preset's flag (fast family OFF, all others
 * ON), and `harness.bestOfNCandidates` is overwritten ONLY by the presets that declare one (the
 * economic family, which pins `0`). The REST of `harness` (maxTurns, escalationMap,
 * plateauThreshold, …) plus `logging`, `concurrency`, `ui`, and `schemaVersion` are
 * preserved verbatim. Pure — does not touch persistence.
 *
 * Re-applying a preset clobbers any per-row customizations. No stored preset identity is
 * created, so a subsequent edit to any individual row sticks across reloads.
 */
export const applyPreset = (name: PresetName, current: Settings): Settings => {
  const preset = PRESETS[name];
  return {
    ...current,
    ai: preset.ai,
    harness: {
      ...current.harness,
      escalateOnPlateau: preset.escalateOnPlateau,
      ...(preset.bestOfNCandidates !== undefined ? { bestOfNCandidates: preset.bestOfNCandidates } : {}),
    },
  };
};
