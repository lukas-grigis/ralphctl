/**
 * SettingsPanel tests — validate the schema-driven rendering and the
 * default-marker behaviour. We don't drive keyboard input through
 * ink-testing-library (flaky across Ink + useInput versions); instead we
 * assert the rendered frame contains everything the user should see.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

const getConfigMock = vi.fn();
const saveConfigMock = vi.fn();

const selectMock = vi.fn();
const confirmMock = vi.fn();
const inputMock = vi.fn();

vi.mock('@src/integration/bootstrap.ts', () => ({
  getPrompt: () => ({
    select: selectMock,
    confirm: confirmMock,
    input: inputMock,
    checkbox: vi.fn(),
    editor: vi.fn(),
    fileBrowser: vi.fn(),
  }),
  getSharedDeps: () => ({
    persistence: {
      getConfig: getConfigMock,
      saveConfig: saveConfigMock,
    },
  }),
  setSharedDeps: vi.fn(),
}));

import { SettingsPanel } from './settings-panel.tsx';

async function flush(): Promise<void> {
  // Let the initial getConfig() effect resolve and re-render.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('SettingsPanel', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders every schema key with its current value', async () => {
    getConfigMock.mockResolvedValueOnce({
      currentSprint: null,
      aiProvider: 'claude',
      evaluationIterations: 2,
    });

    const { lastFrame } = render(<SettingsPanel onClose={() => undefined} />);
    await flush();

    const frame = lastFrame() ?? '';
    // Panel renders human-friendly labels; SectionStamp above (rendered by
    // SettingsView) owns the "SETTINGS" heading.
    expect(frame).toContain('Current Sprint');
    expect(frame).toContain('AI Provider');
    expect(frame).toContain('Evaluation Iterations');
    expect(frame).toContain('claude');
    expect(frame).toContain('2');
  });

  it('marks values that match the schema default', async () => {
    // evaluationIterations default is 1
    getConfigMock.mockResolvedValueOnce({
      currentSprint: null,
      aiProvider: null,
      evaluationIterations: 1,
    });

    const { lastFrame } = render(<SettingsPanel onClose={() => undefined} />);
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('default');
  });

  it('shows a loading indicator before config resolves', () => {
    getConfigMock.mockReturnValueOnce(new Promise(() => undefined));

    const { lastFrame } = render(<SettingsPanel onClose={() => undefined} />);
    expect(lastFrame() ?? '').toContain('Loading');
  });
});
