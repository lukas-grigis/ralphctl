# Custom skills

ralphctl mounts skills into the AI sessions it starts. It ships a curated set (the `ralphctl-*` skills in
the Skills catalog), and you can add your own: a team convention, a domain glossary, or a whole workflow
tool such as [OpenSpec](https://github.com/Fission-AI/OpenSpec). This guide covers where a skill can live,
what ralphctl accepts, and how to switch skills on and off. It then wires OpenSpec in end to end.

A skill is an [Agent Skills](https://agentskills.io/specification) folder: `<name>/SKILL.md`, with YAML
frontmatter on top and a Markdown body below. All five supported CLIs read that format.

## Where a skill can live

| Location                                             | Seen by                                     | Managed by                            |
| ---------------------------------------------------- | ------------------------------------------- | ------------------------------------- |
| The repo, at the CLI's native skills path, committed | Every session in the repo, ralphctl or not  | The AI CLI. ralphctl doesn't touch it |
| `~/.ralphctl/skills/<flow>/<name>/SKILL.md`          | One ralphctl flow, on every provider        | ralphctl                              |
| `~/.ralphctl/skills/<provider>/<name>/SKILL.md`      | Every flow that mounts skills, one provider | ralphctl                              |

`~/.ralphctl` is `$RALPHCTL_HOME` when that's set.

**In the repo** is the right home for anything the whole team uses, since everyone gets it with or
without ralphctl. ralphctl runs its sessions inside the repo checkout, so the CLI finds these skills on
its own. Commit them: in parallel mode each task runs in a fresh git worktree, which only has committed
files.

| Provider       | Native skills path  |
| -------------- | ------------------- |
| Claude Code    | `.claude/skills/`   |
| Codex          | `.agents/skills/`   |
| GitHub Copilot | `.github/skills/`   |
| OpenCode       | `.opencode/skills/` |
| Grok           | `.grok/skills/`     |

**Flow folders** hold personal skills you want in one phase on any provider, such as a planning checklist.
`<flow>` is one of `refine`, `plan`, `implement`, `readiness`, `ideate` or `create-pr`. These skills show
up in the Skills catalog, in `ralphctl skills list` and in the per-run skills picker.

**Provider folders** hold skills that only make sense on one CLI. `<provider>` is one of `claude`,
`codex`, `copilot`, `opencode` or `grok`. They load in every flow that mounts skills and appear in the
per-run picker, but not in the catalog or `ralphctl skills list`.

### What happens at launch

For each flow that mounts skills, ralphctl:

- collects bundled skills, the project's setup and verify skills, provider-folder skills and flow-folder
  skills, in that order. When two share a name, the later one wins, so a flow-folder copy overrides the
  bundled skill of the same name;
- drops the skills you opted out of for that flow;
- writes each one into the session's native skills path as `ralphctl-<name>/SKILL.md`, hidden from
  `git status` through `.git/info/exclude`;
- removes them again when the session ends.

If the repo already has a folder at that exact path, ralphctl treats it as yours and leaves it alone.

## Writing a SKILL.md ralphctl accepts

```markdown
---
name: billing-glossary
description: Domain terms for the billing service. Use when a ticket or task mentions invoices, dunning or credit notes.
---

# Billing glossary

...
```

ralphctl checks these rules when it loads a skill:

- `name` must match the folder name: lowercase letters, digits and single hyphens, at most 64 characters.
- `description` is required, at most 1024 characters. The model reads it to decide whether to open the
  skill, so say what the skill covers and when to use it.
- `license`, `compatibility` (at most 500 characters) and `allowed-tools` are optional and passed through.
- Frontmatter is read as flat `key: value` lines. A nested block such as `metadata:` is ignored. Keep
  every value on one line, because a `>` or `|` block won't be read the way you expect.
- Only `SKILL.md` is copied. Scripts, `references/` and other files next to it stay behind, so put what
  the model needs in the body, or point at files that already exist in the repo.
- The installed name gets a `ralphctl-` prefix (`billing-glossary` becomes `ralphctl-billing-glossary`)
  unless it already has one. That's the name you'll see in lists and in opt-out settings.

A bad skill never fails a run. ralphctl logs an unreadable or invalid `SKILL.md` and skips it.

### Harness rules

ralphctl owns git, the pull request, the verify gate and the result file each session writes. When a skill
pushes against that, ralphctl logs a warning naming the rule and the line, then installs the skill anyway.
The scanner reads list items and code blocks, and it lets a line through when a negation comes first
("never run `git push`" is fine). It flags:

- writing results to a file or to stdout instead of ralphctl's own result file;
- git commands that change the tree or history (`git commit`, `git checkout`, `git push` and so on);
- opening a separate pull request;
- hardcoded package-manager commands (`npm install`, `cargo test` and so on), which the project's own
  check script already covers;
- starting subagents or new sessions;
- claiming the final green build ("run the full suite before signalling done");
- angle-bracket tags. A path placeholder like `openspec/changes/<change>/` trips this one too, so write
  `{change}` instead.

A warning usually means the skill and the harness will pull in different directions. Fix it before you
rely on the skill.

## Turning skills on and off

- **Skills catalog**, `K` on the home screen. It lists the bundled skills and everything in a flow folder.
  `e` and `d` enable or disable a skill per flow, `u` and `U` update copied bundled skills, and `c` clears
  a saved opt-out. Disabling a skill **deletes its flow-folder copy**, so keep the original of any skill
  you wrote somewhere else.
- **Per-run picker.** When you customize a launch, the skills step lists everything the flow would mount.
  Untick a skill for this run only, or remember the choice.
- **Settings.** Remembered choices live in `settings.ai.skills.<flow>.disabled` as installed names, with
  the `ralphctl-` prefix. A per-run choice replaces that list for the run instead of adding to it.
- **`ralphctl skills list`** prints the catalog from the command line.

## Worked example: OpenSpec

[OpenSpec](https://github.com/Fission-AI/OpenSpec) keeps specs in the repo. `openspec/specs/` describes
current behaviour, and each change gets a folder under `openspec/changes/` with `proposal.md`, `design.md`,
`specs/` (requirement deltas with WHEN / THEN scenarios) and `tasks.md`.

The split that works: you decide what to build with OpenSpec, and ralphctl builds it. You write and review
the change, ralphctl refines, plans and implements it as a sprint, and you archive the change afterwards.

This section was written against OpenSpec 1.17. Check paths and command names against the version you run.

### 1. Add OpenSpec to the repo

```sh
npm install -g @fission-ai/openspec@latest
cd your-repo
openspec init --tools claude    # or codex, github-copilot, opencode; comma-separate several
git add openspec .claude
git commit -m "chore: add OpenSpec"
```

`openspec init` writes six skills into the CLI's native skills path: `openspec-propose`,
`openspec-explore`, `openspec-apply-change`, `openspec-update-change`, `openspec-sync-specs` and
`openspec-archive-change`. It also adds slash commands for the CLIs that have them. Once committed, every
ralphctl session in the repo can see the skills, and ralphctl needs no setup for that. The skills call the
`openspec` CLI, so it has to be on `PATH` wherever the sessions run.

Grok isn't an OpenSpec target. To use the skills there, copy the generated `openspec-*` folders into
`~/.ralphctl/skills/grok/`.

### 2. Write the change

Run `/opsx:propose add-dark-mode` in your own CLI session (`$openspec-propose` in Codex, `/opsx-propose`
in Copilot). Review what it writes, then commit the change folder. Proposing is a conversation, so it
belongs in your session. ralphctl's refine and plan take over from the written change.

### 3. Teach ralphctl's flows to read the change

OpenSpec's skills assume a person in the chat. `openspec-apply-change` asks you which change to use when
it can't tell, and it works through every open item in `tasks.md`, while ralphctl's implement runs one
task per session. Two small skills of your own close that gap. Put them in flow folders so they work on
every provider.

`~/.ralphctl/skills/plan/openspec-plan/SKILL.md`:

```markdown
---
name: openspec-plan
description: Plan tasks from an OpenSpec change. Use when a ticket names an OpenSpec change or points at a folder under openspec/changes/.
---

# Planning from an OpenSpec change

When a ticket names an OpenSpec change, read these files before you plan, from
`openspec/changes/{change}/`:

- `proposal.md` for why the change exists and what is in scope
- `design.md`, when present, for the technical decisions already made
- every `spec.md` under `specs/` for the requirement deltas and their scenarios
- `tasks.md` for the author's task breakdown

Read them directly. Planning sessions may not be allowed to run shell commands, so
don't rely on the `openspec` CLI here.

Base the plan's tasks on `tasks.md`:

- Keep its order and grouping. Merge items only when one is too small to be a task on its
  own, and split one only when it is too large for a single session.
- Put the `tasks.md` item numbers each task covers (for example `1.2, 1.3`) in the task
  description, so implement can tick them off later.
- Turn each WHEN / THEN scenario a task covers into a verification criterion for that task.

If the ticket and the change disagree, the change wins. Note the disagreement in your plan
rather than picking one silently.
```

`~/.ralphctl/skills/implement/openspec-implement/SKILL.md`:

```markdown
---
name: openspec-implement
description: Implement a task planned from an OpenSpec change. Use when the task description cites an OpenSpec change or tasks.md item numbers.
---

# Implementing an OpenSpec task

When your task cites an OpenSpec change:

- Read `proposal.md`, `design.md` (when present) and the `spec.md` files under `specs/` in
  `openspec/changes/{change}/` before you edit code.
- Implement only the task you were given, even when `tasks.md` lists more open items. Other
  tasks in the sprint cover the rest.
- Treat every WHEN / THEN scenario your task covers as behaviour the change must satisfy.
- When the work is done, tick the `tasks.md` items your task covers (`- [ ]` to `- [x]`). Leave
  every other item as it is.
- Don't archive the change, sync specs, or move files under `openspec/`. The maintainer does
  that after the sprint lands.
```

Both pass ralphctl's harness rules: they don't touch git, don't call the `openspec` CLI, and leave
archiving to you. If you refine tickets first, a third skill in `~/.ralphctl/skills/refine/` along the
same lines (read the proposal and specs, treat the scenarios as acceptance criteria) stops refine from
re-deriving requirements the change already states.

### 4. Run the sprint

Create a sprint with one ticket per change, and name the change in the ticket, for example "Implement
OpenSpec change `add-dark-mode`". Then refine, plan and implement as usual. Plan turns `tasks.md` into
ralphctl tasks, and implement ticks the matching items as each task lands.

### 5. Archive the change

Once the sprint's pull request merges, run `/opsx:archive add-dark-mode` (or `openspec archive
add-dark-mode`). That merges the change's spec deltas into `openspec/specs/` and moves the change folder
to `openspec/changes/archive/`.

### Gotchas

- When refine, plan, ideate and readiness run headless, they run read-only. On Claude Code, Copilot and
  Grok that means no shell, so a skill that calls the `openspec` CLI fails there, which is why the skills
  above read files directly. Interactive sessions ask you before they run a command.
- If the `openspec-*` folders aren't committed, tasks in parallel mode don't see them.
- You can copy OpenSpec's skills into a `~/.ralphctl/skills/` folder instead of committing them. They
  load fine (the nested `metadata:` block is dropped), but they install as `ralphctl-openspec-*`, and the
  `/opsx:*` slash commands don't come along, since those are commands rather than skills.

## Troubleshooting

- **A skill doesn't show up.** Check that the folder name matches `name:` exactly and that `SKILL.md`
  sits one level below the flow or provider folder. The log names every skill ralphctl skipped and why.
- **It's in the catalog but doesn't load.** Look for its `ralphctl-` name under
  `settings.ai.skills.<flow>.disabled` in `ralphctl settings show`, or press `c` on it in the catalog.
- **ralphctl warns that it kept a folder instead of installing a skill.** A `ralphctl-<name>` folder in
  the repo without ralphctl's install marker counts as yours. Delete it if an older run left it behind.
