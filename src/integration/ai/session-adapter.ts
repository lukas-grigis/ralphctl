import type { AiSessionPort, SessionOptions, SessionResult } from '@src/business/ports/ai-session.ts';
import type { AiProvider } from '@src/domain/models.ts';
import { spawnInteractive, spawnHeadlessRaw, spawnWithRetry } from '@src/integration/ai/session.ts';
import { getActiveProvider } from '@src/integration/ai/providers/registry.ts';
import type { ProviderAdapter } from '@src/integration/ai/providers/types.ts';

export class ProviderAiSessionAdapter implements AiSessionPort {
  private provider: ProviderAdapter | null = null;

  /** Lazily resolve and cache the active provider. */
  private async getProvider(): Promise<ProviderAdapter> {
    this.provider ??= await getActiveProvider();
    return this.provider;
  }

  async spawnInteractive(prompt: string, options: SessionOptions): Promise<void> {
    const provider = await this.getProvider();
    const result = spawnInteractive(
      prompt,
      {
        cwd: options.cwd,
        args: options.args,
        env: options.env,
      },
      provider
    );

    if (result.error) {
      throw new Error(result.error);
    }
  }

  async spawnHeadless(prompt: string, options: SessionOptions): Promise<SessionResult> {
    const provider = await this.getProvider();
    const result = await spawnHeadlessRaw(
      {
        cwd: options.cwd,
        args: options.args,
        env: options.env,
        prompt,
      },
      provider
    );

    return {
      output: result.stdout,
      sessionId: result.sessionId ?? undefined,
      model: result.model ?? undefined,
    };
  }

  async spawnWithRetry(prompt: string, options: SessionOptions & { maxRetries?: number }): Promise<SessionResult> {
    const provider = await this.getProvider();
    const result = await spawnWithRetry(
      {
        cwd: options.cwd,
        args: options.args,
        env: options.env,
        prompt,
      },
      { maxRetries: options.maxRetries },
      provider
    );

    return {
      output: result.stdout,
      sessionId: result.sessionId ?? undefined,
      model: result.model ?? undefined,
    };
  }

  async resumeSession(sessionId: string, prompt: string, options: SessionOptions): Promise<SessionResult> {
    const provider = await this.getProvider();
    const result = await spawnWithRetry(
      {
        cwd: options.cwd,
        args: options.args,
        env: options.env,
        prompt,
        resumeSessionId: sessionId,
      },
      undefined,
      provider
    );

    return {
      output: result.stdout,
      sessionId: result.sessionId ?? undefined,
      model: result.model ?? undefined,
    };
  }

  getProviderName(): AiProvider {
    if (!this.provider) {
      throw new Error('Provider not yet resolved. Call an async method first.');
    }
    return this.provider.name;
  }

  getProviderDisplayName(): string {
    if (!this.provider) {
      throw new Error('Provider not yet resolved. Call an async method first.');
    }
    return this.provider.displayName;
  }

  getSpawnEnv(): Record<string, string> {
    if (!this.provider) {
      throw new Error('Provider not yet resolved. Call an async method first.');
    }
    return this.provider.getSpawnEnv();
  }
}
