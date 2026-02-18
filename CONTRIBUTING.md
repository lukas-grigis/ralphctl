# Contributing to RalphCTL

> _"Me fail English? That's unpossible!"_ — Ralph Wiggum

Thanks for your interest in contributing! RalphCTL is a side project and contributions are welcome — here's how to make the process smooth for everyone.

## Ground rules

1. **Open an issue first.** Before writing code, open an issue describing what you'd like to change. This avoids duplicate work and gives us a chance to discuss the approach before you invest time.
2. **Keep PRs focused.** One logical change per PR. If you find an unrelated bug while working, open a separate issue for it.
3. **All checks must pass.** Lint, typecheck, and tests are non-negotiable.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) **>= 24.0.0** (we use [mise](https://mise.jdx.dev/) for version management)
- [pnpm](https://pnpm.io/) **>= 10**
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and configured (only needed for integration testing)

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
pnpm dev <command>       # Run CLI in dev mode
pnpm dev                 # Interactive menu mode
pnpm test:watch          # Tests in watch mode
pnpm lint:fix            # Auto-fix lint issues
pnpm format              # Format all files with Prettier
```

## Making changes

1. **Fork and branch.** Create a feature branch from `main`:

   ```bash
   git checkout -b feature/my-change
   ```

2. **Write your code.** Follow the existing patterns — strict TypeScript, no `any` types, use the theme helpers from `src/theme/ui.ts` for CLI output.

3. **Add tests.** If you're adding behavior, add tests. If you're fixing a bug, add a regression test. Tests live next to the code they test (`*.test.ts`).

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
- **UI output** — use helpers from `src/theme/ui.ts` (`showSuccess`, `showError`, `log.*`, etc.) — don't add raw emoji or `console.log`

## Project structure

```
src/
├── commands/        # CLI command implementations
├── interactive/     # REPL/menu mode
├── store/           # Data persistence layer
├── claude/          # Claude CLI integration
├── theme/           # UI components and styling
├── schemas/         # Zod validation schemas
└── utils/           # Pure utilities
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

## Questions?

Open an issue with the `question` label. We're happy to help.
