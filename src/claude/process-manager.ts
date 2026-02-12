import type { ChildProcess } from 'node:child_process';
import { EXIT_INTERRUPTED } from '@src/utils/exit-codes.ts';

/**
 * Graceful shutdown timeout - how long to wait for children to exit after SIGTERM
 */
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5000;

/**
 * Double-signal window - time window for second Ctrl+C to trigger force-quit
 */
const FORCE_QUIT_WINDOW_MS = 5000;

/**
 * Singleton manager for all Claude child processes.
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

  /** All active Claude child processes */
  private children = new Set<ChildProcess>();

  /** Cleanup callbacks (for stopping spinners, removing temp files) */
  private cleanupCallbacks = new Set<() => void>();

  /** Whether we're currently shutting down */
  private exiting = false;

  /** Whether signal handlers have been installed */
  private handlersInstalled = false;

  /** Timestamp of first SIGINT (for double-signal detection) */
  private firstSigintAt: number | null = null;

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
          console.warn(`Warning: Permission denied killing process ${String(child.pid)}`);
        } else {
          // Unknown error - log but continue
          console.error(`Error killing process ${String(child.pid)}:`, error.message);
        }
      }
    }
  }

  /**
   * Graceful shutdown sequence:
   * 1. Run all cleanup callbacks (stop spinners)
   * 2. Send SIGTERM to all children (graceful)
   * 3. Wait up to 5 seconds for children to exit
   * 4. Send SIGKILL to any remaining children (force)
   * 5. Exit with code 130 (SIGINT) or 1 (force-quit)
   */
  public async shutdown(signal: NodeJS.Signals): Promise<void> {
    if (this.exiting) {
      return; // Already shutting down
    }

    this.exiting = true;

    // Check for double-signal (force-quit)
    const now = Date.now();
    if (signal === 'SIGINT' && this.firstSigintAt && now - this.firstSigintAt < FORCE_QUIT_WINDOW_MS) {
      console.log('\n\nForce quit (double signal) - killing all processes immediately...');
      this.killAll('SIGKILL');
      process.exit(1);
      return;
    }

    // First SIGINT - record timestamp
    if (signal === 'SIGINT' && !this.firstSigintAt) {
      this.firstSigintAt = now;
    }

    console.log('\n\nShutting down gracefully... (press Ctrl+C again to force-quit)');

    // Run cleanup callbacks
    for (const callback of this.cleanupCallbacks) {
      try {
        callback();
      } catch (err) {
        const error = err as Error;
        console.error('Error in cleanup callback:', error.message);
      }
    }
    this.cleanupCallbacks.clear();

    // Send SIGTERM to all children (graceful)
    this.killAll('SIGTERM');

    // Wait for children to exit (with timeout)
    const waitStart = Date.now();
    while (this.children.size > 0 && Date.now() - waitStart < GRACEFUL_SHUTDOWN_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Force-kill any remaining children
    if (this.children.size > 0) {
      console.log(`Force-killing ${String(this.children.size)} remaining process(es)...`);
      this.killAll('SIGKILL');
    }

    // Exit with appropriate code
    process.exit(signal === 'SIGINT' ? EXIT_INTERRUPTED : 1);
  }

  /**
   * Install signal handlers for SIGINT and SIGTERM.
   * Uses process.on() (persistent) not process.once() (one-shot).
   */
  private installSignalHandlers(): void {
    process.on('SIGINT', () => {
      void this.shutdown('SIGINT');
    });

    process.on('SIGTERM', () => {
      void this.shutdown('SIGTERM');
    });
  }

  /**
   * Clean up all resources (for testing).
   * @internal
   */
  public dispose(): void {
    this.children.clear();
    this.cleanupCallbacks.clear();
    this.exiting = false;
    this.handlersInstalled = false;
    this.firstSigintAt = null;
  }
}
