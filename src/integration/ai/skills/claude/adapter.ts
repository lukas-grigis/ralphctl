/**
 * `createClaudeSkillsAdapter` — {@link SkillsAdapter} for the Claude Code provider. Writes
 * each skill to `<sessionDir>/.claude/skills/<name>/SKILL.md` so the running `claude` CLI
 * auto-discovers it. Frontmatter follows the Agent Skills open standard.
 *
 * Logic (project-skills-win, manifest-tracked uninstall, idempotent install) lives in
 * {@link createFilesystemSkillsAdapter} — Claude shares it with the codex and copilot
 * skills adapters, which only differ in `parentDir` and the convention text.
 */

import { createFilesystemSkillsAdapter } from '@src/integration/ai/skills/_engine/filesystem-skills-adapter.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { CreateClaudeSkillsAdapterDeps } from '@src/integration/ai/skills/_engine/claude-skills-adapter-deps.ts';

const CONVENTION = [
  'Skills live under `.claude/skills/<name>/SKILL.md` in this repository. Each `SKILL.md`',
  'starts with a YAML frontmatter block (`name`, `description`) followed by the markdown',
  'body. Before drafting, list `.claude/skills/` and read the `SKILL.md` of any folder',
  'whose `name` or `description` hints at sprint setup or post-task verification.',
].join(' ');

export const createClaudeSkillsAdapter = (deps: CreateClaudeSkillsAdapterDeps = {}): SkillsAdapter =>
  createFilesystemSkillsAdapter({
    providerId: 'claude-code',
    parentDir: '.claude',
    convention: CONVENTION,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  });
