/**
 * `createFilesystemSkillsAdapter` — shared {@link SkillsAdapter} implementation backing
 * every provider whose skills convention is "write `<sessionDir>/<parentDir>/skills/<name>/
 * SKILL.md` and let the running CLI auto-discover it." That covers Claude (`.claude`), Codex
 * (`.agents`), and Copilot (`.github`) — all use the Agent Skills open-standard frontmatter.
 *
 * Behaviour (identical across providers, only `parentDir` and the {@link describeSkillsConvention}
 * text differ):
 *  - **Project skills win.** If `<sessionDir>/<parentDir>/skills/<name>/` already exists without
 *    an install marker (`skill-install-marker.ts`), it's the project's own copy. Leave it untouched,
 *    keep `<name>` out of the manifest, and warn once when its content differs from the skill being
 *    installed, since that's also what a leftover from before markers existed looks like.
 *  - **Stale leftovers are refreshed.** Every folder `install` writes carries a marker naming this
 *    process. The manifest below doesn't survive a crash, so a later run that finds a marked folder
 *    whose process is gone deletes it, writes the current skill, and tracks it. A marked folder
 *    whose process is still alive belongs to another live run and is left alone.
 *  - **Manifest-tracked uninstall.** `install` records names it actually wrote into a
 *    per-`sessionDir` Set. `uninstall` removes only those folders (marker included), then attempts
 *    to clean up the `<parentDir>/skills` and `<parentDir>` directories when they end up empty.
 *  - **Idempotent.** A second `install` from the same adapter adds only the still-missing skills;
 *    double-`uninstall` is a no-op.
 *
 * Why one helper instead of three near-identical adapters: the only inter-provider differences
 * are the `parentDir` constant (`.claude` vs `.agents` vs `.github`) and the convention prose.
 * Keeping the logic in one place means a bugfix here lands for every provider at once.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { ensureGitExcludeWildcard } from '@src/integration/io/git-exclude.ts';
import { SkillNameSchema, type Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import {
  classifySkillFolder,
  INSTALL_MARKER_FILENAME,
  writeInstallMarker,
} from '@src/integration/ai/skills/_engine/skill-install-marker.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';

export interface FilesystemSkillsAdapterDeps {
  /** Provider id — used only for error messages. */
  readonly providerId: string;
  /**
   * Top-level directory the running CLI scans for skills (e.g. `.claude`, `.agents`,
   * `.github`). The adapter creates `<sessionDir>/<parentDir>/skills/<name>/SKILL.md`.
   */
  readonly parentDir: string;
  /** Markdown sentence returned from {@link SkillsAdapter.describeSkillsConvention}. */
  readonly convention: string;
  /**
   * Optional logger — used to warn when the best-effort `.git/info/exclude` write fails.
   * Skills install still succeeds in that case; the user just sees harness-authored
   * `ralphctl-*` folders in `git status` until the exclude lands manually.
   */
  readonly logger?: Logger;
}

/**
 * Downstream CLIs parse the installed frontmatter with STRICT YAML parsers — Copilot rejects an
 * unquoted plain scalar containing `: ` outright ("mapping values are not allowed in this
 * context"). Values that are safe plain scalars stay unquoted to keep the files human-readable;
 * anything else is double-quoted with YAML escapes, which `parseSimpleYaml` unescapes on read.
 */
