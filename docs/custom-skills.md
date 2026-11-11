# Custom skills

ralphctl mounts [Agent Skills](https://agentskills.io/specification) into every AI session it starts. Add
your own to teach those sessions a team convention, a domain, or how to use a tool.

## Where to put a skill

| Location                                        | Loads in                   | Use it for                                          |
| ----------------------------------------------- | -------------------------- | --------------------------------------------------- |
| Your repo, at the CLI's skills path, committed  | Every session in that repo | Skills your team shares, or skills a tool generates |
| `~/.ralphctl/skills/<flow>/<name>/SKILL.md`     | One flow, any provider     | Personal skills for one phase                       |
| `~/.ralphctl/skills/<provider>/<name>/SKILL.md` | Every flow, one provider   | Skills tied to one CLI                              |

- CLI skills paths: `.claude/skills/` (Claude Code), `.agents/skills/` (Codex), `.github/skills/` (Copilot),
  `.opencode/skills/` (OpenCode), `.grok/skills/` (Grok).
- `<flow>` is `refine`, `plan`, `implement`, `readiness`, `ideate` or `create-pr`.
- `<provider>` is `claude`, `codex`, `copilot`, `opencode` or `grok`.
- `~/.ralphctl` is `$RALPHCTL_HOME` when that's set.

The CLI loads repo skills itself. ralphctl copies the other two into each session as `ralphctl-<name>` and
removes them when the session ends.

## Write the SKILL.md

```markdown
---
name: billing-glossary
description: Billing domain terms. Use when a ticket or task mentions invoices, dunning or credit notes.
---

An invoice is ...
```

- `name` matches the folder name: lowercase letters, digits and single hyphens, at most 64 characters.
- `description` says what the skill covers and when to use it. The model reads it to decide whether to
  open the skill.
- Keep the frontmatter flat, one `key: value` per line. Nested blocks are ignored, and `>` or `|` values
  aren't supported.

## Gotchas

- **Only `SKILL.md` is copied** from the `~/.ralphctl` folders. Put everything in the body, or point at
  files in the repo.
- **Commit repo skills.** In parallel mode each task runs in a fresh git worktree, which only has committed
  files.
- **Refine, plan, ideate and readiness can't run shell commands** when they run headless on Claude Code,
  Copilot or Grok. A skill that runs commands works in implement; elsewhere, have it read files instead.
- **ralphctl owns git, the pull request and the verify gate.** A skill that tells the AI to commit, push,
  open a PR, run hardcoded package-manager commands or start subagents gets a warning in the log.
  Angle-bracket placeholders like `<name>` trigger one too, so write `{name}`.
- **A broken skill doesn't fail the run.** ralphctl skips it and logs which one and why.

## Turn a skill off

- **Skills catalog** (`K` on the home screen): enable or disable bundled and flow-folder skills per flow.
  Disabling deletes the flow-folder copy, so keep your original somewhere else.
- **For one run:** pick "Customize skills for this run…" when you launch a flow and untick the skill.
  Remember the choice to save it to `settings.ai.skills.<flow>.disabled`.
- **`ralphctl skills list`** shows bundled and flow-folder skills and the flows they load in.
