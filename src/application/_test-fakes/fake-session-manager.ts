/**
 * `FakeSessionManager` — minimal in-memory `SessionManagerPort` for view tests.
 *
 * Returns vi.fn() spies for every method so tests can assert on calls. The
 * default state is "no live sessions, no active session"; use the `seed`
 * helper to inject pre-built descriptors when a test needs them.
 *
 * For test cases that don't even read the manager (most CRUD form views),
 * pass the bare instance. For tests that exercise the sessions switcher,
 * call `seed(...)` to build a list.
 */
import { vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type {
  SessionDescriptor,
  SessionId,
  SessionManagerEvent,
  SessionManagerPort,
} from '@src/application/runtime/session-manager-port.ts';

let sessionCounter = 0;

export class FakeSessionManager implements SessionManagerPort {
  private readonly sessions: SessionDescriptor[] = [];
  private activeSession: SessionDescriptor | null = null;
  private readonly subscribers = new Set<(event: SessionManagerEvent) => void>();

  readonly startMock = vi.fn();
  readonly listMock = vi.fn();
  readonly getMock = vi.fn();
  readonly foregroundMock = vi.fn();
  readonly backgroundMock = vi.fn();
  readonly killMock = vi.fn();
  readonly disposeMock = vi.fn();

  start(): SessionId {
    this.startMock();
    return `fake-session-${String(++sessionCounter)}`;
  }

  list(): readonly SessionDescriptor[] {
    this.listMock();
    return this.sessions;
  }

  get(id: SessionId): SessionDescriptor | undefined {
    this.getMock(id);
    return this.sessions.find((s) => s.id === id);
  }

  foreground(id: SessionId): Result<void, never> {
    this.foregroundMock(id);
    const found = this.sessions.find((s) => s.id === id);
    if (found) {
      this.activeSession = found;
      this.publish({ type: 'active-changed', sessionId: id });
    }
    return Result.ok();
  }

  background(): Result<void, never> {
    this.backgroundMock();
    this.activeSession = null;
    this.publish({ type: 'active-changed', sessionId: null });
    return Result.ok();
  }

  kill(id: SessionId): Result<void, never> {
    this.killMock(id);
    return Result.ok();
  }

  get active(): SessionDescriptor | null {
    return this.activeSession;
  }

  subscribe(listener: (event: SessionManagerEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  dispose(): Promise<void> {
    this.disposeMock();
    this.subscribers.clear();
    return Promise.resolve();
  }

  /** Seed the registry with pre-built descriptors. Test-only ergonomic. */
  seed(sessions: readonly SessionDescriptor[], active?: SessionDescriptor | null): void {
    this.sessions.length = 0;
    this.sessions.push(...sessions);
    this.activeSession = active ?? null;
  }

  private publish(event: SessionManagerEvent): void {
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // Mirror SessionManager: listener errors don't stall delivery.
      }
    }
  }
}
