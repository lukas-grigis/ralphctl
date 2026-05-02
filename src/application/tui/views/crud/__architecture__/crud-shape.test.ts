/**
 * Architectural fence — CRUD view shape.
 *
 * Every TUI form view under `src/application/tui/views/crud/` follows the
 * same skeleton: `useViewHints` for hotkeys, `useWorkflow` for the spinner +
 * result-card state machine, prompts via `getPrompt()` (never inline Ink
 * input components), and view-local key handling via `useInput`. This test
 * locks the convention.
 *
 * If a new view violates the shape, either fix the view OR — if the new
 * shape is genuinely better — update this test and the existing views.
 * Don't silently let a one-off view rot the established pattern.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CRUD_ROOT = new URL('..', import.meta.url).pathname;

function listCrudViews(): string[] {
  return readdirSync(CRUD_ROOT)
    .filter((f) => f.endsWith('-view.tsx') && !f.endsWith('.test.tsx'))
    .map((f) => join(CRUD_ROOT, f));
}

describe('CRUD view shape', () => {
  const files = listCrudViews();

  it('discovers the expected CRUD view file count', () => {
    // Sanity: at least 18 form views exist today. Bumping this number is
    // fine and expected — dropping it sharply suggests something got
    // accidentally deleted.
    expect(files.length).toBeGreaterThanOrEqual(18);
  });

  it.each(files)('%s uses `useWorkflow` for the spinner/result state machine', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(/\buseWorkflow\b/);
  });

  it.each(files)('%s declares view-local hints via `useViewHints`', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(/\buseViewHints\b/);
  });

  it.each(files)('%s does NOT import @inquirer/prompts (Inquirer is gone)', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(/['"]@inquirer\/prompts['"]/);
  });

  it.each(files)('%s does NOT import a workflow use case directly (use chain factories instead)', (file) => {
    const src = readFileSync(file, 'utf8');
    // Workflow use cases live under refine/plan/ideate/execute/evaluate/
    // feedback/onboard plus the create-pr use case. Direct import in a CRUD
    // form view means the form is doing chain work — that's wrong.
    const forbidden = [
      /['"][^'"]*\/business\/usecases\/refine\//,
      /['"][^'"]*\/business\/usecases\/plan\//,
      /['"][^'"]*\/business\/usecases\/ideate\//,
      /['"][^'"]*\/business\/usecases\/execute\//,
      /['"][^'"]*\/business\/usecases\/evaluate\//,
      /['"][^'"]*\/business\/usecases\/feedback\//,
      /['"][^'"]*\/business\/usecases\/onboard\//,
      /['"][^'"]*\/business\/usecases\/sprint\/create-pull-request/,
    ];
    for (const pattern of forbidden) {
      expect(src, `forbidden import: ${pattern.source}`).not.toMatch(pattern);
    }
  });
});
