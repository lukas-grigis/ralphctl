/**
 * `createGrokSkillsAdapter` — {@link SkillsAdapter} for the Grok Build CLI provider. Writes each
 * skill to `<sessionDir>/.grok/skills/<name>/SKILL.md`.
 *
 * Logic (project-skills-win, manifest-tracked uninstall, idempotent install) lives in
 * {@link createFilesystemSkillsAdapter} — shared with the claude, copilot, codex and opencode
 * variants.
 */

import { createFilesystemSkillsAdapter } from '@src/integration/ai/skills/_engine/filesystem-skills-adapter.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { CreateGrokSkillsAdapterDeps } from '@src/integration/ai/skills/_engine/grok-skills-adapter-deps.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';

const CONVENTION = [
  'Skills live under `.grok/skills/<name>/SKILL.md` in this repository. Each `SKILL.md`',
  'starts with a YAML frontmatter block (`name`, `description`) followed by the markdown',
  'body, and the `name` must match its folder. Before drafting, list `.grok/skills/` and',
  'read the `SKILL.md` of any folder whose `name` or `description` hints at sprint setup or',
  'post-task verification.',
].join(' ');

export const createGrokSkillsAdapter = (deps: CreateGrokSkillsAdapterDeps = {}): SkillsAdapter =>
  createFilesystemSkillsAdapter({
    providerId: 'xai-grok',
    parentDir: PROVIDER_TRAITS['xai-grok'].skillsParentDir,
    convention: CONVENTION,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  });
