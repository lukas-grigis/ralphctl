import type { ChildProcess } from 'node:child_process';
import { EXIT_INTERRUPTED } from '@src/utils/exit-codes.ts';
import { log } from '@src/theme/ui.ts';

/**
 * Graceful shutdown timeout - how long to wait for children to exit after SIGTERM
 */
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5000;

/**
 * Double-signal window - time window for second Ctrl+C to trigger force-quit
 */
const FORCE_QUIT_WINDOW_MS = 5000;

/**
 * Singleton manager for all AI provider child processes.
 * Ensures proper cleanup on SIGINT/SIGTERM with graceful shutdown sequence.
 *
 * Features:
 * - First SIGINT: Graceful shutdown (SIGTERM to children, wait 5s, then SIGKILL)
 * - Second SIGINT (within 5s): Force-quit (immediate SIGKILL, exit code 1)
 * - Exit code 130 for SIGINT (standard Unix convention: 128 + 2)
 * - Automatic child cleanup via event listeners
 * - Cleanup callbacks for spinners and temp resources
 */
export class ProcessManager {
  private static instance: ProcessManager | null = null;

  /** All active AI child processes */
  private children = new Set<ChildProcess>();

  /** Cleanup callbacks (for stopping spinners, removing temp files) */
  private cleanupCallbacks = new Set<() => void>();

  /** Whether we're currently shutting down */
  private exiting = false;

  /** Whether signal handlers have been installed */
  private handlersInstalled = false;

  /** Timestamp of first SIGINT (for double-signal detection) */
  private firstSigintAt: number | null = null;

  /** Stored signal handler references for cleanup */
  private sigintHandler: (() => void) | null = null;
  private sigtermHandler: (() => void) | null = null;

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get the singleton instance.
   */
  public static getInstance(): ProcessManager {
    ProcessManager.instance ??= new ProcessManager();
    return ProcessManager.instance;
  }

  /**
   * Reset the singleton for testing.
   * @internal
   */
  public static resetForTesting(): void {
    if (ProcessManager.instance) {
      ProcessManager.instance.dispose();
      ProcessManager.instance = null;
    }
  }

  /**
   * Register a child process for tracking.
   * Automatically installs signal handlers on first registration.
   * Throws an error if called during shutdown.
   *
   * @throws Error if called during shutdown
   */
  public registerChild(child: ChildProcess): void {
    if (this.exiting) {
      throw new Error('Cannot register child process during shutdown');
    }

    this.children.add(child);

    // Auto-cleanup when child exits
    child.once('close', () => {
      this.children.delete(child);
    });

    // Install signal handlers on first child registration
    if (!this.handlersInstalled) {
      this.installSignalHandlers();
      this.handlersInstalled = true;
    }
  }

  /**
   * Eagerly install signal handlers without requiring a child registration.
   * Call this at the top of execution loops so Ctrl+C works even before
   * the first AI process is spawned (e.g. while the spinner is visible).
   * Idempotent — safe to call multiple times.
   */
  public ensureHandlers(): void {
    if (!this.handlersInstalled) {
      this.installSignalHandlers();
      this.handlersInstalled = true;
    }
  }

  /**
   * Check if a shutdown is in progress.
   * Used by execution loops to break immediately on Ctrl+C.
   */
  public isShuttingDown(): boolean {
    return this.exiting;
  }

  /**
   * Manually unregister a child process.
   * Normally not needed - children auto-unregister via event listeners.
   */
  public unregisterChild(child: ChildProcess): void {
    this.children.delete(child);
  }

  /**
   * Register a cleanup callback (for spinners, temp files, etc.).
   * Returns a deregister function.
   */
  public registerCleanup(callback: () => void): () => void {
    this.cleanupCallbacks.add(callback);
    return () => {
      this.cleanupCallbacks.delete(callback);
    };
  }

