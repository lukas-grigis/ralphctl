/**
 * StatusBanner — tiered, event-driven status strip layered above the active view body.
 *
 * Replaces the single-purpose rate-limit banner with a generic system that any subsystem can
 * surface state through (rate-limit pause, idle-stdout watchdog kill, lock contention,
 * setup-script failure, baseline-broken warning, provider-disconnect, …). Emitters publish
 * `banner-show` / `banner-clear` on the EventBus keyed by a stable `id`; this component holds
 * the active set in local state and renders a stack ordered most-urgent-first.
 *
 * Three tiers, distinct visual treatment so the operator can categorise at a glance:
 *
 *   error → red, bold, `✗` glyph
 *   warn  → yellow, bold, `⚠` glyph
 *   info  → cyan, dim background, `i` glyph
 *
 * Stack mechanics:
 *
 *  - Active banners are deduped by `id`; re-publishing the same id replaces the previous
 *    entry. Insertion order is the publish order; sort flows error → warn → info before
 *    render so urgency stays visually consistent regardless of when each emitter fired.
 *  - Up to `MAX_VISIBLE` (3) banners render; the rest collapse into a `… + N more` row.
 *  - `d` dismisses the topmost (most-urgent) banner. Dismissal is local to the TUI session —
 *    the underlying state remains; if the emitter publishes the same id again the banner
 *    reappears. Re-display after dismiss requires a re-publish from the emitter (the bus
 *    has no replay), which matches the design intent: "I don't need to see this right now"
 *    rather than "this state is resolved".
 *
 * Rendering footprint is single-line per banner so the chrome stays calm — actionable detail
 * belongs in the chain log, not the banner itself.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { BannerShowEvent } from '@src/business/observability/events.ts';

/** Hard cap on visible banners before the collapse marker takes over. */
const MAX_VISIBLE = 3;

/**
 * Hard cap on retained banners regardless of visibility. Banner ids from the AI provider
 * adapters embed per-spawn / per-pid suffixes (`rate-limit-claude-<sessionId>`,
 * `watchdog-claude-<pid>`) and so do not dedupe across a long-running sprint; without this cap
 * a Rate-limit-heavy or watchdog-thrash run would accumulate one entry per occurrence for the
 * TUI's lifetime. The cap is well above MAX_VISIBLE so the collapse marker ("+N more") still
 * communicates depth while drop-oldest keeps memory bounded. Re-published ids continue to
 * replace in place (see `upsert`); only truly distinct ids hit the cap.
 */
const MAX_RETAINED = 50;

type Tier = 'info' | 'warn' | 'error';

interface ActiveBanner {
  readonly id: string;
  readonly tier: Tier;
  readonly message: string;
  readonly cause?: string;
}

const TIER_ORDER: Record<Tier, number> = { error: 0, warn: 1, info: 2 };

const tierColor = (tier: Tier): string => {
  if (tier === 'error') return inkColors.error;
  if (tier === 'warn') return inkColors.warning;
  return inkColors.info;
};

const tierGlyph = (tier: Tier): string => {
  if (tier === 'error') return glyphs.cross;
  if (tier === 'warn') return glyphs.warningGlyph;
  return glyphs.infoGlyph;
};

const toActive = (event: BannerShowEvent): ActiveBanner => ({
  id: event.id,
  tier: event.tier,
  message: event.message,
  ...(event.cause !== undefined ? { cause: event.cause } : {}),
});

/**
 * Update strategy: re-publishing an id replaces the existing entry in place (preserves
 * insertion position so the visual order is stable across refreshes). A new id appends; once
 * the retained-cap is hit the oldest *non-error* entry is dropped (errors get priority retention
 * because they are the entry most likely to need operator attention). A pathological all-error
 * burst still drops oldest-first because we fall back to the front of the array.
 */
const upsert = (current: readonly ActiveBanner[], next: ActiveBanner): readonly ActiveBanner[] => {
  const idx = current.findIndex((b) => b.id === next.id);
  if (idx !== -1) {
    const copy = [...current];
    copy[idx] = next;
    return copy;
  }
  if (current.length < MAX_RETAINED) return [...current, next];
  // Drop-oldest: prefer evicting non-error first so a true failure isn't shadowed by a flood of
  // info/warn churn (e.g. dozens of rate-limit retries).
  const evictIdx = current.findIndex((b) => b.tier !== 'error');
  const trimmed = evictIdx === -1 ? current.slice(1) : [...current.slice(0, evictIdx), ...current.slice(evictIdx + 1)];
  return [...trimmed, next];
};

export const StatusBanner = (): React.JSX.Element | null => {
  const deps = useDeps();
  const [banners, setBanners] = useState<readonly ActiveBanner[]>([]);

  useEffect(() => {
    const unsub = deps.eventBus.subscribe((event) => {
      if (event.type === 'banner-show') {
        setBanners((prev) => upsert(prev, toActive(event)));
        return;
      }
      if (event.type === 'banner-clear') {
        setBanners((prev) => prev.filter((b) => b.id !== event.id));
      }
    });
    return unsub;
  }, [deps.eventBus]);

  // Sort by tier (most-urgent first); within the same tier we preserve insertion order so a
  // burst of warns doesn't jitter as new ones arrive.
  const sorted = [...banners].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);

  // Dismiss the topmost (most-urgent) banner. Local-only — the underlying state remains, the
  // banner can re-emit if the emitter republishes its id.
  const dismissTop = useCallback(() => {
    setBanners((prev) => {
      if (prev.length === 0) return prev;
      const top = [...prev].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier])[0];
      if (top === undefined) return prev;
      return prev.filter((b) => b.id !== top.id);
    });
  }, []);

  // Only claim `d` while there's something to dismiss — otherwise we'd intercept a keystroke
  // any view-level handler might want for its own use. We gate inside the handler rather than
  // via `useInput`'s `isActive` option because the option flips the subscription itself, which
  // races with the first render where banners arrive and the keystroke can land on the same
  // tick. The in-handler check is cheap and avoids that race.
  useInput((input) => {
    if (input === 'd' && sorted.length > 0) dismissTop();
  });

  if (sorted.length === 0) return null;

  const visible = sorted.slice(0, MAX_VISIBLE);
  const overflow = Math.max(0, sorted.length - MAX_VISIBLE);

  return (
    <Box flexDirection="column" flexShrink={0}>
      {visible.map((banner) => (
        <BannerRow key={banner.id} banner={banner} />
      ))}
      {overflow > 0 ? (
        <Box paddingX={spacing.indent}>
          <Text dimColor>
            {glyphs.bullet} +{overflow} more
          </Text>
        </Box>
      ) : null}
    </Box>
  );
};

interface BannerRowProps {
  readonly banner: ActiveBanner;
}

const BannerRow = ({ banner }: BannerRowProps): React.JSX.Element => {
  const color = tierColor(banner.tier);
  const glyph = tierGlyph(banner.tier);
  // Info tier renders dim to read as "ambient" rather than "alarm"; warn/error stay bold so
  // they punch above the surrounding chrome.
  const isInfo = banner.tier === 'info';
  return (
    <Box paddingX={spacing.indent} flexDirection="row">
      <Text color={color} bold={!isInfo} dimColor={isInfo}>
        {glyph} {banner.message}
      </Text>
      {banner.cause !== undefined ? <Text dimColor> {banner.cause}</Text> : null}
      <Text dimColor> (press d to dismiss)</Text>
    </Box>
  );
};
