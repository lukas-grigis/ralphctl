---
name: seams_process_lifecycle
description: Process groups, the exit+drain settle rule, which git verbs may take a cancel signal, the orphan reaper sidecar, live-run records, the lock owner file and crash resume — the traps behind each and how the tests must be shaped
metadata:
  type: project
---

Files: `integration/io/{kill-process-tree,orphan-reaper,process-liveness,file-locker}.ts`,
`providers/_engine/{child-registry,spawn,idle-watchdog,run-provider-attempt}.ts`,
`application/session/{live-run-recorder,run-child-registry,in-process-runs}.ts`, `business/runs/`.

## Group-kill only marked leaders

`killProcessTree` signals `-pid` only for children in the `markProcessGroupLeader` WeakSet (set by
`defaultProviderSpawn` / the shell runner when they really spawned `detached`). **Why:** every test
fake carries a made-up pid; `process.kill(-4242)` against a pid that happens to lead a real group
signals an unrelated tree on the dev box. `pgid <= 1` is refused outright — `kill(-1)` hits every
process the user owns. Unit tests that want the group path must `vi.spyOn(process, 'kill')`.

## Why group kill also fixes an abort hang

Every headless spawn settles on `'close'` (settling at bare `'exit'` dropped final records under load
on Linux), which waits for EVERY holder of the stdout pipe. A tool subprocess the CLI forked inherits
that pipe, so a single-pid SIGTERM left the attempt hanging until the grandchild exited. The
watchdog's `stop()` deliberately lets a pending group SIGKILL land (unref'd) after the leader exits;
only a lone child's escalation is cancelled (pid-reuse guard).

**The `'exit'`-time group reap keeps `'close'` prompt; `onChildDone`'s 1s drain is the backstop** for a
holder no group kill reaches (Windows has no pgid; a setsid escapee). Don't drop either: the watchdog
can't bound it, since a job writing to the inherited stdout resets the idle timer forever. A real
escapee for tests: `writeStubCli(..., { grandchildEscapesGroup: true })` (node `detached` = setsid;
macOS has no `setsid` binary).

## Skill install marker: own pid uses a boot id, not `ps`

`classifySkillFolder` checks a marker naming `process.pid` against a per-process random boot id
rather than `ps` identity: slim containers have no `ps` and give ralphctl the same pid every start,
so an identity-only check left crash leftovers "live" forever there. Other pids use `processGone`.

## Every piped-output runner settles on exit + drain, not on close alone

`onChildDone` (`integration/io/child-exit.ts`) settles on `close`, or 1s after `exit` with the pipes
destroyed — git, shell, headless engine, run-cli, run-command, clipboard, opencode probe all use it.
**Why git doesn't settle at timer-fire** (run-cli still does on timeout): the next git op would race
the dying git's `.git/index.lock`. **Why not wait for `close`:** a hook's or script's background job
holds the pipe, so a commit that landed was reported as a timeout. Clear the timeout timer on `exit`
so a drain never reads as one. The drain calls `stdout.destroy()`: a fake child that emits `exit`
without `close` needs a `destroy` on its streams or the timer throws. Git children are `detached` (own
session → no controlling tty, so ssh prompts fail fast); git leftovers are NOT killed on a normal exit
(a post-commit hook's background job is legitimate), shell-script leftovers are.

## Which git verbs take the cancel signal

Only hook verbs (checkout, worktree add, merge, cherry-pick, commit, push). Stash push/pop and worktree
remove must NOT: they mostly run on the abort path as cleanup (worktree teardown, best-of-N baseline
restore, the pre-verify exclude pop in a `finally`), and the runner refuses to spawn on an
already-aborted signal — the cleanup would silently skip and strand worktrees/diffs. A cancel can also
report a pop that already dropped its entry as failed, and `restore-blocked-diff`'s undo then resets
the only copy away. A killed hook verb leaves half-done state that callers must handle: a fast-forward
killed in post-merge already landed (`merge-base --is-ancestor`), a killed cherry-pick needs
`--abort`, a worktree add killed in post-checkout leaves a full worktree that the next launch reads as
"stranded" — undo it only when the path did not exist before the add.

## Lock owner file inside a proper-lockfile dir

A file inside the lock dir breaks the library twice: its bare `rmdir` (release, stale reclaim,
exit cleanup) fails ENOTEMPTY, and writing the file bumps the dir mtime so the heartbeat's
"mtime is ours" check reports the lock compromised. Fix = pass a custom `fs`: `mkdir` writes
`owner.json` BEFORE calling back (so it predates the mtime probe), `rmdir`/`rmdirSync` unlink it
first. Do not move to a sibling file or write the owner after `lock()` resolves. Same reason the
owner's `ps` identity is awaited (memoised self-probe) BEFORE `lock()`: it can't be patched in later.
Lock readers (sprint-lock reader, `anyLockHeld`) must gate on the dir mtime being inside the stale
window — a crash leftover otherwise reads as held forever (recycled pid) or for the full window.
`ps -o lstart` is localised; every `ps` probe needs `LC_ALL=C` or identity checks silently turn off.

## Reaper sidecar

Inline `node -e` source (no asset path — tsup splitting), `NODE_OPTIONS` cleared, `detached`,
process and stdin pipe both `unref`'d. Lazy: forked on the first `watch`, so tests with fake spawns
never start it. Real-process tests must run the harness as `node --import tsx <file>` — the `tsx`
CLI forks a child, so SIGKILL would hit the wrapper and leave the real harness alive.

## Live-run records

Scripted / fake children have `pid: 0`; registration skips `pid <= 0` because the record schema
requires a positive pid and one bad spawn would make the whole record unreadable. Recorder writes
are serialised per run and dropped after `end`; tests await `recorder.idle()`, not timers.
Run id = `rootSessionId()` at the spawn site (outermost runner), so parallel branch spawns land in
the host run's record.

## Crash resume (harness-interrupted)

`session-id.txt` is written as the stream yields the id (polled after every stdout chunk in
`run-provider-attempt`), so it now survives a failed spawn — provider tests assert its PRESENCE on a
non-zero exit. Grok reports its id only on `end`, so it can never be captured early.

The resume lookup reads the newest generator round's `session-id.txt` + `role-meta.json`, not the
live-run record: records are keyed by run id and would need a scan. `role-meta.json` gained `cwd`;
a round without it (stamped before) never resumes, and best-of-N candidate spawns don't stamp
role-meta, so an interruption mid-candidate resumes cold. Budget counts go through
`budgetedAttemptCount` — never `attempts.length` — or an interruption silently costs a slot again.
Tests that want start-attempt's resume-time BLOCK need counted attempts already at the cap (e.g.
[failed, running] with `maxAttempts: 1`); a lone interrupted attempt no longer blocks.

A stranded `wt-<task>` block raised in `setupWorktree` rides the branch ctx only — the wave merge
persists it, so a single-branch test must read `runner.ctx.tasks`, not the task repo.

Related: [[seams_provider_engine_streaming]], [[seams_chain_runner_core]], [[seams_escalation_ladder]].
