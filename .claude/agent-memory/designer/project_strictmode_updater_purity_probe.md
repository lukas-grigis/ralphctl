---
name: strictmode-updater-purity-probe
description: How to expose impure React state updaters (refs/sets inside setState callbacks) in Ink prompts, and why home/fake-timer tests stall
metadata:
  type: project
---

Wrap a prompt in `<React.StrictMode>` in ink-testing-library: StrictMode replays state updaters, so any updater that writes refs or calls other setters (old TextPrompt `useLineBuffer`) double-applies, and Enter submits a wrong buffer. Mid-line insert (`initial="ab"`, LEFT, `x`, Enter → expect `axb`) fails on the impure version.

**Why:** the bug is invisible in plain renders; it only shows under replayed/deferred updaters. **How to apply:** advance refs synchronously, then call plain `setX(value)`; never put side effects in an updater.

Fake timers: `vi.useFakeTimers` that fakes `setInterval` stalls `waitForViewReady`/`vi.waitFor` (they poll with it) — fake only after the view is ready, or spin on `setImmediate`.
