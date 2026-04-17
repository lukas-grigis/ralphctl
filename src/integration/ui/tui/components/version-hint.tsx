/**
 * VersionHint — dim one-liner shown in the status-bar row when a newer
 * ralphctl is available on npm.
 *
 * The lookup is fully async: it fires once on mount, falls back to the 24h
 * cache under `~/.ralphctl/version-check.json`, and renders nothing until it
 * resolves. On any error (offline, malformed response, timeout) it silently
 * stays hidden — the check must never block or clutter the UI.
 */

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { checkLatestVersion, type VersionCheck } from '@src/integration/external/version-check.ts';

export function VersionHint(): React.JSX.Element | null {
  const [check, setCheck] = useState<VersionCheck | null>(null);

  useEffect(() => {
    let cancelled = false;
    void checkLatestVersion().then((result) => {
      if (!cancelled && result !== null) setCheck(result);
    });
    return (): void => {
      cancelled = true;
    };
  }, []);

  if (!check?.updateAvailable) return null;
  return <Text dimColor>{`v${check.latest} available · npm install -g ralphctl`}</Text>;
}
