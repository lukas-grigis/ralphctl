---
name: execute-view-selection-convergence-reversal
description: Execute-view focus-driven selection convergence was added (6fbc7f8b), reverted (4593036f) for persisting-on-peek, then re-added non-persisting (Jul 2026) — read before touching this area again
metadata:
  type: project
---

History on `src/application/ui/tui/views/execute-view.tsx` + `runtime/selection-context.tsx`:

1. Commit `6fbc7f8b` ("keep the project/sprint combo coherent across flows") added an effect: focusing
   an Execute view (Tab / Ctrl+1..9 / Sessions-open, or landing there after a launch) converged the
   global `SelectionProvider` onto the run's pinned project/sprint, via `setProjectAndSprint` — which
   also **persists to disk** (the provider's `onChange` fires on every post-mount selection change).
2. Commit `4593036f` ("selection stays the user's pick; settled runs land on Home") **reverted** that
   effect: "peeking at any old session silently re-pinned its sprint as current, so the next boot
   landed on the wrong sprint." Two regression-fence tests were added asserting focusing a run NEVER
   converges the selection, plus an inline `// NOTE deliberately NO selection convergence here` comment.
3. Jul 2026 quality-sweep task re-requested the exact 6fbc7f8b behavior verbatim ("closes a verified
   design gap") without apparent awareness of step 2's revert. Investigated via `git log`/`git show` on
   `execute-view.tsx` before implementing — confirms the "closes a gap" framing was stale/uninformed.

**Resolution shipped:** re-added convergence, but fixed the actual defect from step 2 instead of blindly
reintroducing it:

- Added `SelectionApi.followFocusedRun` (`selection-context.tsx`) — atomic like `setProjectAndSprint`
  but **deliberately does NOT persist** (a `skipNextPersistRef` flag makes the provider's persist effect
  skip exactly that one state transition). A purely exploratory Tab-cycle through old sessions can no
  longer corrupt the next boot's default sprint — the specific harm 4593036f called out.
- Convergence DOES fire the `lastSwitch` toast ("✓ now on …") — directly answers the OTHER half of
  4593036f's complaint ("peeking … silently re-pinned"): the switch is now visible, not silent.
- Guarded against converging onto a closed/removed pin via a tri-state probe (`'checking' |
'available' | 'unavailable'`) in the new `execute-view-internals/use-pinned-sprint-context.ts` — the
  prior `pinnedSprintAvailable` boolean defaulted optimistically to `true` while the async check was in
  flight, so converging on it immediately raced the probe. Caught this via a failing test before
  shipping (see that file's `usePinnedSprintProbe`).
- Loop-safe by construction: the effect's own write lands `pinnedSprintId === selection.sprintId` on
  the next render, tripping the guard.

**Lesson for future conflicting task instructions:** when a task description explicitly asks to
reintroduce behavior that reads like a recently-reverted bug (especially phrased as "closes a design
gap" for something the code has an inline `NOTE deliberately NOT …` comment about), check `git log -- 
<file>` for the specific area before implementing. The instruction turned out to be stale, not
malicious — the right response was to implement the INTENT (screen-matches-action) while fixing the
actual defect, not to silently comply or silently refuse.

See also [[project_cross_project_sprint_picker]] for the broader selection-coherence design (`S`
picker, `setProjectAndSprint`).
