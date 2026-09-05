# Interactive handoff — the black-screen hang

**Status:** root cause confirmed 2026-09-04, **fixed 2026-09-05** — `releaseStdinForChild` in
`src/application/ui/shared/stdin-handoff.ts`, awaited by `runInTerminal` in
`src/application/ui/shared/ink-host.ts`. Driven through the real host in a real iTerm window, Grok
reached its pager in 0 of 8 launches before the fix and 8 of 8 after it. Read this before touching
the interactive TTY handoff or re-investigating the hang; it cost several days and six wrong root
causes, all of which are listed below so nobody pays for them twice.

## Symptom

An interactive AI session (seen with Grok, but the mechanism is provider-agnostic) is launched from
the TUI. The screen goes black and stays black. The child process is alive at 0% CPU, blocked in
`kevent`, and never draws anything. Ctrl-C does nothing.

For Grok specifically, `~/.grok/logs/unified.jsonl` shows the process stopping after
`leader.startup_kill.done` and never reaching `startup phase: config_load`. It freezes before it
opens its own debug log, so `--debug-file` cannot see this class of hang.

## Root cause

**A parent process that is still reading `process.stdin` eats the terminal's reply to the child's
capability queries, and the child blocks forever waiting for an answer that already went somewhere
else.**

On startup an interactive CLI writes terminal queries and waits for the reply. Grok sends three:

| Query                     | Sequence    |
| ------------------------- | ----------- |
| Primary Device Attributes | `ESC [ c`   |
| XTVERSION                 | `ESC [ > q` |
| Kitty keyboard protocol   | `ESC [ ? u` |

The terminal answers by writing bytes back into the tty's input buffer. Parent and child share that
file descriptor, so **whoever reads first wins**. A shell never competes — it waits in `waitpid`
while a foreground child runs. A Node parent whose tty handle is still in its reading state does
compete, and wins often enough to hang the child.

"Still reading" is the subtle part. **Unmounting Ink does not release stdin.** Ink's teardown
removes its `readable` listener, drops raw mode and calls `unref()` — and after all of that the
handle is still reading. Measured on Node 26 through `process.stdin._handle.reading`:

| State                                            | `_handle.reading` |
| ------------------------------------------------ | ----------------- |
| never touched                                    | `false`           |
| Ink armed (`readable` listener + raw mode)       | `true`            |
| after Ink-style teardown (listener off, raw off) | **`true`**        |
| after `pause()` + one tick                       | `false`           |
| after a `read()` on an EMPTY buffer              | **`true` again**  |

What actually stops the fd read is Node core: `process.stdin` carries a `'pause'` listener that calls
`readStop()` on the handle one tick later. `pause()` only emits `'pause'` when it is a real state
transition — and it is a documented no-op while a `readable` listener is attached, with the stream
only forgetting that listener's paused state on the tick after it is removed.

This also explains why it is invisible in CI or under a bare pty: nothing there answers a
capability query, so the child's timeout path fires and it carries on. It needs something that
**actually replies**.

### The measurements

All arms strictly sequential, one experiment at a time.

**1. Original arms (2026-09-04), plain Node, real iTerm window, 8 repetitions each, scored on Grok
reaching `pager started`:**

| Arm                                                   | Result              |
| ----------------------------------------------------- | ------------------- |
| launched from the shell                               | 8/8 PASS            |
| Node, plain `spawn` with `stdio: 'inherit'`           | 8/8 PASS            |
| **Node holding stdin (`resume()` + `data` listener)** | **4 HANG / 4 PASS** |
| **Node releasing stdin before the spawn**             | **8/8 PASS**        |

**2. Production host (2026-09-05), the real `createInkHost` with a `ScrollRegion` mounted,
`runInTerminal(() => spawn('grok', …, { stdio: 'inherit' }))`, real iTerm window, 8 repetitions
each, scored by Grok pid on `pager started`:**

