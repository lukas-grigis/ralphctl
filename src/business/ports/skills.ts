/**
 * Phases that load their own skill set. Mirrors the top-level workflows the
 * harness exposes — refine and plan are pre-execution, exec covers both the
 * generator and evaluator sessions launched during `sprint start`.
 *
 * The string values are the directory names under `<builtin>/skills/<phase>/`
 * and `~/.ralphctl/skills/<phase>/`, so renaming them is a coordinated change
 * across the on-disk layout and the loader.
 */
export type SkillPhase = 'refine' | 'plan' | 'exec';

/**
 * A skill resolved from the on-disk layout. The `sourcePath` is the directory
 * holding `SKILL.md` and any supporting files; the lifecycle layer creates a
 * symlink to this directory inside each phase's working directory so Claude
 * Code reads the skill body directly from the source.
 */
export interface ResolvedSkill {
  /** Skill identity — frontmatter `name`. Directory name is informational. */
  readonly name: string;
  /** Frontmatter `description` — surfaced by Claude Code in skill listings. */
  readonly description: string;
  /** Absolute path to the skill directory containing `SKILL.md`. */
  readonly sourcePath: string;
  /** Where the skill was discovered — used in error messages and warnings. */
  readonly origin: 'builtin' | 'user';
}

/**
 * The set of symlinks created for one working directory during a phase. The
 * lifecycle returns one of these per `link()` call so `cleanup()` can remove
 * exactly the symlinks it created — never any pre-existing files in the same
 * directory.
 */
export interface LinkedSkillSet {
  /** Working directory that received the symlinks (absolute path). */
  readonly workingDir: string;
  /** Skill names symlinked into `<workingDir>/.claude/skills/`. */
  readonly linkedNames: readonly string[];
}

/**
 * Per-phase skill resolution + symlink lifecycle.
 *
 * `loadForPhase` is a pure read of the on-disk layout (built-in tree + user
 * tree at `~/.ralphctl/skills/<phase>/`); duplicate `name` between the two
 * sources throws `SkillNameCollisionError` before any phase work begins.
 *
 * `link` and `cleanup` form a paired lifecycle: every successful `link` must
 * be matched by a `cleanup` so source skill directories are never left with
 * dangling references inside repository working trees. Concrete adapters are
 * idempotent — repeated `cleanup` is a no-op, and a partial `link` failure
 * leaves the directory in a state safe for `cleanup` to drain.
 */
export interface SkillsPort {
  /** Resolve the skill set for a phase (built-in + user union). */
  loadForPhase(phase: SkillPhase): Promise<ResolvedSkill[]>;

  /**
   * Create `<workingDir>/.claude/skills/<name>` symlinks pointing at each
   * skill's `sourcePath`. The working directory is created if it does not
   * already exist. Returns the set of names actually linked (skipping any
   * that failed to link with a warning).
   */
  link(workingDir: string, skills: readonly ResolvedSkill[]): Promise<LinkedSkillSet>;

  /**
   * Remove every symlink listed in `set.linkedNames` from the working
   * directory. Idempotent — missing entries are silently skipped. Source
   * skill directories are never touched.
   */
  cleanup(set: LinkedSkillSet): Promise<void>;
}
