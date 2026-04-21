/**
 * Structural and readability lint for the provider-native project context
 * file content proposed by `project onboard` (written to `CLAUDE.md` or
 * `.github/copilot-instructions.md`). Pure — no I/O (drift detection reads
 * the repo synchronously, scoped to a small allowlist of files).
 *
 * Rules:
 * - Exactly one H1
 * - At most 7 H2 headings
 * - No H4+ headings
 * - Under 300 lines
 * - Flesch Reading Ease > 40 (approximate; inline syllable heuristic)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LintViolation } from '@src/business/ports/onboard-adapter.ts';
export type { LintViolation };

export interface LintResult {
  readonly ok: boolean;
  readonly violations: LintViolation[];
}

const MAX_H2 = 7;
// Target: < 300 lines — empirical studies (agents.md 2025/2026) show larger
// instruction files reduce agent success rate; keep the document small.
const MAX_LINES = 300;
const MIN_FLESCH = 40;

/**
 * Required H2 sections, in the canonical order set by `repo-onboard.md`.
 * Matched case-insensitively after trimming markdown decoration so minor
 * casing drift (e.g. "Testing" vs "testing") doesn't trip the check.
 */
const REQUIRED_H2_SECTIONS = [
  'Project Overview',
  'Build & Run',
  'Testing',
  'Architecture',
  'Implementation Style',
  'Security & Safety',
  'Performance Constraints',
] as const;

function normalizeHeading(raw: string): string {
  // Strip leading `#` markers, bold/italic wrappers, and trim whitespace.
  return raw
    .replace(/^#+\s*/, '')
    .replace(/[*_`]/g, '')
    .trim()
    .toLowerCase();
}

export function lintAgentsMd(content: string): LintResult {
  const violations: LintViolation[] = [];
  const lines = content.split('\n');

  if (lines.length >= MAX_LINES) {
    violations.push({
      rule: 'max-lines',
      message: `Project context file is ${String(lines.length)} lines (must be under ${String(MAX_LINES)}).`,
    });
  }

  // Only count headings in regular text (skip fenced code blocks).
  let inCodeFence = false;
  let h1Count = 0;
  let h2Count = 0;
  const h2Titles: string[] = [];
  for (const line of lines) {
    if (line.startsWith('```')) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    const match = /^(#+)\s/.exec(line);
    if (!match) continue;
    const depth = match[1]?.length ?? 0;
    if (depth === 1) h1Count++;
    else if (depth === 2) {
      h2Count++;
      h2Titles.push(normalizeHeading(line));
    } else if (depth >= 4) {
      violations.push({
        rule: 'no-h4-plus',
        message: `H${String(depth)} heading is too deep — keep structure flat (H1/H2/H3 only): "${line.trim()}"`,
      });
    }
  }

  // Required-sections gate — every mandatory H2 must appear (case-insensitive).
  for (const required of REQUIRED_H2_SECTIONS) {
    if (!h2Titles.includes(required.toLowerCase())) {
      violations.push({
        rule: 'required-section',
        message: `Missing required H2 section: "## ${required}".`,
      });
    }
  }

  if (h1Count !== 1) {
    violations.push({
      rule: 'single-h1',
      message: `Expected exactly one H1, found ${String(h1Count)}.`,
    });
  }
  if (h2Count > MAX_H2) {
    violations.push({
      rule: 'max-h2',
      message: `Too many H2 sections (${String(h2Count)}); keep at most ${String(MAX_H2)}.`,
    });
  }

  const flesch = fleschReadingEase(content);
  if (Number.isFinite(flesch) && flesch < MIN_FLESCH) {
    violations.push({
      rule: 'readability',
      message: `Flesch score ${flesch.toFixed(1)} is below ${String(MIN_FLESCH)} — simplify long sentences.`,
    });
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Approximate Flesch Reading Ease. Pure heuristic — counts words, sentences
 * and vowel-cluster syllables. Operates on prose only: fenced code blocks
 * and bullet markers are stripped first so formatting doesn't skew the score.
 */
export function fleschReadingEase(content: string): number {
  const prose = stripNonProse(content);
  const words = prose.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  if (words.length === 0) return 100;
  const sentences = Math.max(1, (prose.match(/[.!?]+(?:\s|$)/g) ?? []).length);
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  return 206.835 - 1.015 * (words.length / sentences) - 84.6 * (syllables / words.length);
}

function stripNonProse(content: string): string {
  // Drop fenced code blocks, inline code, headings, and list markers.
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/^#+\s+.*$/gm, ' ')
    .replace(/^\s*[-*+]\s+/gm, '');
}

function countSyllables(word: string): number {
  const lower = word.toLowerCase();
  // Count vowel groups; trailing silent 'e' drops one (but never below 1).
  const groups = lower.match(/[aeiouy]+/g) ?? [];
  let count = groups.length;
  if (lower.at(-1) === 'e' && count > 1) count--;
  return Math.max(1, count);
}

/**
 * Drift detection — warn when commands referenced in the project context file don't
 * resolve in the repo. Conservative: only flags references to `npm <script>`
 * / `pnpm <script>` / `yarn <script>` that name a script missing from
 * `package.json`. Other ecosystems return no warnings.
 */
export function detectCommandDrift(content: string, repoPath: string): string[] {
  const warnings: string[] = [];
  const pkgPath = join(repoPath, 'package.json');
  if (!existsSync(pkgPath)) return warnings;

  let scripts: Record<string, string> = {};
  try {
    const raw = readFileSync(pkgPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && isRecord(parsed['scripts'])) {
      // Narrow by runtime check (package.json scripts are all strings in practice).
      const entries = Object.entries(parsed['scripts']).filter((pair): pair is [string, string] => {
        return typeof pair[1] === 'string';
      });
      scripts = Object.fromEntries(entries);
    }
  } catch {
    return warnings;
  }

  const re = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?([a-z][a-z0-9:_-]*)/gi;
  let match: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((match = re.exec(content)) !== null) {
    const name = match[1];
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    // `install` / `test` are npm built-ins even without a script entry.
    if (name === 'install' || name === 'test' || name === 'start') continue;
    if (!(name in scripts)) {
      warnings.push(`Referenced script "${name}" not defined in package.json`);
    }
  }
  return warnings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
