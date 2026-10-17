---
name: detached-spawn-needs-reaper-registration
description: Making a spawn site `detached` (own session) drops terminal-hangup propagation; check the OrphanReaper / child registry covers it
metadata:
  type: feedback
---

When a runner that used to share ralphctl's process group starts spawning `detached: true` (git runner got this
for hook reaping), the kernel's terminal-hangup SIGHUP no longer reaches the child or its hooks. The AI-CLI path
and the shell-script runner compensate by announcing the pgid to the `OrphanReaper` sidecar (`reaper.watch`,
`childRegistry`); a runner that detaches without that registration leaves orphans nobody reaps.

**Why:** a pre-commit hook (minutes of lint/tests) kept running after the terminal closed, and still held the
index. `createGitRunner()` in `wire.ts` takes no reaper while `createShellScriptRunner({ reaper })` does, so the
asymmetry is greppable.

**How to apply:** for any diff adding `detached: true` / `markProcessGroupLeader`, grep the wiring site for
`reaper` and ask what kills the group when ralphctl dies. Probe, no mocks needed: start a node script that spawns
the child under `python3 -I` with `preexec_fn=os.setsid`, then `os.killpg(pid, SIGHUP)` and `kill(hookPid, 0)`;
run the same script with a plain non-detached spawn to show the old behaviour (hook dies).