const yamlValue = (value: string): string =>
  /^[A-Za-z0-9]/u.test(value) && !value.includes(': ') && !value.includes(' #') && !/[\s:]$/u.test(value)
    ? value
    : `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/**
 * Render the canonical Skill back into Markdown with frontmatter — Agent Skills spec
 * (`name`, `description`, plus optional `license` / `compatibility` / `allowed-tools`).
 * `name` renders bare: it is schema-fenced to kebab-case, which is always a safe plain scalar.
 */
const renderSkill = (skill: Skill): string => {
  const lines = ['---', `name: ${skill.name}`, `description: ${yamlValue(skill.description)}`];
  if (skill.license !== undefined) lines.push(`license: ${yamlValue(skill.license)}`);
  if (skill.compatibility !== undefined) lines.push(`compatibility: ${yamlValue(skill.compatibility)}`);
  if (skill.allowedTools !== undefined) lines.push(`allowed-tools: ${yamlValue(skill.allowedTools)}`);
  lines.push('---');
  return `${lines.join('\n')}\n\n${skill.content.replace(/\s+$/u, '')}\n`;
};

/**
 * Containment gate — `skill.name` is used verbatim as a directory name, so `join(skillsDir,
 * '../../../../tmp/pwned')` would land the write outside `sessionDir` entirely. On the bare path
 * the name originates from AI output (the readiness `skill-suggestions` signal), which makes this
 * adapter the last boundary before `mkdir` / `writeFile`. Re-validating against
 * {@link SkillNameSchema} here — the same shape every on-disk skill already satisfies — keeps a
 * future caller from reintroducing a model-controlled path, and rules out the embedded newline
 * that would otherwise inject extra keys into {@link renderSkill}'s YAML frontmatter.
 */
const rejectUnsafeSkillName = (providerId: string, skillsDir: string, name: string): StorageError | undefined => {
  if (SkillNameSchema.safeParse(name).success) return undefined;
  return new StorageError({
    subCode: 'schema-mismatch',
    message: `${providerId}: refusing skill name ${JSON.stringify(name)} — skill names are used verbatim as a directory name and must be kebab-case (lowercase alphanumeric with single hyphens, 1-64 chars)`,
    path: skillsDir,
    hint: 'The name came from a skill source or AI output. Nothing was written; fix the skill name at its source.',
  });
};

const tryRmdirIfEmpty = async (path: string): Promise<void> => {
  try {
    await rmdir(path);
  } catch {
    // Non-empty or missing — both are fine, the cleanup is best-effort.
  }
};

/** What `writeAllSkills` does with one skill, given what's already at its destination. */
type InstallAction = 'write' | 'replace-stale' | 'keep-project-copy' | 'keep';

/** {@link installActionFor}'s verdict, plus the dead pid a `'replace-stale'` verdict can name. */
interface InstallDecision {
  readonly action: InstallAction;
  readonly deadPid?: number;
}

const installActionFor = async (dst: string, name: string, tracked: ReadonlySet<string>): Promise<InstallDecision> => {
  // Our own copy from earlier in this run: skip the marker read unless it vanished meanwhile.
  if (tracked.has(name)) return { action: existsSync(dst) ? 'keep' : 'write' };
  const { ownership, deadPid } = await classifySkillFolder(dst);
  if (ownership === 'absent') return { action: 'write' };
  if (ownership === 'stale-install') return { action: 'replace-stale', ...(deadPid !== undefined ? { deadPid } : {}) };
  return { action: ownership === 'project-owned' ? 'keep-project-copy' : 'keep' };
};

const writeSkillFolder = async (dst: string, skill: Skill): Promise<void> => {
  await mkdir(dst, { recursive: true });
  // Marker first: a crash before `SKILL.md` lands leaves a folder the next run can reclaim, never
  // an unmarked half-install that passes for a project copy.
  await writeInstallMarker(dst, skill.name);
  await writeFile(join(dst, 'SKILL.md'), renderSkill(skill), 'utf-8');
};

/** Per-adapter state for the unmarked-shadow warning. */
interface ShadowWarnings {
  readonly providerId: string;
  readonly logger: Logger | undefined;
  /** Destinations already warned about by this adapter, so repeated installs stay quiet. */
  readonly warned: Set<string>;
}

/**
 * Warn once per destination when an unmarked folder shadows `skill` with different content. That
 * folder is either a deliberate project override or a leftover from a version that didn't write
 * markers, and nothing on disk tells the two apart, so the operator gets to decide. An unreadable
 * `SKILL.md` isn't worth failing the install over and is skipped.
 */
const warnIfShadowing = async (shadow: ShadowWarnings, dst: string, skill: Skill): Promise<void> => {
  if (shadow.logger === undefined || shadow.warned.has(dst)) return;
  shadow.warned.add(dst);
  let existing: string;
  try {
    existing = await readFile(join(dst, 'SKILL.md'), 'utf-8');
  } catch {
    return;
  }
  if (existing === renderSkill(skill)) return;
  shadow.logger
    .named('skills.shadow')
    .warn(
      `${shadow.providerId}: kept ${dst} instead of installing the current "${skill.name}" skill — the folder has no ${INSTALL_MARKER_FILENAME} and its content differs. Delete it if an older ralphctl run left it behind; keep it if it's your own override.`,
      { path: dst, skill: skill.name }
    );
};

