import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { ProcessManager } from './process-manager.ts';

// Mock ChildProcess for testing
class MockChildProcess extends EventEmitter {
  public pid = Math.floor(Math.random() * 10000);
  public killed = false;

  public kill(): boolean {
    this.killed = true;
    this.emit('close', 0);
    return true;
  }
}

describe('ProcessManager', () => {
  let manager: ProcessManager;

  beforeEach(() => {
    // Reset singleton before each test
    ProcessManager.resetForTesting();
    manager = ProcessManager.getInstance();
  });

  afterEach(() => {
    // Clean up after each test
    ProcessManager.resetForTesting();
    vi.restoreAllMocks();
  });

  describe('singleton pattern', () => {
    it('should return the same instance', () => {
      const instance1 = ProcessManager.getInstance();
      const instance2 = ProcessManager.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should reset instance for testing', () => {
      const instance1 = ProcessManager.getInstance();
      ProcessManager.resetForTesting();
      const instance2 = ProcessManager.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('child registration', () => {
    it('should register a child process', () => {
      const child = new MockChildProcess() as unknown as ChildProcess;
      expect(() => {
        manager.registerChild(child);
      }).not.toThrow();
    });

    it('should throw error when registering during shutdown', async () => {
      // Mock process.exit to prevent actual exit
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      // Trigger shutdown (this will throw due to mocked exit)
      try {
        await manager.shutdown('SIGINT');
      } catch {
        // Expected
      }

      // Now registration should fail
      const child2 = new MockChildProcess() as unknown as ChildProcess;
      expect(() => {
        manager.registerChild(child2);
      }).toThrow('Cannot register child process during shutdown');

      exitSpy.mockRestore();
    });

    it('should automatically unregister child on close event', () => {
      const child = new MockChildProcess() as unknown as ChildProcess;
      manager.registerChild(child);

      // Emit close event
      child.emit('close', 0);

      // Child should be auto-unregistered
      // We can't directly verify the Set size, but we can verify killAll doesn't try to kill it
      const killSpy = vi.spyOn(child, 'kill');
      manager.killAll('SIGTERM');
      expect(killSpy).not.toHaveBeenCalled();
    });

    it('should manually unregister a child', () => {
      const child = new MockChildProcess() as unknown as ChildProcess;
      manager.registerChild(child);
      manager.unregisterChild(child);

      // Verify child is no longer tracked
      const killSpy = vi.spyOn(child, 'kill');
      manager.killAll('SIGTERM');
      expect(killSpy).not.toHaveBeenCalled();
    });
  });

  describe('cleanup callbacks', () => {
    it('should register and deregister cleanup callback', async () => {
      const callback = vi.fn();
      const deregister = manager.registerCleanup(callback);

      // Deregister immediately
      deregister();

      // Callback should not run during shutdown
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      try {
        await manager.shutdown('SIGINT');
      } catch {
        // Expected
      }

      expect(callback).not.toHaveBeenCalled();
      exitSpy.mockRestore();
    });

    it('should handle errors in cleanup callbacks', async () => {
      const errorCallback = vi.fn(() => {
        throw new Error('Cleanup error');
      });
      const normalCallback = vi.fn();

      manager.registerCleanup(errorCallback);
      manager.registerCleanup(normalCallback);

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
        // Mock implementation
      });

      try {
        await manager.shutdown('SIGINT');
      } catch {
        // Expected
      }

      // Both callbacks should have been called despite error
      expect(errorCallback).toHaveBeenCalled();
      expect(normalCallback).toHaveBeenCalled();

      // Error should have been logged
      expect(consoleErrorSpy).toHaveBeenCalledWith('Error in cleanup callback:', 'Cleanup error');

      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('killAll', () => {
    it('should kill all registered children with given signal', () => {
      const child1 = new MockChildProcess() as unknown as ChildProcess;
      const child2 = new MockChildProcess() as unknown as ChildProcess;

      const kill1 = vi.spyOn(child1, 'kill');
      const kill2 = vi.spyOn(child2, 'kill');

      manager.registerChild(child1);
      manager.registerChild(child2);

      manager.killAll('SIGTERM');

      expect(kill1).toHaveBeenCalledWith('SIGTERM');
      expect(kill2).toHaveBeenCalledWith('SIGTERM');
    });

    it('should handle ESRCH error (process already dead)', () => {
      const child = new MockChildProcess() as unknown as ChildProcess;
      manager.registerChild(child);

      const killSpy = vi.spyOn(child, 'kill').mockImplementation(() => {
        const err = new Error('Process not found') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      });

      // Should not throw
      expect(() => {
        manager.killAll('SIGTERM');
      }).not.toThrow();
      expect(killSpy).toHaveBeenCalled();
    });

    it('should handle EPERM error (permission denied)', () => {
      const child = new MockChildProcess() as unknown as ChildProcess;
      manager.registerChild(child);

      const killSpy = vi.spyOn(child, 'kill').mockImplementation(() => {
        const err = new Error('Permission denied') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      });

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
        // Mock implementation
      });

      // Should not throw
      expect(() => {
        manager.killAll('SIGTERM');
      }).not.toThrow();
      expect(killSpy).toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Permission denied'));

      consoleWarnSpy.mockRestore();
    });

    it('should handle unknown errors', () => {
      const child = new MockChildProcess() as unknown as ChildProcess;
      manager.registerChild(child);

      const killSpy = vi.spyOn(child, 'kill').mockImplementation(() => {
        throw new Error('Unknown error');
      });

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
        // Mock implementation
      });

      // Should not throw
      expect(() => {
        manager.killAll('SIGTERM');
      }).not.toThrow();
      expect(killSpy).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });

  describe('shutdown', () => {
    it('should run cleanup callbacks during shutdown', async () => {
      const callback = vi.fn();
      manager.registerCleanup(callback);

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      try {
        await manager.shutdown('SIGINT');
      } catch {
        // Expected
      }

      expect(callback).toHaveBeenCalled();
      exitSpy.mockRestore();
    });

    it('should kill children with SIGINT then SIGKILL if they do not exit', async () => {
      vi.useFakeTimers();

      const child = new MockChildProcess() as unknown as ChildProcess;
      manager.registerChild(child);

      // Override kill to not emit close event (simulate hung process)
      const killSpy = vi.spyOn(child, 'kill').mockImplementation(() => {
        return true;
      });

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      const shutdownPromise = manager.shutdown('SIGINT').catch(() => {
        // Expected - process.exit throws
      });

      // Fast-forward past the graceful shutdown timeout
      await vi.advanceTimersByTimeAsync(5100);
      await shutdownPromise;

      // Should have called kill with SIGINT first (graceful), then SIGKILL (force)
      expect(killSpy).toHaveBeenCalledWith('SIGINT');
      expect(killSpy).toHaveBeenCalledWith('SIGKILL');

      exitSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should exit with code 130 for SIGINT', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      try {
        await manager.shutdown('SIGINT');
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(130);
      exitSpy.mockRestore();
    });

    it('should exit with code 1 for SIGTERM', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      try {
        await manager.shutdown('SIGTERM');
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('should force-quit on double SIGINT', async () => {
      vi.useFakeTimers();

      const child = new MockChildProcess() as unknown as ChildProcess;
      // Don't emit close on kill — simulate hung process
      const killSpy = vi.spyOn(child, 'kill').mockImplementation(() => true);
      manager.registerChild(child);

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      // First SIGINT — starts graceful shutdown (async, enters polling loop)
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      const firstShutdown = manager.shutdown('SIGINT').catch(() => {});

      // Advance just a little (1s) — first shutdown is still in polling loop
      await vi.advanceTimersByTimeAsync(1000);

      // Second SIGINT within 5s window — should force-quit immediately
      try {
        await manager.shutdown('SIGINT');
      } catch {
        // Expected — process.exit throws
      }

      expect(killSpy).toHaveBeenCalledWith('SIGKILL');
      expect(exitSpy).toHaveBeenCalledWith(1);

      // Clean up the first shutdown promise
      await vi.advanceTimersByTimeAsync(5000);
      await firstShutdown;

      exitSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should silently ignore duplicate non-SIGINT shutdown', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      try {
        await manager.shutdown('SIGTERM');
      } catch {
        // Expected
      }

      // Second SIGTERM should return immediately (no force-quit for non-SIGINT)
      const exitCallCount = exitSpy.mock.calls.length;
      try {
        await manager.shutdown('SIGTERM');
      } catch {
        // Expected
      }

      expect(exitSpy.mock.calls.length).toBe(exitCallCount);

      exitSpy.mockRestore();
    });
  });

  describe('dispose', () => {
    it('should clear all state', () => {
      const child = new MockChildProcess() as unknown as ChildProcess;
      const callback = vi.fn();

      manager.registerChild(child);
      manager.registerCleanup(callback);

      manager.dispose();

      // Verify cleanup doesn't run after dispose
      const killSpy = vi.spyOn(child, 'kill');
      manager.killAll('SIGTERM');
      expect(killSpy).not.toHaveBeenCalled();
    });
  });
});
