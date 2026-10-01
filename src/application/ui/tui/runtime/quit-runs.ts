/** Runs a quit would cut short: the sessions still running (one parked on a prompt counts). */

import type { SessionRecord } from '@src/application/ui/tui/runtime/session-manager.ts';

export const countRunning = (sessions: readonly SessionRecord[]): number =>
  sessions.filter((s) => s.descriptor.status === 'running').length;
