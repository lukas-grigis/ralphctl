/**
 * `createOpencodeSkillsAdapter` — {@link SkillsAdapter} for the OpenCode provider. Writes each
 * skill to `<sessionDir>/.opencode/skills/<name>/SKILL.md`, OpenCode's documented project-level
 * discovery path (see https://opencode.ai/docs/skills/).
 *
 * Logic (project-skills-win, manifest-tracked uninstall, idempotent install) lives in
 * {@link createFilesystemSkillsAdapter} — shared with the claude, copilot and codex variants.
 */

import { createFilesystemSkillsAdapter } from '@src/integration/ai/skills/_engine/filesystem-skills-adapter.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { CreateOpencodeSkillsAdapterDeps } from '@src/integration/ai/skills/_engine/opencode-skills-adapter-deps.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';

const CONVENTION = [
  'Skills live under `.opencode/skills/<name>/SKILL.md` in this repository. Each `SKILL.md`',
  'starts with a YAML frontmatter block (`name`, `description`) followed by the markdown',
  'body, and the `name` must match its folder. Before drafting, list `.opencode/skills/` and',
  'read the `SKILL.md` of any folder whose `name` or `description` hints at sprint setup or',
  'post-task verification.',
].join(' ');

export const createOpencodeSkillsAdapter = (deps: CreateOpencodeSkillsAdapterDeps = {}): SkillsAdapter =>
  createFilesystemSkillsAdapter({
    providerId: 'opencode',
    parentDir: PROVIDER_TRAITS.opencode.skillsParentDir,
    convention: CONVENTION,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  });
