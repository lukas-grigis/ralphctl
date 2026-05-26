/**
 * `createCopilotSkillsAdapter` — {@link SkillsAdapter} for the GitHub Copilot provider. Writes
 * each skill to `<sessionDir>/.github/skills/<name>/SKILL.md`, the documented project-level
 * path Copilot CLI scans (see
 * https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills).
 *
 * Logic (project-skills-win, manifest-tracked uninstall, idempotent install) lives in
 * {@link createFilesystemSkillsAdapter} — shared with the claude and codex variants.
 *
 * Note: Copilot also scans `.claude/skills/` and `.agents/skills/` if present, but `.github/`
 * is the canonical Copilot-native location and what the CLI's docs steer authors toward.
 */

import { createFilesystemSkillsAdapter } from '@src/integration/ai/skills/_engine/filesystem-skills-adapter.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { CreateCopilotSkillsAdapterDeps } from '@src/integration/ai/skills/_engine/copilot-skills-adapter-deps.ts';

const CONVENTION = [
  'Skills live under `.github/skills/<name>/SKILL.md` in this repository. Each `SKILL.md`',
  'starts with a YAML frontmatter block (`name`, `description`) followed by the markdown',
  'body. Before drafting, list `.github/skills/` and read the `SKILL.md` of any folder',
  'whose `name` or `description` hints at sprint setup or post-task verification.',
].join(' ');

export const createCopilotSkillsAdapter = (deps: CreateCopilotSkillsAdapterDeps = {}): SkillsAdapter =>
  createFilesystemSkillsAdapter({
    providerId: 'github-copilot',
    parentDir: '.github',
    convention: CONVENTION,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  });