/**
 * Log (info level) before a stale-marked folder is deleted and rewritten. No content comparison
 * against what it would render: version drift is the normal reason a bundled skill's text differs
 * run to run, so that check would just be noise. What's worth a trace line is the destructive
 * step itself — naming the path, the skill, and the dead process the marker blamed it on — so a
 * `rm -rf` of something an operator later swears they never touched isn't silent.
 */
const logStaleReplacement = (shadow: ShadowWarnings, dst: string, skill: Skill, deadPid: number | undefined): void => {
  const holder = deadPid !== undefined ? `pid ${deadPid}, no longer running` : 'an unreadable install marker';
  shadow.logger
    ?.named('skills.stale')
    .info(`${shadow.providerId}: replacing stale skill folder ${dst} for "${skill.name}" — left by ${holder}`, {
      path: dst,
      skill: skill.name,
      ...(deadPid !== undefined ? { deadPid } : {}),
    });
};

/**
 * Write every skill whose destination is free or holds a stale leftover of ours, tracking each
 * written name into `tracked`. Project copies and folders held by a live run are skipped. Stops at
 * the first write failure and returns that error — whatever was already added to `tracked` before
 * the failure stays there for the caller to persist.
 */
const writeAllSkills = async (
  skillsDir: string,
  skills: readonly Skill[],
  tracked: Set<string>,
  shadow: ShadowWarnings
): Promise<Result<void, StorageError>> => {
  for (const skill of skills) {
    const unsafe = rejectUnsafeSkillName(shadow.providerId, skillsDir, skill.name);
    if (unsafe !== undefined) return Result.error(unsafe);

    const dst = join(skillsDir, skill.name);
    const { action, deadPid } = await installActionFor(dst, skill.name, tracked);
    if (action === 'keep') continue;
    if (action === 'keep-project-copy') {
      await warnIfShadowing(shadow, dst, skill);
      continue;
    }

    try {
      if (action === 'replace-stale') {
        logStaleReplacement(shadow, dst, skill, deadPid);
        await rm(dst, { recursive: true, force: true });
      }
      await writeSkillFolder(dst, skill);
      tracked.add(skill.name);
    } catch (cause) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `${shadow.providerId}: failed to install skill ${skill.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
          path: dst,
          cause,
        })
      );
    }
  }
  return Result.ok(undefined);
};

/**
 * Best-effort, once-per-`sessionDir` attempt to append the wildcard exclude line to the
 * `info/exclude` of `<sessionDir>`'s common git dir (a linked worktree resolves to the main
 * repo's `.git`). A non-git tree, an uninspectable `.git`, or a write-protected exclude file
 * all collapse to "warn and proceed" — the caller's install already succeeded regardless.
 */
const ensureGitExcludeOnce = async (
  sessionDir: AbsolutePath,
  excludeAttempted: Set<string>,
  excludePattern: string,
  providerId: string,
  logger: Logger | undefined
): Promise<void> => {
  const key = String(sessionDir);
  if (excludeAttempted.has(key)) return;
  excludeAttempted.add(key);

  const excluded = await ensureGitExcludeWildcard(sessionDir, excludePattern);
  if (!excluded.ok) {
    logger
      ?.named('skills.exclude')
      .warn(`${providerId}: failed to update .git/info/exclude: ${excluded.error.message}`);
  }
};

export const createFilesystemSkillsAdapter = (deps: FilesystemSkillsAdapterDeps): SkillsAdapter => {
  // Per-sessionDir manifest of skill names this adapter created at install time. Cleared on
  // a successful uninstall. Not promised across crashed runs — the cleanup is best-effort.
  const installed = new Map<string, Set<string>>();
  // Per-sessionDir flag tracking whether we've already attempted to append the wildcard
  // exclude. Idempotent against the file regardless, but the in-memory check avoids re-
  // reading the file on every install call across a long-running session.
  const excludeAttempted = new Set<string>();
  // Unmarked folders already warned about (see `warnIfShadowing`). Never cleared: one warning per
  // folder per adapter, i.e. per launch, is enough.
  const shadow: ShadowWarnings = { providerId: deps.providerId, logger: deps.logger, warned: new Set<string>() };
  const skillsSubdir = join(deps.parentDir, 'skills');
  const excludePattern = `${skillsSubdir}/ralphctl-*`;

  // Self-healing prune: drop manifest entries whose sessionDir no longer exists on disk. The
  // typical leak path is the per-task subchain failing BETWEEN `linkSkills` and `unlinkSkills`
  // — `sequential` then marks unlink as skipped, no cleanup runs, and the map entry sticks
  // for the harness lifetime. We can't reliably force unlink to run (the chain framework has
  // no try/finally semantics), so prune lazily on every install: stale sessionDirs are
  // workspaces ralphctl deleted or moved, so their entries can't ever be unwound anyway.
  const pruneStale = (): void => {
    for (const key of [...installed.keys()]) {
      if (!existsSync(key)) installed.delete(key);
    }
  };

  return {
    async install(sessionDir: AbsolutePath, skills: readonly Skill[]): Promise<Result<void, StorageError>> {
      pruneStale();
      const skillsDir = join(String(sessionDir), skillsSubdir);
      const tracked = installed.get(String(sessionDir)) ?? new Set<string>();

      const written = await writeAllSkills(skillsDir, skills, tracked, shadow);
      if (tracked.size > 0) installed.set(String(sessionDir), tracked);
      if (!written.ok) return written;

      // Best-effort: append a single wildcard line to <sessionDir>'s common `.git/info/exclude`
      // (linked worktrees included) so every `ralphctl-*` skill we manage stays out of
      // `git status`. A non-git tree, an uninspectable `.git`, or a write-protected
      // `info/exclude` all collapse to "warn and proceed" — the skill install already succeeded.
      await ensureGitExcludeOnce(sessionDir, excludeAttempted, excludePattern, deps.providerId, deps.logger);

      return Result.ok(undefined);
    },

    async installBareSkill(sessionDir: AbsolutePath, skill: Skill): Promise<Result<void, StorageError>> {
      // Bare-name install path — drops the `ralphctl-` prefix, doesn't touch
      // `.git/info/exclude`, doesn't add to the manifest. The folder is deliberately
      // project-tracked so the operator commits it as a regular project asset.
      const skillsDir = join(String(sessionDir), skillsSubdir);
      const unsafe = rejectUnsafeSkillName(deps.providerId, skillsDir, skill.name);
      if (unsafe !== undefined) return Result.error(unsafe);

      const dst = join(skillsDir, skill.name);
      // Project-wins: a pre-existing `SKILL.md` at the destination is the operator's own.
      // Leave it alone (the readiness flow may run on a repo where these skills already
      // exist from a previous run; we don't want to overwrite operator edits).
      if (existsSync(join(dst, 'SKILL.md'))) return Result.ok(undefined);
      try {
        await mkdir(dst, { recursive: true });
        await writeFile(join(dst, 'SKILL.md'), renderSkill(skill), 'utf-8');
      } catch (cause) {
        return Result.error(
          new StorageError({
            subCode: 'io',
            message: `${deps.providerId}: failed to install bare skill ${skill.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
            path: dst,
            cause,
          })
        );
      }
      return Result.ok(undefined);
    },

    describeSkillsConvention(): string {
      return deps.convention;
    },

    async uninstall(sessionDir: AbsolutePath): Promise<Result<void, StorageError>> {
      const key = String(sessionDir);
      const tracked = installed.get(key);
      if (tracked === undefined || tracked.size === 0) return Result.ok(undefined);

      const skillsDir = join(key, skillsSubdir);
      try {
        for (const id of tracked) {
          await rm(join(skillsDir, id), { recursive: true, force: true });
        }
        installed.delete(key);
      } catch (cause) {
        return Result.error(
          new StorageError({
            subCode: 'io',
            message: `${deps.providerId}: failed to uninstall skills under ${skillsDir}: ${cause instanceof Error ? cause.message : String(cause)}`,
            path: skillsDir,
            cause,
          })
        );
      }

      // Tidy empty parent dirs we may have created. Failure is benign — the skills
      // themselves are already gone, and a non-empty parent (e.g. a project `.github/`
      // with workflows in it) is preserved by `tryRmdirIfEmpty`.
      await tryRmdirIfEmpty(skillsDir);
      await tryRmdirIfEmpty(join(key, deps.parentDir));
      return Result.ok(undefined);
    },
  };
};
