import { promises as fs, type Stats } from 'node:fs';
import { basename, join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { type AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { Slug } from '@src/domain/value/slug.ts';
import { toKebabCase } from '@src/domain/value/kebab-case.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { ProbeError } from '@src/domain/value/error/probe-error.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { ArtifactRef, HookRef, NamedArtifactRef } from '@src/integration/ai/readiness/_engine/artifact-ref.ts';
import type { ClaudeArtifacts } from '@src/integration/ai/readiness/claude/artifacts.ts';
import { absentState, type ReadinessState, presentState } from '@src/integration/ai/readiness/_engine/state.ts';
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

const probeFile = async (path: string): Promise<Result<ArtifactRef | undefined, ProbeError>> => {
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile()) return Result.ok(undefined);
    return Result.ok({ path: path as AbsolutePath });
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT')) return Result.ok(undefined);
    if (isNodeErrnoCode(cause, 'EACCES')) {
      return Result.error(
        new ProbeError({ subCode: 'fs-permission', message: `permission denied reading ${path}`, path, cause })
      );
    }
    return Result.error(new ProbeError({ subCode: 'fs-read', message: `failed to stat ${path}`, path, cause }));
  }
};

const probeNamedFileCollection = async (dir: string): Promise<Result<NamedArtifactRef[], ProbeError>> => {
  const entries = await listDir(dir);
  if (!entries.ok) return Result.error(entries.error);
  const refs: NamedArtifactRef[] = [];
  for (const entry of entries.value) {
    if (!entry.endsWith('.md')) continue;
    const full = join(dir, entry);
    const stat = await statSafely(full);
    if (!stat.ok) return Result.error(stat.error);
    if (stat.value === undefined || !stat.value.isFile()) continue;
    const baseName = entry.slice(0, -'.md'.length);
    const slug = Slug.parse(toKebabCase(baseName));
    if (!slug.ok) continue;
    refs.push({ name: slug.value, path: full as AbsolutePath });
  }
  return Result.ok(refs);
};

const probeNamedDirCollection = async (
  dir: string,
  childMarker: string
): Promise<Result<NamedArtifactRef[], ProbeError>> => {
  const entries = await listDir(dir);
  if (!entries.ok) return Result.error(entries.error);
  const refs: NamedArtifactRef[] = [];
  for (const entry of entries.value) {
    const childDir = join(dir, entry);
    const stat = await statSafely(childDir);
    if (!stat.ok) return Result.error(stat.error);
    if (stat.value === undefined || !stat.value.isDirectory()) continue;
    const markerPath = join(childDir, childMarker);
    const markerStat = await statSafely(markerPath);
    if (!markerStat.ok) return Result.error(markerStat.error);
    if (markerStat.value === undefined || !markerStat.value.isFile()) continue;
    const slug = Slug.parse(toKebabCase(basename(entry)));
    if (!slug.ok) continue;
    refs.push({ name: slug.value, path: markerPath as AbsolutePath });
  }
  return Result.ok(refs);
};

const listDir = async (dir: string): Promise<Result<string[], ProbeError>> => {
  try {
    return Result.ok(await fs.readdir(dir));
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT') || isNodeErrnoCode(cause, 'ENOTDIR')) return Result.ok([]);
    if (isNodeErrnoCode(cause, 'EACCES')) {
      return Result.error(
        new ProbeError({ subCode: 'fs-permission', message: `permission denied listing ${dir}`, path: dir, cause })
      );
    }
    return Result.error(new ProbeError({ subCode: 'fs-read', message: `failed to read ${dir}`, path: dir, cause }));
  }
};

const statSafely = async (path: string): Promise<Result<Stats | undefined, ProbeError>> => {
  try {
    return Result.ok(await fs.stat(path));
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT')) return Result.ok(undefined);
    if (isNodeErrnoCode(cause, 'EACCES')) {
      return Result.error(
        new ProbeError({ subCode: 'fs-permission', message: `permission denied stat ${path}`, path, cause })
      );
    }
    return Result.error(new ProbeError({ subCode: 'fs-read', message: `failed to stat ${path}`, path, cause }));
  }
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

const readFileSafely = async (path: AbsolutePath): Promise<Result<string | undefined, ProbeError>> => {
  try {
    return Result.ok(await fs.readFile(path, 'utf8'));
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT')) return Result.ok(undefined);
    if (isNodeErrnoCode(cause, 'EACCES')) {
      return Result.error(
        new ProbeError({ subCode: 'fs-permission', message: `permission denied reading ${path}`, path, cause })
      );
    }
    return Result.error(new ProbeError({ subCode: 'fs-read', message: `failed to read ${path}`, path, cause }));
  }
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

const isNodeErrnoCode = (cause: unknown, code: string): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === code;