  /**
   * Kill all tracked child processes with the given signal.
   * Catches errors (ESRCH = already dead, EPERM = permission denied).
   */
  public killAll(signal: NodeJS.Signals): void {
    for (const child of this.children) {
      try {
        child.kill(signal);
      } catch (err) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === 'ESRCH') {
          // Process already dead - silently remove
          this.children.delete(child);
        } else if (error.code === 'EPERM') {
          // Permission denied - log warning
          log.warn(`Permission denied killing process ${String(child.pid)}`);
        } else {
          // Unknown error - log but continue
          log.error(`Error killing process ${String(child.pid)}: ${error.message}`);
        }
      }
    }
  }

  /**
   * Graceful shutdown sequence:
   * 1. Run all cleanup callbacks (stop spinners)
   * 2. Send SIGINT to all children (what AI CLI processes expect)
   * 3. Wait up to 5 seconds for children to exit
   * 4. Send SIGKILL to any remaining children (force)
   * 5. Exit with code 130 (SIGINT) or 1 (force-quit)
   *
   * Double Ctrl+C: immediate SIGKILL + exit(1)
   */
  public async shutdown(signal: NodeJS.Signals): Promise<void> {
    // Double-signal force-quit check MUST run before the exiting guard,
    // otherwise the second Ctrl+C is swallowed and force-quit never fires.
    if (signal === 'SIGINT' && this.firstSigintAt) {
      const now = Date.now();
      if (now - this.firstSigintAt < FORCE_QUIT_WINDOW_MS) {
        log.warn('\n\nForce quit (double signal) — killing all processes immediately...');
        this.killAll('SIGKILL');
        process.exit(1);
        return;
      }
    }

    if (this.exiting) {
      return; // Already shutting down (non-SIGINT duplicate)
    }

    this.exiting = true;

    // Record timestamp for double-signal detection
    if (signal === 'SIGINT') {
      this.firstSigintAt = Date.now();
    }

    log.dim('\n\nShutting down gracefully... (press Ctrl+C again to force-quit)');

    // Run cleanup callbacks
    for (const callback of this.cleanupCallbacks) {
      try {
        callback();
      } catch (err) {
        log.error(`Error in cleanup callback: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.cleanupCallbacks.clear();

    // Send SIGINT to children — both Claude and Copilot CLIs handle SIGINT for graceful shutdown.
    // SIGTERM may be ignored by some child process trees.
    this.killAll('SIGINT');

    // Wait for children to exit (with timeout)
    const waitStart = Date.now();
    while (this.children.size > 0 && Date.now() - waitStart < GRACEFUL_SHUTDOWN_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Force-kill any remaining children
    if (this.children.size > 0) {
      log.warn(`Force-killing ${String(this.children.size)} remaining process(es)...`);
      this.killAll('SIGKILL');
    }

    // Exit with appropriate code
    process.exit(signal === 'SIGINT' ? EXIT_INTERRUPTED : 1);
  }

  /**
   * Clean up all resources (for testing).
   * @internal
   */
  public dispose(): void {
    // Remove signal handlers to prevent listener accumulation across test resets
    if (this.sigintHandler) {
      process.removeListener('SIGINT', this.sigintHandler);
      this.sigintHandler = null;
    }
    if (this.sigtermHandler) {
      process.removeListener('SIGTERM', this.sigtermHandler);
      this.sigtermHandler = null;
    }
    this.children.clear();
    this.cleanupCallbacks.clear();
    this.exiting = false;
    this.handlersInstalled = false;
    this.firstSigintAt = null;
  }

  /**
   * Install signal handlers for SIGINT and SIGTERM.
   * Uses process.on() (persistent) not process.once() (one-shot).
   * Stores handler references so dispose() can remove them.
   */
  private installSignalHandlers(): void {
    this.sigintHandler = () => {
      void this.shutdown('SIGINT');
    };
    this.sigtermHandler = () => {
      void this.shutdown('SIGTERM');
    };
    process.on('SIGINT', this.sigintHandler);
    process.on('SIGTERM', this.sigtermHandler);
  }
}