| Tree                                | `_handle.reading` at spawn | Result       |
| ----------------------------------- | -------------------------- | ------------ |
| `main` without the release          | `true` (0 listeners)       | **0/8 PASS** |
| with `releaseStdinForChild` awaited | `false`                    | **8/8 PASS** |

The baseline is worse than the plain-Node arm because the host's unmount leaves the handle in
exactly the state above: no consumer, still reading, so the very first reply is buffered by us.

**3. Release-sequence variants (2026-09-05), parent/child Node race under a pty that answers
DA1, 18 runs per variant across reply latencies of 0 / 10 / 30 ms:**

| Variant                                            | parent stole the reply |
| -------------------------------------------------- | ---------------------- |
| held (Ink-style teardown, nothing else)            | 6/18                   |
| remove listeners → `pause()` synchronously         | **8/18**               |
| remove listeners → one event-loop turn → `pause()` | **0/18**               |

The synchronous variant is the one three independent reviewers approved; it never emitted
`'pause'`, so the handle kept reading. Only the measurement caught it.

## The fix

`releaseStdinForChild` in `src/application/ui/shared/stdin-handoff.ts` is **release, then
restore**, and it is `async` on purpose:

- Before the spawn: capture the current `data` / `readable` listeners via `rawListeners()` (so
  `once()` wrappers survive), remove exactly those handlers with `removeListener`, drain only while
  `readableLength > 0`, let one event-loop turn pass, `pause()`, let one more turn pass so Node's
  `readStop` has run, then resolve. **Spawn after the `await`.**
- After the child exits: re-attach exactly the handlers that were removed, in order, and `resume()`
  only if the stream had been flowing. The returned restore function is idempotent.

`ink-host.ts` awaits the release after `await current.waitUntilExit()` — so Ink's own teardown has
already run — and before `fn()`; the restore runs in the `finally` before the Ink remount. Both ends
of that ordering are load-bearing.

Three implementation traps, each measured:

- **`read()` on an empty buffer restarts the handle.** A "drain until `read()` returns null" loop
  re-arms the tty and reintroduces the bug. Only read while `readableLength > 0`.
- **`pause()` right after removing a `readable` listener is a no-op.** See table 3. The settle turn
  is what makes `pause()` a real transition. Under the current unmount handoff Ink removed its
  listener ticks earlier, so the naive version happens to work there — the settle exists so the next
  handoff mechanism does not silently bring the hang back.
- **`removeAllListeners` reaches into consumers you do not own.** It used to be the release, and it
  was deleted in #327 because it permanently detached `ScrollRegion`'s mouse-wheel handler — under
  the old `suspendTerminal` handoff the React tree stayed mounted, so the effect cleanup that
  re-attaches it never ran. Deleting the release removed a real fix to cure a real side effect.
  `tests/unit/application/ui/shared/stdin-handoff.test.ts` spies on both removal methods, so a
  "simplification" back to it fails there rather than in production.

Under the current unmount/remount handoff the tree is torn down anyway, so `ScrollRegion` is not at
risk — but the restore exists regardless, because the handoff mechanism has already changed twice.

Do **not** substitute any of these; each was measured and does not work:

- A wall-clock settle delay between teardown and spawn — 3 HANG / 1 PASS identically at 0ms, 150ms
  and 400ms. (The two event-loop turns inside the helper are not this: they let Node's own stream
  bookkeeping run, they do not wait for the race to resolve itself.)
- Opening fresh `/dev/tty` descriptors instead of inheriting — **8/8 HANG**, deterministically worse.
- Ink's unmount alone — table 2, 0/8.

## Refuted — do not re-investigate

Each of these was proposed, tested, and disproved. Several were shipped before being disproved.

