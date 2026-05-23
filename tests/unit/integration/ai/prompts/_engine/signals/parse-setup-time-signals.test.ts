import { describe, expect, it } from 'vitest';
import { isoTimestamp } from '@tests/fixtures/domain.ts';
import { setupScriptParser } from '@tests/helpers/legacy-signal-parsers/setup-script/parser.ts';
import { setupSkillParser } from '@tests/helpers/legacy-signal-parsers/setup-skill/parser.ts';
import { verifyScriptParser } from '@tests/helpers/legacy-signal-parsers/verify-script/parser.ts';
import { verifySkillParser } from '@tests/helpers/legacy-signal-parsers/verify-skill/parser.ts';
import { agentsMdParser } from '@tests/helpers/legacy-signal-parsers/agents-md/parser.ts';

const NOW = isoTimestamp('2026-05-09T10:00:00.000Z');

describe('setupScriptParser', () => {
  it('extracts the body as a single-line command (whitespace collapsed)', () => {
    const matches = setupScriptParser.parse('<setup-script>pnpm install --frozen-lockfile</setup-script>', NOW);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.signal).toEqual({
      type: 'setup-script',
      command: 'pnpm install --frozen-lockfile',
      timestamp: NOW,
    });
  });

  it('collapses multi-line bodies into a single shell line (off-contract input, but tolerated)', () => {
    const matches = setupScriptParser.parse('<setup-script>pnpm\n  install\n  --frozen-lockfile</setup-script>', NOW);
    expect(matches[0]?.signal.type === 'setup-script' && matches[0].signal.command).toBe(
      'pnpm install --frozen-lockfile'
    );
  });

  it('matches case-insensitively (Codex echo drift)', () => {
    const matches = setupScriptParser.parse('<SETUP-SCRIPT>pnpm i</SETUP-SCRIPT>', NOW);
    expect(matches).toHaveLength(1);
  });

  it('drops whitespace-only bodies', () => {
    expect(setupScriptParser.parse('<setup-script>   </setup-script>', NOW)).toEqual([]);
    expect(setupScriptParser.parse('<setup-script></setup-script>', NOW)).toEqual([]);
  });

  it('emits each match when the tag appears more than once', () => {
    const text = '<setup-script>pnpm i</setup-script> ... <setup-script>pnpm build</setup-script>';
    const matches = setupScriptParser.parse(text, NOW);
    expect(matches.map((m) => (m.signal.type === 'setup-script' ? m.signal.command : ''))).toEqual([
      'pnpm i',
      'pnpm build',
    ]);
  });
});

describe('verifyScriptParser', () => {
  it('extracts the body as a single-line command', () => {
    const matches = verifyScriptParser.parse('<verify-script>pnpm typecheck && pnpm test</verify-script>', NOW);
    expect(matches[0]?.signal).toEqual({
      type: 'verify-script',
      command: 'pnpm typecheck && pnpm test',
      timestamp: NOW,
    });
  });

  it('drops whitespace-only bodies (parser contract: missing tag means "no proposal")', () => {
    expect(verifyScriptParser.parse('<verify-script>\n</verify-script>', NOW)).toEqual([]);
  });

  it('matches case-insensitively', () => {
    expect(verifyScriptParser.parse('<Verify-Script>pnpm test</Verify-Script>', NOW)).toHaveLength(1);
  });
});

describe('setupSkillParser', () => {
  it('extracts a multi-paragraph body verbatim (whitespace inside preserved, only surrounding trimmed)', () => {
    const body = '## Setup\n\nRun `pnpm install` then `pnpm dev`.\n\nNotes:\n- one\n- two';
    const matches = setupSkillParser.parse(`<setup-skill>\n${body}\n</setup-skill>`, NOW);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.signal).toEqual({
      type: 'setup-skill-proposal',
      content: body,
      timestamp: NOW,
    });
  });

  it('drops whitespace-only bodies', () => {
    expect(setupSkillParser.parse('<setup-skill>\n   \n</setup-skill>', NOW)).toEqual([]);
  });

  it('does NOT match the unrelated <setup-script> tag', () => {
    expect(setupSkillParser.parse('<setup-script>pnpm i</setup-script>', NOW)).toEqual([]);
  });
});

describe('verifySkillParser', () => {
  it('extracts a multi-paragraph body verbatim', () => {
    const body = '## Verify\n\n1. Run `pnpm test`\n2. Inspect output';
    const matches = verifySkillParser.parse(`<verify-skill>\n${body}\n</verify-skill>`, NOW);
    expect(matches[0]?.signal).toEqual({
      type: 'verify-skill-proposal',
      content: body,
      timestamp: NOW,
    });
  });

  it('drops whitespace-only bodies', () => {
    expect(verifySkillParser.parse('<verify-skill>   </verify-skill>', NOW)).toEqual([]);
  });

  it('does NOT match the unrelated <verify-script> tag', () => {
    expect(verifySkillParser.parse('<verify-script>pnpm test</verify-script>', NOW)).toEqual([]);
  });
});

describe('agentsMdParser', () => {
  it('captures a `<claude-md>` block as an agents-md-proposal with the originating tag', () => {
    const body = '# Project Memory\n\nUse pnpm, not npm.';
    const matches = agentsMdParser.parse(`<claude-md>\n${body}\n</claude-md>`, NOW);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.signal).toEqual({
      type: 'agents-md-proposal',
      tag: 'claude-md',
      content: body,
      timestamp: NOW,
    });
  });

  it('captures a `<copilot-instructions>` block as an agents-md-proposal with the originating tag', () => {
    const body = '# Copilot Instructions\n\n…';
    const matches = agentsMdParser.parse(`<copilot-instructions>\n${body}\n</copilot-instructions>`, NOW);
    expect(matches[0]?.signal).toEqual({
      type: 'agents-md-proposal',
      tag: 'copilot-instructions',
      content: body,
      timestamp: NOW,
    });
  });

  it('captures an `<agents-md>` block as an agents-md-proposal with the originating tag', () => {
    const matches = agentsMdParser.parse('<agents-md>codex context</agents-md>', NOW);
    expect(matches[0]?.signal).toEqual({
      type: 'agents-md-proposal',
      tag: 'agents-md',
      content: 'codex context',
      timestamp: NOW,
    });
  });

  it('matches case-insensitively for all three wire tags (Codex echo drift)', () => {
    expect(agentsMdParser.parse('<CLAUDE-MD>x</CLAUDE-MD>', NOW)).toHaveLength(1);
    expect(agentsMdParser.parse('<Copilot-Instructions>x</Copilot-Instructions>', NOW)).toHaveLength(1);
    expect(agentsMdParser.parse('<Agents-Md>x</Agents-Md>', NOW)).toHaveLength(1);
  });

  it('drops whitespace-only bodies', () => {
    expect(agentsMdParser.parse('<claude-md>   </claude-md>', NOW)).toEqual([]);
  });

  it('emits one match per tag occurrence even when multiple appear', () => {
    const text = '<claude-md>a</claude-md>\n<agents-md>b</agents-md>';
    const matches = agentsMdParser.parse(text, NOW);
    expect(matches.map((m) => (m.signal.type === 'agents-md-proposal' ? m.signal.tag : ''))).toEqual([
      'claude-md',
      'agents-md',
    ]);
  });
});
