import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeProvider } from '@src/integration/ai/providers/claude/headless.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';

const posix = process.platform !== 'win32';

// Through the default spawn: the override must reach the child AND keep the inherited environment.
describe.skipIf(!posix)('claude headless spawn environment', () => {
  it('disables fork subagents in the real child without dropping the inherited env', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'ralphctl-claude-env-'));
    const command = join(dir, 'claude');
    const out = join(dir, 'env.txt');
    const script = [
      '#!/bin/sh',
      'cat > /dev/null',
      `printf '%s\\n%s\\n' "$CLAUDE_CODE_FORK_SUBAGENT" "$RALPHCTL_ENV_PROBE" > "${out}"`,
      'exit 0',
      '',
    ].join('\n');
    await fs.writeFile(command, script, { mode: 0o755 });
    process.env['RALPHCTL_ENV_PROBE'] = 'inherited';
    try {
      const provider = createClaudeProvider({ rateLimitRetries: 0, eventBus: createCapturingBus().bus, command });
      await provider.generate({
        prompt: 'stub prompt' as Prompt,
        cwd: absolutePath(dir),
        model: 'claude-sonnet-4-6',
        permissions: READ_ONLY,
        signalsFile: absolutePath(join(dir, 'signals.json')),
      });
    } finally {
      delete process.env['RALPHCTL_ENV_PROBE'];
    }
    expect((await fs.readFile(out, 'utf8')).split('\n')).toEqual(['0', 'inherited', '']);
  });
});
