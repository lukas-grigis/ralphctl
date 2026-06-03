/**
 * Smoke tests for ProjectDetailView. Renders the project info card + each repo as a
 * focusable card. `a` pushes the add-repository wizard. The view uses a flat field cursor
 * (displayName → repo1.name → repo1.setupScript → repo1.verifyScript → repo2.name → …) and
 * `e` / ↵ open the field editor directly without a choice prompt.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { ProjectDetailView } from '@src/application/ui/tui/views/project-detail-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { FIXED_PROJECT_ID, makeProject, makeRepository, repositoryId, slug } from '@tests/fixtures/domain.ts';
import { DOWN, ENTER, tick, UP, waitFor } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const fakeProjectRepo = (project: Project): ProjectRepository =>
  ({
    async findById() {
      return Result.ok(project);
    },
    async save() {
      return Result.ok(undefined);
    },
  }) as unknown as ProjectRepository;

const stubDeps = (project: Project): AppDeps =>
  ({
    projectRepo: fakeProjectRepo(project),
  }) as unknown as AppDeps;

const SECOND_REPO_ID = repositoryId('01900000-0000-7000-8000-000000000099');

const makeTwoRepoProject = (): Project => {
  const repo1 = makeRepository();
  const repo2 = makeRepository({ id: SECOND_REPO_ID, slug: 'second', name: 'second-repo', path: '/tmp/second' });
  return makeProject({ repositories: [repo1, repo2] });
};

/**
 * Locate the line in `frame` that contains BOTH labels — e.g. "Name" + the project's
 * displayName. The status bar and the in-card field both mention the name, so a single-needle
 * search is ambiguous; pairing with the column label disambiguates to the focusable row.
 */
const lineWithLabelAndValue = (frame: string, label: string, value: string): string | undefined =>
  frame.split('\n').find((l) => l.includes(label) && l.includes(value));

/** Return the line that holds a repository's bold name row — `   <cursor> <name> (<slug>)`. */
const repoNameLine = (frame: string, repoName: string, repoSlug: string): string | undefined =>
  frame.split('\n').find((l) => l.includes(`${repoName} (${repoSlug})`));

