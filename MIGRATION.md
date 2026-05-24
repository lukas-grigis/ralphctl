# Migration Guide

The universal upgrade recipe for ralphctl is always:

```bash
npm install -g ralphctl@latest
ralphctl settings apply-preset <name>    # if your settings need a reset
mv ~/.ralphctl ~/.ralphctl.bak           # only if your old data doesn't load cleanly
ralphctl                                  # re-register projects as the TUI prompts
```

Only the latest version is supported — no backporting, no parallel branches.
The sections below give per-version context for what changed and why, in case
you're crossing a big jump and want to know what to expect.

## 0.7.x → 0.8.0

0.8.0 flattens AI settings to per-flow rows, renames `checkScript` →
`verifyScript`, and consolidates the signal pipeline onto the file-based
contract. The harness will try to read your old settings and data, but if
anything looks off after upgrading, the safe path is to back up `~/.ralphctl/`
and start fresh — sprints are short-lived and projects are quick to re-register.
See [CHANGELOG](./CHANGELOG.md#080---2026-05-24) for the full list.

## 0.6.x → 0.7.0

> **0.7.0 is a structural rewrite.** Internal architecture, on-disk schema, and several CLI
> commands all changed. **There is no automatic migration from 0.6.x** — sprints, projects,
> and settings written by 0.6.x will not be read by 0.7.0, even though the data directory
> path is the same.
>
> If you launch 0.7.0 with v0.6.x data still in `~/.ralphctl/`, the harness detects the
> legacy layout, **refuses to start**, and prints the exact backup command you need to run.
> No data is touched. The steps below are what the safeguard will tell you.

### Before upgrading

1. **Back up your 0.6.x data**:

   ```bash
   mv ~/.ralphctl ~/.ralphctl.0.6-backup
   ```

2. Install the latest ralphctl:

   ```bash
   npm install -g ralphctl@latest
   ```

3. Launch the TUI and re-register your projects:

   ```bash
   ralphctl
   ```

4. (Optional) Re-create sprints by hand from the backup — `~/.ralphctl.0.6-backup/data/sprints/<id>/`
   still holds the original ticket bodies, plan output, and progress notes for reference.

### What changed

- **On-disk schema is incompatible.** Each sprint now spans three files — `sprint.json` (planning),
  `execution.json` (branch / PR / setup audit), `tasks.json` (the task list) — instead of the single
  0.6.x `sprint.json`. Override the data root with `RALPHCTL_HOME=<absolute-path>` if you need a
  separate location.
- **`settings.json` schema changed.** Per-flow model selection replaces the single global `model`;
  each chain picks its own. 0.6.x settings files are rejected on read — re-run `ralphctl settings`
  to reconfigure.
- **CLI surface intentionally smaller.** These commands were removed in favour of the TUI:
  `sprint feedback / edit`, `ticket approve / edit`, `project repo add / remove`, all
  `task add / edit / edit-status / remove`, and `sessions list / attach / detach / kill`. Switch
  to the interactive TUI or to `ralphctl sprint show <id>` / the relevant flow command.
- **OpenAI Codex provider added** (preview) alongside Claude Code and GitHub Copilot — pick via
  `ralphctl settings`.

See [CHANGELOG.md](./CHANGELOG.md#070---2026-05-18) for the full list, including non-breaking
improvements (cross-project sprint lock, idle-stdout watchdog, resume-aborted runs, persistent
`<sprintDir>/chain.log`, exponential rate-limit backoff).
