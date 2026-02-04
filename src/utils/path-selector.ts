import { execSync } from 'node:child_process';
import { basename } from 'node:path';
import type { Project, Repository } from '@src/schemas/index.ts';

/**
 * Result of path selection for a multi-repo project.
 */
export interface PathSelectionResult {
  /** Primary working path (where most work will happen) */
  primary: string;
  /** Additional paths to include for context */
  additional: string[];
}

/**
 * Common keywords that map to path patterns.
 * Used for simple heuristic matching.
 */
const PATH_KEYWORDS: Record<string, string[]> = {
  frontend: ['frontend', 'client', 'web', 'ui', 'app'],
  backend: ['backend', 'server', 'api', 'service'],
  mobile: ['mobile', 'ios', 'android', 'app'],
  shared: ['shared', 'common', 'lib', 'core', 'utils'],
  docs: ['docs', 'documentation'],
  infra: ['infra', 'infrastructure', 'deploy', 'k8s', 'terraform'],
};

/**
 * Extract keywords from text (title, description).
 */
function extractKeywords(text: string): Set<string> {
  // Normalize and split into words
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);

  return new Set(words);
}

/**
 * Score a repository based on keyword matches.
 */
function scoreRepo(repo: Repository, keywords: Set<string>): number {
  const repoName = repo.name.toLowerCase();
  const pathName = basename(repo.path).toLowerCase();
  let score = 0;

  // Check direct keyword matches in repo name or path basename
  for (const keyword of keywords) {
    if (repoName.includes(keyword) || pathName.includes(keyword)) {
      score += 10;
    }
  }

  // Check category keywords
  for (const [category, categoryKeywords] of Object.entries(PATH_KEYWORDS)) {
    // If text mentions a category
    if (keywords.has(category)) {
      for (const catKeyword of categoryKeywords) {
        if (repoName.includes(catKeyword) || pathName.includes(catKeyword)) {
          score += 5;
        }
      }
    }

    // If text mentions specific keywords from a category
    for (const catKeyword of categoryKeywords) {
      if (keywords.has(catKeyword) && (repoName.includes(catKeyword) || pathName.includes(catKeyword))) {
        score += 8;
      }
    }
  }

  return score;
}

/**
 * Get recently modified paths from git history.
 * Returns paths that were modified in the last N commits.
 */
function getRecentlyModifiedPaths(repos: Repository[], commits = 50): Map<string, number> {
  const pathCounts = new Map<string, number>();

  for (const repo of repos) {
    try {
      // Get list of modified files from git log
      const result = execSync(`git log -${String(commits)} --name-only --pretty=format:`, {
        cwd: repo.path,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Count modifications per path
      const currentCount = pathCounts.get(repo.path) ?? 0;
      const files = result.split('\n').filter((f) => f.trim());
      pathCounts.set(repo.path, currentCount + files.length);
    } catch {
      // Ignore git errors (path might not be a git repo)
    }
  }

  return pathCounts;
}

/**
 * Find paths that are commonly co-modified.
 * If pathA is often changed with pathB, they might be related.
 */
function getCoModifiedPaths(primaryPath: string, allRepos: Repository[]): string[] {
  const coModified: string[] = [];

  // This is a simplified version - just return paths that share recent commits
  // A full implementation would analyze actual co-commit patterns

  try {
    // Get commit hashes for primary path
    const primaryCommits = execSync('git log -20 --pretty=format:%H', {
      cwd: primaryPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .split('\n')
      .filter((h) => h.trim());

    const primarySet = new Set(primaryCommits);

    // Check each other path for overlapping commits
    for (const repo of allRepos) {
      if (repo.path === primaryPath) continue;

      try {
        const otherCommits = execSync('git log -20 --pretty=format:%H', {
          cwd: repo.path,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
          .split('\n')
          .filter((h) => h.trim());

        // Count overlapping commits
        const overlap = otherCommits.filter((h) => primarySet.has(h)).length;
        if (overlap > 3) {
          coModified.push(repo.path);
        }
      } catch {
        // Ignore errors
      }
    }
  } catch {
    // Ignore errors
  }

  return coModified;
}

/**
 * Select relevant paths for a ticket based on context.
 *
 * @param project - Project with multiple repositories
 * @param context - Ticket context (title, description)
 * @returns Selected paths (primary + additional for context)
 */
export function selectRelevantPaths(
  project: Project,
  context: { ticketTitle: string; ticketDescription?: string }
): PathSelectionResult {
  const repos = project.repositories;

  // Single repo project - simple case
  if (repos.length <= 1) {
    return {
      primary: repos[0]?.path ?? '',
      additional: [],
    };
  }

  // Extract keywords from ticket
  const text = `${context.ticketTitle} ${context.ticketDescription ?? ''}`;
  const keywords = extractKeywords(text);

  // Score each repo based on keywords
  const scores = repos.map((repo) => ({
    repo,
    score: scoreRepo(repo, keywords),
  }));

  // Sort by score (highest first)
  scores.sort((a, b) => b.score - a.score);

  // If we have clear winners (score > 0), use those
  const scoredRepos = scores.filter((s) => s.score > 0);

  if (scoredRepos.length > 0) {
    const primary = scoredRepos[0]?.repo.path ?? repos[0]?.path ?? '';
    const additional = scoredRepos.slice(1).map((s) => s.repo.path);
    return { primary, additional };
  }

  // No keyword matches - use activity-based heuristic
  const activityScores = getRecentlyModifiedPaths(repos);

  // Sort by activity
  const byActivity = repos
    .map((repo) => ({
      repo,
      activity: activityScores.get(repo.path) ?? 0,
    }))
    .sort((a, b) => b.activity - a.activity);

  const primary = byActivity[0]?.repo.path ?? repos[0]?.path ?? '';

  // Get co-modified paths for context
  const coModified = getCoModifiedPaths(primary, repos);

  return {
    primary,
    additional: coModified,
  };
}

/**
 * Select all paths (when user explicitly requests it).
 */
export function selectAllPaths(project: Project): PathSelectionResult {
  const [primary, ...additional] = project.repositories;
  return {
    primary: primary?.path ?? '',
    additional: additional.map((r) => r.path),
  };
}
