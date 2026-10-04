import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCopilotModelAvailabilityProbe } from '@src/integration/ai/providers/copilot/model-availability-probe.ts';
import type { ModelProbeDegradation } from '@src/integration/ai/providers/_engine/model-availability-probe.ts';

const CATALOG = ['claude-sonnet-5.5', 'claude-opus-4.8', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.6-luna'] as const;

// A stand-in `copilot --headless --stdio`: answers `connect` then `models.list` with
// Content-Length-framed JSON-RPC, the same transport the real CLI speaks.
const FAKE_CLI = `#!/usr/bin/env node
let buf = Buffer.alloc(0);
const send = (msg) => { const b = JSON.stringify(msg); process.stdout.write('Content-Length: ' + Buffer.byteLength(b) + '\\r\\n\\r\\n' + b); };
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const h = buf.indexOf('\\r\\n\\r\\n'); if (h < 0) return;
    const len = Number(/Content-Length: (\\d+)/.exec(buf.subarray(0, h).toString())[1]);
    if (buf.length < h + 4 + len) return;
    const req = JSON.parse(buf.subarray(h + 4, h + 4 + len).toString()); buf = buf.subarray(h + 4 + len);
    if (req.method === 'connect') {
      send({ jsonrpc: '2.0', method: 'session.lifecycle', params: {} });
      send({ jsonrpc: '2.0', id: req.id, result: { ok: true, protocolVersion: 3 } });
    }
    if (req.method === 'models.list') send({ jsonrpc: '2.0', id: req.id, result: { models: [
      { id: 'auto' },
      { id: 'claude-sonnet-5.5', policy: { state: 'enabled' } },
      { id: 'claude-opus-4.8', policy: { state: 'enabled' } },
      { id: 'gpt-6.1-sol', policy: { state: 'disabled' } },
      { id: 'gpt-5.6-luna' },
      { id: 'some-future-model', policy: { state: 'enabled' } },
    ] } });
  }
});
`;

let dir: string;
let fakeCli: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'copilot-probe-'));
  fakeCli = join(dir, 'copilot');
  await writeFile(fakeCli, FAKE_CLI, 'utf8');
  await chmod(fakeCli, 0o755);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createCopilotModelAvailabilityProbe', () => {
  it.skipIf(process.platform === 'win32')(
    'narrows the catalog to enabled / policy-less models over the headless JSON-RPC server',
    async () => {
      const probe = createCopilotModelAvailabilityProbe({ command: fakeCli });
      // gpt-6-luna is absent from the answer and gpt-6.1-sol is disabled; models outside the
      // catalog (`auto`, `some-future-model`) never leak into the picker.
      expect(await probe.availableModels(CATALOG)).toEqual(['claude-sonnet-5.5', 'claude-opus-4.8', 'gpt-5.6-luna']);
    }
  );

  it('fails open with probe-failed when the CLI is missing', async () => {
    const seen: ModelProbeDegradation[] = [];
    const probe = createCopilotModelAvailabilityProbe({
      command: join(dir, 'no-such-copilot'),
      onDegraded: (d) => seen.push(d),
    });
    expect(await probe.availableModels(CATALOG)).toBe(CATALOG);
    expect(seen).toEqual([expect.objectContaining({ provider: 'github-copilot', reason: 'probe-failed' })]);
  });

  it('fails open with empty-answer when nothing intersects the catalog', async () => {
    const seen: ModelProbeDegradation[] = [];
    const probe = createCopilotModelAvailabilityProbe({
      listModels: () => Promise.resolve([{ id: 'auto' }, { id: 'claude-opus-4.8', policyState: 'disabled' }]),
      onDegraded: (d) => seen.push(d),
    });
    expect(await probe.availableModels(CATALOG)).toBe(CATALOG);
    expect(seen.map((d) => d.reason)).toEqual(['empty-answer']);
  });

  it('reports an abort as probe-aborted and still resolves to the catalog', async () => {
    const seen: ModelProbeDegradation[] = [];
    const controller = new AbortController();
    controller.abort();
    const probe = createCopilotModelAvailabilityProbe({
      listModels: () => Promise.reject(new Error('aborted')),
      onDegraded: (d) => seen.push(d),
    });
    expect(await probe.availableModels(CATALOG, controller.signal)).toBe(CATALOG);
    expect(seen.map((d) => d.reason)).toEqual(['probe-aborted']);
  });
});
