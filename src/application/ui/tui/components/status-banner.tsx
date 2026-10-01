/** StatusBanner — tiered, event-driven status strip layered above the active view body. */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useClaimedKeys } from '@src/application/ui/tui/runtime/claimed-keys-context.tsx';
import { useOverlayState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { glyphs, spacing, tones } from '@src/application/ui/tui/theme/tokens.ts';
import type { BannerShowEvent } from '@src/business/observability/events.ts';

/** Hard cap on visible banners before the collapse marker takes over. */
const MAX_VISIBLE = 3;

/** Hard cap on retained banners regardless of visibility. */
const MAX_RETAINED = 50;

type Tier = 'info' | 'warn' | 'error';

interface ActiveBanner {
  readonly id: string;
  readonly tier: Tier;
  readonly message: string;
  readonly cause?: string;
}

const TIER_ORDER: Record<Tier, number> = { error: 0, warn: 1, info: 2 };

const TIER_TONE: Readonly<Record<Tier, 'error' | 'warning' | 'info'>> = {
  error: 'error',
  warn: 'warning',
  info: 'info',
};

const toActive = (event: BannerShowEvent): ActiveBanner => ({
  id: event.id,
  tier: event.tier,
  message: event.message,
  ...(event.cause !== undefined ? { cause: event.cause } : {}),
});

/**
 * Update strategy: re-publishing an id replaces the existing entry in place (preserves insertion position so the
 * visual order is stable across refreshes).
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
  const overlay = useOverlayState();
  const { isClaimed } = useClaimedKeys();
  const [banners, setBanners] = useState<readonly ActiveBanner[]>([]);

  useEffect(() => {
    // ViewShell mounts this banner inside every view, including ones whose tests pass a partial AppDeps without a
    // real EventBus.
    const bus = deps.eventBus;
    if (bus === undefined) return undefined;
    return bus.subscribe((event) => {
      if (event.type === 'banner-show') {
        setBanners((prev) => upsert(prev, toActive(event)));
        return;
      }
      if (event.type === 'banner-clear') {
        setBanners((prev) => prev.filter((b) => b.id !== event.id));
      }
    });
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

  // Only claim `d` while there's something to dismiss — otherwise we'd intercept a keystroke any view-level handler
  // might want for its own use.
  useInput((input) => {
    if (overlay.modalOpen) return;
    if (input === 'd' && sorted.length > 0 && !isClaimed('d')) dismissTop();
  });

  if (sorted.length === 0) return null;

  const visible = sorted.slice(0, MAX_VISIBLE);
  const overflow = Math.max(0, sorted.length - MAX_VISIBLE);

  return (
    <Box flexDirection="column" flexShrink={0}>
      {visible.map((banner) => (
        <BannerRow key={banner.id} banner={banner} dismissable={!isClaimed('d')} />
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
  /** `false` while the active view claims `d` — the banner then does not advertise a dead key. */
  readonly dismissable: boolean;
}

/**
 * Threshold above which a `cause` string forces the two-line layout — headline on row 1, cause + dismiss hint on a
 * dim row 2.
 */
const LONG_CAUSE_THRESHOLD = 60;

const BannerRow = ({ banner, dismissable }: BannerRowProps): React.JSX.Element => {
  const color = tones[TIER_TONE[banner.tier]].color;
  const glyph = tones[TIER_TONE[banner.tier]].glyph;
  // Info tier renders dim to read as "ambient" rather than "alarm"; warn/error stay bold so they punch above the
  // surrounding chrome.
  const isInfo = banner.tier === 'info';
  const isMultiline = banner.cause !== undefined && banner.cause.length > LONG_CAUSE_THRESHOLD;
  if (isMultiline) {
    return (
      <Box paddingX={spacing.indent} flexDirection="column">
        <Text color={color} bold={!isInfo} dimColor={isInfo}>
          {glyph} {banner.message}
        </Text>
        <Text dimColor>
          {banner.cause}
          {dismissable ? ' (press d to dismiss)' : ''}
        </Text>
      </Box>
    );
  }
  return (
    <Box paddingX={spacing.indent}>
      <Text wrap="truncate-end">
        <Text color={color} bold={!isInfo} dimColor={isInfo}>
          {glyph} {banner.message}
        </Text>
        {banner.cause !== undefined ? <Text dimColor> {banner.cause}</Text> : null}
        {dismissable ? <Text dimColor> (press d to dismiss)</Text> : null}
      </Text>
    </Box>
  );
};
