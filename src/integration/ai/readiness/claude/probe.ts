import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { ProbeError } from '@src/domain/value/error/probe-error.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { ArtifactRef, HookRef, NamedArtifactRef } from '@src/integration/ai/readiness/_engine/artifact-ref.ts';
import {
  probeFile,
  probeNamedDirCollection,
  probeNamedFileCollection,
  readFileSafely,
} from '@src/integration/ai/readiness/_engine/probe-fs.ts';
import type { ClaudeArtifacts } from '@src/integration/ai/readiness/claude/artifacts.ts';
import { absentState, presentState, type ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';
import { hasAnyClaudeArtifact } from '@src/integration/ai/readiness/_engine/predicates.ts';
import type { ReadinessProbe } from '@src/integration/ai/readiness/_engine/probe.ts';

/**
 * Filesystem probe for Claude Code artifacts. Looks under `repository.path` for:
 *   - CLAUDE.md, AGENTS.md (root memory files)
 *   - .claude/settings.json, .claude/settings.local.json (project config)
 *   - .mcp.json (project MCP config)
 *   - .claude/skills/<name>/SKILL.md (named skill folders)
 *   - .claude/commands/<name>.md (named slash-commands)
 *   - .claude/agents/<name>.md (named subagents)
 *   - hooks declared inside settings.json / settings.local.json
 *
 * Returns `present` iff at least one artifact was discovered. Read errors are surfaced as
 * {@link ProbeError}; "file not present" is a normal absence and contributes nothing to the
 * artifact catalog.
 */
export const claudeProbe: ReadinessProbe<ClaudeArtifacts> = {
  tool: 'claude-code',
  async evaluate(repository: Repository, now: IsoTimestamp): Promise<Result<ReadinessState, ProbeError>> {
    const root = repository.path;

    const coreFiles = await probeCoreFiles(root);
    if (!coreFiles.ok) return Result.error(coreFiles.error);

    const namedArtifacts = await probeNamedArtifacts(root);
    if (!namedArtifacts.ok) return Result.error(namedArtifacts.error);

    const hooks = await readHooks([coreFiles.value.settings, coreFiles.value.settingsLocal]);
    if (!hooks.ok) return Result.error(hooks.error);

    const artifacts = buildClaudeArtifacts(coreFiles.value, namedArtifacts.value, hooks.value);

    return Result.ok(hasAnyClaudeArtifact(artifacts) ? presentState(now, artifacts) : absentState(now));
  },
};

const CORE_FILE_SPECS = [
  ['claudeMd', 'CLAUDE.md'],
  ['agentsMd', 'AGENTS.md'],
  ['settings', '.claude/settings.json'],
  ['settingsLocal', '.claude/settings.local.json'],
  ['mcpConfig', '.mcp.json'],
] as const;

type CoreFiles = Record<(typeof CORE_FILE_SPECS)[number][0], ArtifactRef | undefined>;

/**
 * Probes the flat, single-file artifacts (root memory files + project config) that live
 * directly under `root`. Short-circuits on the first read error.
 */
const probeCoreFiles = async (root: string): Promise<Result<CoreFiles, ProbeError>> => {
  const files = {} as CoreFiles;
  for (const [key, relPath] of CORE_FILE_SPECS) {
    const probed = await probeFile(join(root, relPath));
    if (!probed.ok) return Result.error(probed.error);
    files[key] = probed.value;
  }
  return Result.ok(files);
};

interface NamedArtifacts {
  readonly skills: readonly NamedArtifactRef[];
  readonly commands: readonly NamedArtifactRef[];
  readonly agents: readonly NamedArtifactRef[];
}

/**
 * Probes the named-collection artifacts (skills, commands, subagents) that live under
 * `.claude/<collection>/`.
 */
const probeNamedArtifacts = async (root: string): Promise<Result<NamedArtifacts, ProbeError>> => {
  const skills = await probeNamedDirCollection(join(root, '.claude/skills'), 'SKILL.md');
  if (!skills.ok) return Result.error(skills.error);

  const commands = await probeNamedFileCollection(join(root, '.claude/commands'));
  if (!commands.ok) return Result.error(commands.error);

  const agents = await probeNamedFileCollection(join(root, '.claude/agents'));
  if (!agents.ok) return Result.error(agents.error);

  return Result.ok({ skills: skills.value, commands: commands.value, agents: agents.value });
};

const buildClaudeArtifacts = (
  coreFiles: CoreFiles,
  namedArtifacts: NamedArtifacts,
  hooks: readonly HookRef[]
): ClaudeArtifacts => ({
  tool: 'claude-code',
  ...(coreFiles.claudeMd !== undefined ? { claudeMd: coreFiles.claudeMd } : {}),
  ...(coreFiles.agentsMd !== undefined ? { agentsMd: coreFiles.agentsMd } : {}),
  ...(coreFiles.settings !== undefined ? { settings: coreFiles.settings } : {}),
  ...(coreFiles.settingsLocal !== undefined ? { settingsLocal: coreFiles.settingsLocal } : {}),
  ...(coreFiles.mcpConfig !== undefined ? { mcpConfig: coreFiles.mcpConfig } : {}),
  skills: namedArtifacts.skills,
  commands: namedArtifacts.commands,
  agents: namedArtifacts.agents,
  hooks,
});

const readHooks = async (
  settingsRefs: ReadonlyArray<ArtifactRef | undefined>
): Promise<Result<HookRef[], ProbeError>> => {
  const hooks: HookRef[] = [];
  for (const ref of settingsRefs) {
    if (ref === undefined) continue;
    const text = await readFileSafely(ref.path);
    if (!text.ok) return Result.error(text.error);
    if (text.value === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.value);
    } catch (cause) {
      return Result.error(
        new ProbeError({ subCode: 'malformed', message: `${ref.path} is not valid JSON`, path: ref.path, cause })
      );
    }
    extractHooks(parsed, hooks);
  }
  return Result.ok(hooks);
};

