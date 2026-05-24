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
- **Process spawning** — ralphctl spawns AI provider CLIs (`claude`, `gh`, `codex`) with user-provided prompts
- **No network access** — ralphctl itself makes no network requests; the spawned AI CLIs handle their own connections

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