describe('ProjectDetailView', () => {
  it('renders the project name + slug + repository roster', async () => {
    const project = makeProject({ displayName: 'Mainline', slug: 'mainline' });
    const { result } = renderView(<ProjectDetailView />, {
      deps: stubDeps(project),
      initial: { id: 'project-detail', props: { projectId: project.id } },
    });
    await waitForViewReady(result);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Mainline');
    expect(frame).toContain('mainline');
    expect(frame).toContain('main-repo');
    expect(frame).toContain('Repositories');
    result.unmount();
  });

  it('advertises the navigate / select / edit hints the view actually responds to', async () => {
    const project = makeTwoRepoProject();
    const { result } = renderView(<ProjectDetailView />, {
      deps: stubDeps(project),
      initial: { id: 'project-detail', props: { projectId: project.id } },
    });
    await waitForViewReady(result);
    const frame = result.lastFrame() ?? '';
    // Previously-omitted keys the view handles must be advertised (audit L17).
    expect(frame).toContain('navigate');
    expect(frame).toContain('confirm/select');
    expect(frame).toContain('edit field');
    result.unmount();
  });

  it('hides the repo-only d/c/S hints on the project displayName row, shows them on a repo row', async () => {
    const project = makeTwoRepoProject();
    const { result } = renderView(<ProjectDetailView />, {
      deps: stubDeps(project),
      initial: { id: 'project-detail', props: { projectId: project.id } },
    });
    await waitForViewReady(result);
    // Initial focus is the project displayName — the repo-scoped chords are no-ops there, so the
    // footer must not advertise them.
    const onProjectRow = result.lastFrame() ?? '';
    expect(onProjectRow).not.toContain('remove repo');
    expect(onProjectRow).not.toContain('detect scripts');
    expect(onProjectRow).not.toContain('detect skills');
    // Move down onto repo 1's name row — now the repo chords are live and must be advertised.
    result.stdin.write(DOWN);
    await tick();
    const onRepoRow = result.lastFrame() ?? '';
    expect(onRepoRow).toContain('remove repo');
    expect(onRepoRow).toContain('detect scripts');
    expect(onRepoRow).toContain('detect skills');
    result.unmount();
  });

  it('a pushes the add-repository wizard scoped to this project', async () => {
    const project = makeProject({});
    const { result, routeIds } = renderView(<ProjectDetailView />, {
      deps: stubDeps(project),
      initial: { id: 'project-detail', props: { projectId: project.id } },
    });
    await waitForViewReady(result);
    result.stdin.write('a');
    await tick();
    expect(routeIds()).toContain('add-repository');
    result.unmount();
  });

  it('initial focus lands on the project displayName row', async () => {
    const project = makeProject({ displayName: 'Mainline' });
    const { result } = renderView(<ProjectDetailView />, {
      deps: stubDeps(project),
      initial: { id: 'project-detail', props: { projectId: project.id } },
    });
    await waitForViewReady(result);
    const frame = result.lastFrame() ?? '';
    const nameRow = lineWithLabelAndValue(frame, 'Name', 'Mainline');
    expect(nameRow).toBeDefined();
    expect(nameRow).toContain(glyphs.actionCursor);
  });

  it('↓ moves focus from displayName to repo 1 name', async () => {
    const project = makeProject({ displayName: 'Mainline' });
    const { result } = renderView(<ProjectDetailView />, {
      deps: stubDeps(project),
      initial: { id: 'project-detail', props: { projectId: project.id } },
    });
    await waitForViewReady(result);
    result.stdin.write(DOWN);
    await tick();
    const frame = result.lastFrame() ?? '';
    // Project Name row should no longer carry the cursor glyph.
    const nameRow = lineWithLabelAndValue(frame, 'Name', 'Mainline');
    expect(nameRow).toBeDefined();
    expect(nameRow).not.toContain(glyphs.actionCursor);
    // Repo 1 name row should now carry it.
    const repoLine = repoNameLine(frame, 'main-repo', 'main-repo');
    expect(repoLine).toBeDefined();
    expect(repoLine).toContain(glyphs.actionCursor);
  });

  it('e on a focused setupScript opens the editor directly (no choice prompt)', async () => {
    const project = makeTwoRepoProject();
    const queue = createPromptQueue();
    const { result } = renderView(<ProjectDetailView />, {
      deps: stubDeps(project),
      initial: { id: 'project-detail', props: { projectId: project.id } },
      queue,
    });
    await waitForViewReady(result);
    // displayName → repo1.name → repo1.setupScript (two DOWNs lands on setupScript).
    result.stdin.write(DOWN);
    await tick();
    result.stdin.write(DOWN);
    await tick();
    result.stdin.write('e');
    await tick();
    // setupScript is a long/multi-line edit field → textarea, not text. The point of the test
    // is that the queue head is NOT a 'choice' prompt — we go straight into the editor.
    expect(queue.head?.kind).not.toBe('choice');
    expect(queue.head?.kind).toBe('textarea');
    expect(queue.head?.message ?? '').toContain('setupScript');
    result.unmount();
  });

  it('c / S / d are silent no-ops on the project displayName row; a still opens the wizard', async () => {
    const project = makeProject({});
    const queue = createPromptQueue();
    const { result, routeIds } = renderView(<ProjectDetailView />, {
      deps: stubDeps(project),
      initial: { id: 'project-detail', props: { projectId: project.id } },
      queue,
    });
    await waitForViewReady(result);
    // c / S / d on the project row must NOT push a new route nor queue a prompt and must NOT
    // mount the confirm-remove panel (which would replace the field-list region).
    result.stdin.write('c');
    await tick();
    result.stdin.write('S');
    await tick();
    result.stdin.write('d');
    await tick();
    expect(routeIds()).not.toContain('execute');
    expect(queue.head).toBeUndefined();
    const after = result.lastFrame() ?? '';
    expect(after).not.toContain('Remove repository');
    expect(after).not.toContain('✗');
    // `a` is still active even on the project row.
    result.stdin.write('a');
    await tick();
    expect(routeIds()).toContain('add-repository');
  });

  it('↑ at the first field and ↓ at the last field do not wrap', async () => {
    const project = makeTwoRepoProject();
    const { result } = renderView(<ProjectDetailView />, {
      deps: stubDeps(project),
      initial: { id: 'project-detail', props: { projectId: project.id } },
    });
    await waitForViewReady(result);
    // Already at index 0 → UP stays put.
    result.stdin.write(UP);
    await tick();
    let frame = result.lastFrame() ?? '';
    let nameRow = lineWithLabelAndValue(frame, 'Name', project.displayName);
    expect(nameRow).toContain(glyphs.actionCursor);

    // Walk to the last field: 2 repos × 3 fields + 1 project field = 7 fields, so 6 DOWN
    // presses. The last field is second-repo verifyScript.
    for (let i = 0; i < 6; i++) {
      result.stdin.write(DOWN);
      await tick();
    }
    // The cursor should be on the Verify row of `second-repo` (the LAST repo card). One extra
    // DOWN at the bottom must NOT move focus elsewhere.
    const frameAtBottom = result.lastFrame() ?? '';
    // Locate second-repo's card: its repo-name line and the two field rows below it. The Verify
    // row of the LAST repo is the last `Verify:` line in the frame.
    const verifyLines = frameAtBottom.split('\n').filter((l) => l.includes('Verify:'));
    expect(verifyLines.length).toBe(2);
    expect(verifyLines[verifyLines.length - 1]).toContain(glyphs.actionCursor);

    result.stdin.write(DOWN);
    await tick();
    const afterBoundary = result.lastFrame() ?? '';
    const verifyLinesAfter = afterBoundary.split('\n').filter((l) => l.includes('Verify:'));
    expect(verifyLinesAfter[verifyLinesAfter.length - 1]).toContain(glyphs.actionCursor);

    // Walk back up and an extra UP — must stay on displayName.
    for (let i = 0; i < 6; i++) {
      result.stdin.write(UP);
      await tick();
    }
    result.stdin.write(UP);
    await tick();
    frame = result.lastFrame() ?? '';
    nameRow = lineWithLabelAndValue(frame, 'Name', project.displayName);
    expect(nameRow).toContain(glyphs.actionCursor);
  });

  it('project with no repositories shows only the displayName as focusable', async () => {
    // Bypass createProject's `≥1 repo` aggregate invariant — this is a UI-only test and we want
    // to verify the cursor model degrades gracefully to a one-element list.
    const empty: Project = {
      id: FIXED_PROJECT_ID,
      slug: slug('solo'),
      displayName: 'Solo',
      repositories: [],
    };
    const { result } = renderView(<ProjectDetailView />, {
      deps: stubDeps(empty),
      initial: { id: 'project-detail', props: { projectId: empty.id } },
    });
    await waitForViewReady(result);
    const frame = result.lastFrame() ?? '';
    const nameRow = lineWithLabelAndValue(frame, 'Name', 'Solo');
    expect(nameRow).toBeDefined();
    expect(nameRow).toContain(glyphs.actionCursor);
    // No "main-repo" / repository card in the frame.
    expect(frame).not.toContain('main-repo');
    // DOWN cannot move — cursor stays on the project Name row.
    result.stdin.write(DOWN);
    await tick();
    const after = result.lastFrame() ?? '';
    const nameRowAfter = lineWithLabelAndValue(after, 'Name', 'Solo');
    expect(nameRowAfter).toContain(glyphs.actionCursor);
  });

  it('↵ on the focused project displayName opens the project rename editor', async () => {
    // Belt-and-braces: the requirements list `e` OR Enter as the edit trigger. Make sure ENTER
    // alone works on the initial focus and routes through the same path.
    const project = makeProject({ displayName: 'Mainline' });
    const queue = createPromptQueue();
    const { result } = renderView(<ProjectDetailView />, {
      deps: stubDeps(project),
      initial: { id: 'project-detail', props: { projectId: project.id } },
      queue,
    });
    await waitForViewReady(result);
    result.stdin.write(ENTER);
    await waitFor(() => queue.head !== undefined);
    expect(queue.head?.kind).toBe('text');
    expect(queue.head?.message ?? '').toContain('Rename project');
  });
});