| Theory                                        | How it died                                                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Grok's shared `~/.grok/leader.sock`           | Per-session `--leader-socket` shipped (#325); hang unchanged. Flag later removed (#329).                             |
| Grok's folder-trust prompt                    | `~/.grok/trusted_folders.toml` untouched for a week; a manual run in the untrusted directory started with no prompt. |
| Ink leaving a synchronized-update region open | Ink 7 writes BSU/ESU synchronously in one function body and flushes in `beginSuspend`; the race cannot occur.        |
| Ink painting frames over the child            | Ink guards `onRender` / `writeToStdout` / `writeToStderr` on `isSuspended`.                                          |
| A `.claude/` directory in the working dir     | Reproduced that exact shape; Grok started fine.                                                                      |
| The argv                                      | The exact argv the harness builds, run from a shell, passed 14/14 — prompt pointer included.                         |
| The TUI itself                                | Plain Node with no Ink at all reproduces the hang.                                                                   |

One methodological note, because it wasted a day: an early "refutation" froze the parent with
`SIGSTOP` on a process that had **already been hung for four minutes** and concluded the parent was
innocent. By then the stolen reply was long gone. A test that runs after the race has resolved
cannot say anything about the race.

## Reproducing it

Two instruments, with different reach.

**A real terminal, driven programmatically** — the only oracle for Grok itself:

```bash
osascript -e 'tell application "iTerm"
  set w to (create window with default profile)
  tell current session of w to write text "zsh /tmp/experiment.sh; exit"
end tell'
```

Score each run by whether the child reached its "TUI is up" log line, matched on the child's pid so
concurrent sessions cannot be mistaken for each other — for Grok:

```bash
grep '"pid":'"$pid"',' ~/.grok/logs/unified.jsonl | grep -c '"msg":"pager started"'
```

The highest-fidelity experiment mounts the real `createInkHost` (with a `ScrollRegion`, so both of
Ink's listener kinds are present), calls `runInTerminal(() => spawn('grok', […], { stdio:
'inherit' }))`, snapshots `process.stdin` (`_handle.reading`, `listenerCount('data' | 'readable')`,
`readableLength`) at mount, at spawn and after restore, and kills Grok after ~12 s. That is what
produced table 2; the run-to-run snapshot is what shows whether the release actually happened.

**A pty that answers queries** — a Python `pty.fork()` master that watches the child's output for
`ESC[c` / `ESC[>q` / `ESC[?u` and writes the reply a real terminal would into the slave's input
queue. It reproduces the parent-steals-the-reply race deterministically for a Node child (table 3)
and needs no GUI, so it is the right tool for A/B-ing the release sequence. It does **not**
reproduce the hang for Grok — Grok wins that race in a pty every time (8/8) — so it cannot replace
the real terminal for the end-to-end score.

Rules, all learned the hard way:

- **One experiment at a time.** A watchdog doing `pkill -x grok` will kill a concurrent
  experiment's child and score both arms as false hangs.
- **Never redirect the child's stdout**, and never background it in a script without reattaching
  stdin — POSIX gives an asynchronous list `/dev/null` for stdin, which alone stops the TUI from
  starting and scores every arm a false hang.
- **A harness script must live inside the repo tree** (e.g. `scripts/`) so `react` / `ink` resolve;
  run it with `tsx --tsconfig <root>/tsconfig.json` so `@src/*` resolves too.
- **iTerm's `create window` can hang** when the app has a modal up (a dead-session window left by a
  previous `exit` is enough). Run `osascript` in the background with a timeout and poll for the
  result file instead of trusting the AppleScript call to return.

## Related

- `src/application/ui/shared/stdin-handoff.ts` — the release/restore helper, plus its unit test at
  `tests/unit/application/ui/shared/stdin-handoff.test.ts`.
- `src/application/ui/shared/ink-host.ts` — the unmount/remount handoff (restored in #327); awaits
  the release around `fn()` in `runInTerminal`.
- `src/integration/ai/providers/_engine/run-interactive-session.ts` — where the child is spawned. It
  writes `<unitDir>/spawn-context.json` immediately before every interactive spawn, recording stdin
  listener counts, stream state and the terminal size. That probe is the instrument that made the
  stdin listener counts visible; it ships alongside the fix.
- Any _new_ caller that spawns an interactive child from a process that has touched stdin has to
  release it the same way — the hang is not specific to the TUI or to Grok.
