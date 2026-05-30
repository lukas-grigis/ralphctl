# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in RalphCTL, please report it
through [GitHub's private vulnerability reporting](https://github.com/lukas-grigis/ralphctl/security/advisories/new).

**Please do not open a public issue for security vulnerabilities.**

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

### What to expect

- Acknowledgment within 48 hours
- A fix or mitigation plan within a reasonable timeframe
- Credit in the release notes (unless you prefer anonymity)

## Scope

RalphCTL is a local CLI tool. The main security considerations are:

- **File system access** — ralphctl reads/writes to `~/.ralphctl/` and project directories
- **Process spawning** — ralphctl spawns AI provider CLIs (`claude`, `copilot`, `codex`) with user-provided prompts, plus SCM CLIs (`gh` / `glab`) and `git` for branch / PR / issue operations
- **Minimal network access** — ralphctl makes one outbound request of its own: a best-effort poll of the npm registry (`https://registry.npmjs.org/<package>/latest`) to surface available upgrades, cached for 1 hour and skippable by setting `NO_NETWORK`. All other network activity (SCM via `gh` / `glab`, AI inference) is delegated to the spawned CLIs, which handle their own connections
- **SCM operations** — create-pr and issue sync shell out to `gh` / `glab` / `git`, which act on remote repositories using the credentials already configured on the machine
- **User-authored scripts** — setup / verify scripts run as shell command strings (`shell: true`); they execute with the invoking user's privileges, so only configure scripts you trust

### Permission model

The harness uses two orthogonal axes to constrain what a spawned AI session can touch:

- **Capabilities** (`SessionPermissions`) gate per-tool actions: `canModifyRepoFiles`, `canRunShell`, `canAccessNetwork`, `autoApprove`.
- **Topology** (`cwd` + `additionalRoots` + `outputDir` on the `AiSession`) defines which paths the AI can read or write at all.

Topology is the primary defense. The `Write` tool is always allowed under every profile because the file-based provider contract requires the AI to land `signals.json` in `outputDir` — to deny writes to a tree, don't mount it. See [CLAUDE.md § Security & Safety](./CLAUDE.md#security--safety) for the per-provider mapping (Claude Code / GitHub Copilot / OpenAI Codex).

## Supported versions

Only the **latest published version** of ralphctl is supported. There is no
backporting of fixes to older minors — if you're on an older release, the
first step toward any fix is to upgrade. Reports against unsupported
versions will be acknowledged but resolved by asking you to reproduce on
latest.
