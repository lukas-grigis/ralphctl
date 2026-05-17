/**
 * `createCodexSkillsAdapter` — {@link SkillsAdapter} for the OpenAI Codex provider. Writes
 * each skill to `<sessionDir>/.agents/skills/<name>/SKILL.md`, which is Codex's documented
 * project-level discovery path (see https://developers.openai.com/codex/skills).
 *
 * Logic (project-skills-win, manifest-tracked uninstall, idempotent install) lives in
 * {@link createFilesystemSkillsAdapter} — shared with the claude and copilot variants.
 */

import { createFilesystemSkillsAdapter } from '@src/integration/ai/skills/_engine/filesystem-skills-adapter.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';

const CONVENTION = [
  'Skills live under `.agents/skills/<name>/SKILL.md` in this repository. Each `SKILL.md`',
  'starts with a YAML frontmatter block (`name`, `description`) followed by the markdown',
  'body. Before drafting, list `.agents/skills/` and read the `SKILL.md` of any folder',
  'whose `name` or `description` hints at sprint setup or post-task verification.',
].join(' ');

export const createCodexSkillsAdapter = (): SkillsAdapter =>
  createFilesystemSkillsAdapter({
    providerId: 'openai-codex',
    parentDir: '.agents',
    convention: CONVENTION,
  });
