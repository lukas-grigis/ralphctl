import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { ProbeError } from '@src/domain/value/error/probe-error.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { ArtifactRef, HookRef } from '@src/integration/ai/readiness/_engine/artifact-ref.ts';
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

    const claudeMd = await probeFile(join(root, 'CLAUDE.md'));
    if (!claudeMd.ok) return Result.error(claudeMd.error);

    const agentsMd = await probeFile(join(root, 'AGENTS.md'));
    if (!agentsMd.ok) return Result.error(agentsMd.error);

    const settings = await probeFile(join(root, '.claude/settings.json'));
    if (!settings.ok) return Result.error(settings.error);

    const settingsLocal = await probeFile(join(root, '.claude/settings.local.json'));
    if (!settingsLocal.ok) return Result.error(settingsLocal.error);

    const mcpConfig = await probeFile(join(root, '.mcp.json'));
    if (!mcpConfig.ok) return Result.error(mcpConfig.error);

    const skills = await probeNamedDirCollection(join(root, '.claude/skills'), 'SKILL.md');
    if (!skills.ok) return Result.error(skills.error);

    const commands = await probeNamedFileCollection(join(root, '.claude/commands'));
    if (!commands.ok) return Result.error(commands.error);

    const agents = await probeNamedFileCollection(join(root, '.claude/agents'));
    if (!agents.ok) return Result.error(agents.error);

    const hooks = await readHooks([settings.value, settingsLocal.value]);
    if (!hooks.ok) return Result.error(hooks.error);

    const artifacts: ClaudeArtifacts = {
      tool: 'claude-code',
      ...(claudeMd.value !== undefined ? { claudeMd: claudeMd.value } : {}),
      ...(agentsMd.value !== undefined ? { agentsMd: agentsMd.value } : {}),
      ...(settings.value !== undefined ? { settings: settings.value } : {}),
      ...(settingsLocal.value !== undefined ? { settingsLocal: settingsLocal.value } : {}),
      ...(mcpConfig.value !== undefined ? { mcpConfig: mcpConfig.value } : {}),
      skills: skills.value,
      commands: commands.value,
      agents: agents.value,
      hooks: hooks.value,
    };

    return Result.ok(hasAnyClaudeArtifact(artifacts) ? presentState(now, artifacts) : absentState(now));
  },
};

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
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      if (typeof matcher !== 'object' || matcher === null) continue;
      const inner = (matcher as Record<string, unknown>).hooks;
      if (!Array.isArray(inner)) continue;
      for (const entry of inner) {
        if (typeof entry !== 'object' || entry === null) continue;
        const command = (entry as Record<string, unknown>).command;
        if (typeof command === 'string' && command.startsWith('/')) {
          sink.push({ event, script: command as AbsolutePath });
        }
      }
    }
  }
};
