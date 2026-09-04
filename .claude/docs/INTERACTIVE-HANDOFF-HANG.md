# Interactive handoff — the black-screen hang

**Status:** root cause confirmed 2026-09-04. **Fix not yet implemented.** Read this before touching
the interactive TTY handoff or re-investigating the hang; it cost several days and six wrong root
causes, all of which are listed below so nobody pays for them twice.

## Symptom

An interactive AI session (seen with Grok, but the mechanism is provider-agnostic) is launched from
the TUI. The screen goes black and stays black. The child process is alive at 0% CPU, blocked in
`kevent`, and never draws anything. Ctrl-C does nothing. Roughly 1 launch in 3.

For Grok specifically, `~/.grok/logs/unified.jsonl` shows the process stopping after
`leader.startup_kill.done` and never reaching `startup phase: config_load`. It freezes before it
opens its own debug log, so `--debug-file` cannot see this class of hang.

## Root cause

**A parent process that is holding `process.stdin` open eats the terminal's reply to the child's
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
while a foreground child runs. A Node parent with an active `data` listener and a resumed stdin
does compete, and wins often enough to hang the child about half the time.

This also explains why it is invisible in CI or under a bare pty: nothing there answers a
capability query, so the child's timeout path fires and it carries on. It needs a **real terminal
emulator that actually replies**.

### The measurement

Four arms, run strictly sequentially in a real iTerm window, 8 repetitions each, scored on whether
Grok reached `pager started`:

| Arm                                                     | Result              |
| ------------------------------------------------------- | ------------------- |
| launched from the shell                                 | 8/8 PASS            |
| Node, plain `spawn` with `stdio: 'inherit'`             | 8/8 PASS            |
| **Node holding stdin (`resume()` + a `data` listener)** | **4 HANG / 4 PASS** |
| **Node releasing stdin before the spawn**               | **8/8 PASS**        |

"Releasing" means: detach the listeners, `pause()`, and drain whatever is already buffered.

## The fix, and the trap in it

`releaseTerminalForChild` used to do exactly that release. It was **deleted in #327** because
`removeAllListeners('data')` permanently detached `ScrollRegion`'s mouse-wheel handler — under the
old `suspendTerminal` handoff the React tree stayed mounted, so the effect cleanup that re-attaches
it never ran. Deleting the release removed a real fix to cure a real side effect.

The correct shape is **release, then restore**:

- Before the spawn: capture the current `data` / `readable` listeners, remove those specific
  handlers (not `removeAllListeners`, which reaches into consumers you do not own), `pause()`, and
  drain the buffer.
- After the child exits: re-attach exactly the handlers that were removed and resume.

Under the current unmount/remount handoff the tree is torn down anyway, so `ScrollRegion` is not at
risk — but the restore must exist regardless, because the handoff mechanism has already changed
twice and the next change must not silently reintroduce the bug.

Do **not** substitute any of these; each was measured and does not work:

- A settle delay between teardown and spawn — 3 HANG / 1 PASS identically at 0ms, 150ms and 400ms.
- Opening fresh `/dev/tty` descriptors instead of inheriting — **8/8 HANG**, deterministically worse.

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

A bare pty will not reproduce this — it answers no queries. You need a real terminal, driven
programmatically:

```bash
osascript -e 'tell application "iTerm"
  set w to (create window with default profile)
  tell current session of w to write text "zsh /tmp/experiment.sh; exit"
end tell'
```

Score each run by whether the child reached its "TUI is up" log line — for Grok:

```bash
before=$(grep -c '"msg":"pager started"' ~/.grok/logs/unified.jsonl)
# … launch, wait, kill …
after=$(grep -c '"msg":"pager started"' ~/.grok/logs/unified.jsonl)
```

Two rules, both learned the hard way:

- **One experiment at a time.** A watchdog doing `pkill -n -x grok` will kill a concurrent
  experiment's child and score both arms as false hangs.
- **Never redirect the child's stdout**, and never background it in a script without reattaching
  stdin — POSIX gives an asynchronous list `/dev/null` for stdin, which alone stops the TUI from
  starting and scores every arm a false hang.

## Related

- `src/application/ui/shared/ink-host.ts` — the unmount/remount handoff (restored in #327).
- `src/integration/ai/providers/_engine/run-interactive-session.ts` — where the child is spawned.
- Branch `fix/spawn-context-probe` (unmerged) — writes `<unitDir>/spawn-context.json` immediately
  before every interactive spawn, recording stdin listener counts, stream state and the terminal
  size. That is the instrument that made the stdin listener counts visible; it is worth landing
  alongside the fix.
