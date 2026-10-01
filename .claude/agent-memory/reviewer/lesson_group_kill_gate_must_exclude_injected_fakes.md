---
name: lesson_group_kill_gate_must_exclude_injected_fakes
description: A "only group-kill children we marked" gate is bypassed if the marking site also marks injected test-fake children with made-up pids; check every markProcessGroupLeader caller
metadata:
  type: feedback
---

When a module guards `process.kill(-pid)` behind a "this child leads its own group" registry, grep every call site
that adds to the registry. A site that marks whatever its injectable `spawn` returns (e.g. `trySpawnChild` in
`shell-script-runner.ts`) also marks test fakes (`pid: 12345`), so abort/timeout tests signal a real process group
on the dev machine — exactly what the gate's doc comment claims it prevents.

**Why:** the gate was proven only in its own unit test with a hand-built fake; the integration test fakes go through
a different marking path.

**How to apply:** for any new kill-by-negative-pid helper, check (1) who marks, (2) whether injected spawns can reach
the mark, (3) that tests of abort/timeout paths spy `process.kill` or use `pid: undefined`.

Also worth checking on lock/record "dead owner" logic: `os.hostname()` equality as a same-host test is unstable on
macOS (DHCP/mDNS rename) and identical across containers sharing a volume with different pid namespaces.
