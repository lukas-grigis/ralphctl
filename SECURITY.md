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
- **Process spawning** — ralphctl spawns `claude` CLI processes with user-provided prompts
- **No network access** — ralphctl itself makes no network requests (Claude CLI handles its own connections)

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.0.x   | Yes       |
