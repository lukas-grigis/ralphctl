# Contributing to RalphCTL

> _"Me fail English? That's unpossible!"_ — Ralph Wiggum

Thanks for your interest in contributing! RalphCTL is a side project and contributions are welcome — here's how to make
the process smooth for everyone.

## Ground rules

1. **Open an issue first.** Before writing code, open an issue describing what you'd like to change. This avoids
   duplicate work and gives us a chance to discuss the approach before you invest time.
2. **Keep PRs focused.** One logical change per PR. If you find an unrelated bug while working, open a separate issue
   for it.
3. **All checks must pass.** Lint, typecheck, and tests are non-negotiable. Coverage is also enforced as a
   required merge gate: a PR that drops coverage below the configured thresholds, or that fails the
   cold-install reproducibility check, cannot be merged. Each PR's coverage run generates an lcov report
   that CI uploads as a build artifact. The required status checks (including the coverage and cold-install
   jobs) are configured via `scripts/setup-required-checks.sh`.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) **>= 24.0.0** (we use [mise](https://mise.jdx.dev/) for version management)
- [pnpm](https://pnpm.io/) **>= 10**
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and configured (only needed for integration
  testing)

### Setup

```bash
git clone https://github.com/lukas-grigis/ralphctl.git
cd ralphctl
pnpm install
```

If you use `mise`, tool versions are pinned in `mise.toml` — just run `mise install`.

### Verify everything works

```bash
pnpm typecheck && pnpm lint && pnpm test
```

### Development workflow

```bash
pnpm dev <command>       # Run CLI in dev mode (tsx, no build needed)
pnpm dev                 # Bare → Ink TUI (the primary interactive surface)
pnpm build               # Compile + bundle assets for npm distribution (tsup + build-assets)
pnpm test:watch          # Tests in watch mode
pnpm lint:fix            # Auto-fix lint issues
pnpm format              # Format all files with Prettier
```

> Pre-commit hooks (lint + format on staged files) are installed automatically
> on `pnpm install` via Husky. No manual setup needed.

## Making changes

1. **Fork and branch.** Create a feature branch from `main`:

   ```bash
   git checkout -b feature/my-change
   ```

2. **Write your code.** Follow the existing patterns — strict TypeScript, no `any` types, use the visual tokens from
   `src/application/ui/tui/theme/tokens.ts` for TUI output (no inline hex / glyph / spacing).

3. **Add tests.** If you're adding behavior, add tests. If you're fixing a bug, add a regression test. Tests live under
   the top-level `tests/` tree, mirroring the `src/` layout: `tests/unit/`, `tests/integration/`, and `tests/e2e/`
   (`*.test.ts`).

4. **Run all checks:**

   ```bash
   pnpm typecheck && pnpm lint && pnpm test
   ```

5. **Commit.** We use [conventional commits](https://www.conventionalcommits.org/):

   ```
   feat(sprint): add health check command
   fix(task): handle empty blockedBy array
   docs(readme): update installation steps
   refactor(store): simplify task ordering
   ```

6. **Open a PR.** Link the issue, describe what changed, and fill in the PR template.

## Code style

- **TypeScript** — strict mode, no `any`, `noUncheckedIndexedAccess` enabled
- **Formatting** — Prettier handles it (runs automatically via pre-commit hook)
- **Linting** — ESLint with TypeScript rules
- **UI output** — render through Ink components and the visual tokens in `src/application/ui/tui/theme/tokens.ts` (the
  single source of visual truth — no inline hex / glyph / spacing) — don't add raw emoji or `console.log`

## Project structure

```
src/
├── domain/          # Pure — models (Zod), errors, signals, IDs
├── business/        # Use cases, ports, composable pipelines
├── integration/     # Adapters: persistence, AI providers, scm, system, logging
└── application/     # Composition root + entrypoint, bootstrap (wire.ts), flow factories, chain runner, CLI, Ink TUI
```

See [ARCHITECTURE.md](./.claude/docs/ARCHITECTURE.md) for the full technical reference.

## What we're looking for

- Bug fixes with regression tests
- Documentation improvements
- Performance improvements
- New features that align with the [REQUIREMENTS.md](./.claude/docs/REQUIREMENTS.md)

## What we'll probably decline

- Changes that break the sprint state machine or two-phase planning model
- Large refactors without prior discussion
- Features that add complexity without clear user benefit
- Dependencies with restrictive licenses

## Releasing

Releases are automated by [`.github/workflows/release.yml`](.github/workflows/release.yml),
which triggers on tags matching `v[0-9]+.[0-9]+.[0-9]+`. To cut a release:

1. Bump `package.json#version` to `X.Y.Z`
2. Move `## [Unreleased]` to `## [X.Y.Z] - <date>` in `CHANGELOG.md`
3. Commit: `git commit -am "chore: release X.Y.Z"`
4. Tag: `git tag vX.Y.Z`
5. Push: `git push origin main --tags`

The workflow runs the full CI gate (format:check / lint / typecheck / test / build + a dist smoke-check), publishes to
npm with `--provenance`, and publishes a GitHub Release from the matching
CHANGELOG section.

## Questions?

Open an issue with the `question` label. We're happy to help.
