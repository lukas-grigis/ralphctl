---
name: lesson-tui-error-step-dead-end-probe
description: A TUI wizard that claims the prompt for its whole lifetime has no global Esc on a terminal error step; probe it with useGlobalKeys in the harness, and run the probe from the scratchpad without touching the repo
metadata:
  type: feedback
---

`App` mounts `useGlobalKeys({ disabled: ui.promptActive })`, so while a view holds `claimPrompt()` nothing pops on Esc
or `h`. A wizard whose error step renders "Press esc to go back" but claimed the prompt for its whole mount
(`create-project-view.tsx`: `useEffect(() => claimPrompt(), [claimPrompt])`, `backStep('error') === undefined`) is a
dead end: only Ctrl+C (quits the whole app) leaves. `add-repository-view.tsx` fixed this by claiming only on prompt
steps; `add-ticket-view.test.tsx` carries a "failure steps always have an exit" test. Check every wizard for both.

**Why:** a fix that adds a new, easy-to-hit error (duplicate slug rejection) makes a latent dead end reachable by
ordinary use, and the existing wizard test only asserts the error text, never the exit.

**How to apply:** when a diff adds an error path to a wizard view, mount the view in `renderView` with a wrapper that
calls `useGlobalKeys({ disabled: ui.promptActive })` (see `tasks-panel-host-escape.test.tsx`), drive it to the error
step, press ESC, assert the route popped. Include a control case (plain child, no claim) so a harness fault cannot
read as a product bug.

**Out-of-tree probe recipe (read-only review):** write `vitest.probe.config.ts` in the scratchpad with
`root: <repo>`, `resolve.alias` for `@src`/`@tests`, `server.fs.strict=false`, `test.include: [<absolute scratch
glob>]`, `env: { FORCE_COLOR: '0' }`; run `npx vitest run --config <that file>` from the repo. vitest swallows
`console.log` there, so write results to a scratch file and `cat` it.