/**
 * Walks a parsed `settings.json` `hooks` field. Claude's hooks shape is `{ <Event>: [ { hooks:
 * [ { type, command }, ... ] } ] }`. We surface every `command` whose string starts with `/`
 * (an absolute path); other shapes (inline shell commands, missing fields) are skipped.
 */
const extractHooks = (settings: unknown, sink: HookRef[]): void => {
  if (typeof settings !== 'object' || settings === null) return;
  const hooks = (settings as Record<string, unknown>).hooks;
  if (typeof hooks !== 'object' || hooks === null) return;
  for (const [event, matchers] of Object.entries(hooks as Record<string, unknown>)) {
    extractHookEvent(matchers, event, sink);
  }
};

/** Second nesting level: `<Event>`'s matcher array — each matcher carries its own `hooks` list. */
const extractHookEvent = (matchers: unknown, event: string, sink: HookRef[]): void => {
  if (!Array.isArray(matchers)) return;
  for (const matcher of matchers) {
    extractHookMatcher(matcher, event, sink);
  }
};

/** Third nesting level: a single matcher's inner `hooks` list of `{ type, command }` entries. */
const extractHookMatcher = (matcher: unknown, event: string, sink: HookRef[]): void => {
  if (typeof matcher !== 'object' || matcher === null) return;
  const inner = (matcher as Record<string, unknown>).hooks;
  if (!Array.isArray(inner)) return;
  for (const entry of inner) {
    pushHookCommand(entry, event, sink);
  }
};

/** Leaf: pushes `entry.command` onto `sink` iff it's an absolute-path string command. */
const pushHookCommand = (entry: unknown, event: string, sink: HookRef[]): void => {
  if (typeof entry !== 'object' || entry === null) return;
  const command = (entry as Record<string, unknown>).command;
  if (typeof command === 'string' && command.startsWith('/')) {
    sink.push({ event, script: command as AbsolutePath });
  }
};
