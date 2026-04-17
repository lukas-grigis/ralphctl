import { describe, expect, it } from 'vitest';
import { buildHeadlessAiRequest, parsePlanningBlocked } from './plan-utils.ts';

describe('parsePlanningBlocked', () => {
  it('returns trimmed reason for single-line signal', () => {
    const output = '<planning-blocked>Repository not accessible: /path/to/repo</planning-blocked>';
    expect(parsePlanningBlocked(output)).toBe('Repository not accessible: /path/to/repo');
  });

  it('returns trimmed reason for multiline signal', () => {
    const output = `Some output before
<planning-blocked>
Requirements conflict:
- Ticket A wants feature X removed
- Ticket B wants feature X extended
</planning-blocked>
Some output after`;
    expect(parsePlanningBlocked(output)).toBe(
      'Requirements conflict:\n- Ticket A wants feature X removed\n- Ticket B wants feature X extended'
    );
  });

  it('returns null when no signal present', () => {
    const output = 'Just some normal AI output with no signal';
    expect(parsePlanningBlocked(output)).toBeNull();
  });

  it('trims extra whitespace from signal content', () => {
    const output = '<planning-blocked>   Cannot plan: missing API docs   </planning-blocked>';
    expect(parsePlanningBlocked(output)).toBe('Cannot plan: missing API docs');
  });

  it('returns empty string for empty signal', () => {
    const output = '<planning-blocked></planning-blocked>';
    expect(parsePlanningBlocked(output)).toBe('');
  });
});

describe('buildHeadlessAiRequest', () => {
  it('returns provider-neutral --add-dir args and keeps prompt separate', () => {
    const request = buildHeadlessAiRequest(['/repo/api', '/repo/web'], 'Plan the sprint');

    expect(request).toEqual({
      args: ['--add-dir', '/repo/api', '--add-dir', '/repo/web'],
      prompt: 'Plan the sprint',
    });
  });

  it('does not include Claude-specific headless flags in extra args', () => {
    const request = buildHeadlessAiRequest(['/repo/api'], 'Ideate this feature');

    expect(request.args).not.toContain('--permission-mode');
    expect(request.args).not.toContain('plan');
    expect(request.args).not.toContain('--print');
    expect(request.args).not.toContain('-p');
  });

  it('returns empty args when no repo paths are provided', () => {
    const request = buildHeadlessAiRequest([], 'Prompt only');

    expect(request).toEqual({
      args: [],
      prompt: 'Prompt only',
    });
  });
});
