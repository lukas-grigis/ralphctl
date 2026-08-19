import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = fileURLToPath(new URL('../../../.github/workflows/release.yml', import.meta.url));
const WORKFLOW_TEXT = readFileSync(WORKFLOW_PATH, 'utf8');

const PERFORMANCE_DOC_PATH = fileURLToPath(new URL('../../../.claude/docs/PERFORMANCE.md', import.meta.url));
const PERFORMANCE_DOC_TEXT = readFileSync(PERFORMANCE_DOC_PATH, 'utf8');

describe('release workflow tag triggers', () => {
  it('triggers on both the stable and the pre-release tag glob', () => {
    // Actions ref filters full-match, and `[0-9]+` cannot express an optional suffix — so the
    // pre-release path needs its own pattern. Dropping it makes `v0.20.0-rc.1` a silent no-op.
    expect(WORKFLOW_TEXT).toContain("- 'v[0-9]+.[0-9]+.[0-9]+'");
    expect(WORKFLOW_TEXT).toContain("- 'v[0-9]+.[0-9]+.[0-9]+-*'");
  });

  it('routes a hyphenated version to the `next` npm dist-tag', () => {
    expect(WORKFLOW_TEXT).toContain('*-*) echo "npm_tag=next" >> "$GITHUB_OUTPUT" ;;');
    expect(WORKFLOW_TEXT).toContain('*) echo "npm_tag=latest" >> "$GITHUB_OUTPUT" ;;');
  });

  it('publishes under the computed dist-tag rather than defaulting to `latest`', () => {
    // Without `--tag`, npm puts a pre-release on `latest`, which a bare `npm i ralphctl`
    // resolves to and which `compareVersions` assumes is always stable.
    expect(WORKFLOW_TEXT).toContain(
      'pnpm publish --no-git-checks --provenance --tag "${{ steps.version.outputs.npm_tag }}"'
    );
  });

  it('keeps the now-live prerelease flag on the GitHub Release', () => {
    expect(WORKFLOW_TEXT).toContain("prerelease: ${{ contains(github.ref_name, '-') }}");
  });
});

describe('release procedure documentation', () => {
  it('documents the pre-release glob and an example tag the workflow accepts', () => {
    // Doc/workflow drift is the exact defect this test fences: the doc used to promise a
    // pre-release path the trigger rejected. Assertions stay loose so prose edits do not thrash.
    expect(PERFORMANCE_DOC_TEXT).toContain('v[0-9]+.[0-9]+.[0-9]+-*');
    expect(PERFORMANCE_DOC_TEXT).toContain('v0.20.0-rc.1');
  });
});
