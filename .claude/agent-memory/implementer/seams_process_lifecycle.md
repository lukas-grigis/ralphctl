---
name: seams_process_lifecycle
description: Process groups, the orphan reaper sidecar, live-run records and the lock owner file — the traps behind each and how the real-process tests must be shaped
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

Claude resolves on `'close'`, which waits for EVERY holder of the stdout pipe. A tool subprocess the
CLI forked inherits that pipe, so a single-pid SIGTERM left the attempt hanging until the grandchild
exited. The watchdog's `stop()` deliberately lets a pending group SIGKILL land (unref'd) after the
leader exits; only a lone child's escalation is cancelled (pid-reuse guard).

## Lock owner file inside a proper-lockfile dir

A file inside the lock dir breaks the library twice: its bare `rmdir` (release, stale reclaim,
exit cleanup) fails ENOTEMPTY, and writing the file bumps the dir mtime so the heartbeat's
"mtime is ours" check reports the lock compromised. Fix = pass a custom `fs`: `mkdir` writes
`owner.json` BEFORE calling back (so it predates the mtime probe), `rmdir`/`rmdirSync` unlink it
first. Do not move to a sibling file or write the owner after `lock()` resolves.

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

Related: [[seams_provider_engine_streaming]], [[seams_chain_runner_core]].
