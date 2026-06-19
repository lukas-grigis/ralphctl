---
name: ralphctl-surgical-simplicity
description: Execute-phase skill — write the minimum code the task needs and touch only what the task requires; surface out-of-scope findings as notes rather than fixing them inline.
---

# Surgical Simplicity

> Distilled from Andrej Karpathy's public guidance on LLM coding — his January 2026 [X post on coding
> pitfalls](https://x.com/karpathy/status/2015883857489522876) and the ["Software Is Changing" / Software 3.0
> talk](https://www.ycombinator.com/library/MW-andrej-karpathy-software-is-changing-again). Clean-room —
> concepts only, not copied text.

The two failure modes that make AI-generated diffs hard to review are opposite in feel but identical in
cost: writing too much (speculative code that nobody asked for) and touching too much (sweeping the
surrounding file while fixing one function). Both inflate the diff, blur the intent, and make the
post-task gate verdict harder to trust. The antidote is equally simple in each case — write the minimum,
and stop at the boundary the task drew.

## When this applies

- **Execute** — every generator turn that produces, edits, or reorganises code. Both halves below apply
  to every change, large or small.

## What to do

### Simplicity first

1. **Write the minimum code the task needs.** If the task asks for a function, write the function — not the
   interface, the registry, the factory, and the config flag that "might be useful later". Speculative
   additions are never reviewed and rarely removed.
2. **Prefer straightforward over clever.** A hundred readable lines beats fifty lines of indirection that
   save nothing at runtime. Readability is not a style preference; it is the cost of the next change.
3. **Resist adding configuration the task did not request.** A new boolean flag "for flexibility" is a
   permanent branch in every future call path. Add config when a concrete requirement calls for it.
4. **Question every new dependency.** A dependency ships its entire transitive graph. Before adding one,
   ask whether the task's goal is achievable with what the project already has.
5. **Omit defensive handling for scenarios the task's context makes impossible.** A `try/except` around
   code that cannot throw in the calling contract adds noise without adding safety.

### Surgical changes

1. **Touch only what the task requires.** The task spec's verification criteria define the boundary. Code
   outside that boundary is out of scope for this diff.
2. **Do not reformat or re-style code your change does not own.** Fixing indentation, renaming variables,
   or reorganising imports in an adjacent function makes the diff harder to read and raises the risk of a
   merge conflict with concurrent work.
3. **Clean up only the orphans your own change creates.** If adding a function makes an existing helper
   unreachable, removing that helper is in scope. Removing a different dead helper you noticed nearby is
   not — it is a separate, unreviewed concern.
4. **When you spot a pre-existing issue outside the task's scope — dead code, a latent bug, a misleading
   comment — surface it as a `<note>` signal and leave it untouched.** The harness captures the note in the
   sprint's progress journal; the operator can schedule it as a follow-on task. Fixing it inline hides the
   fix inside an unrelated diff and makes the sprint harder to fold into one coherent PR.

## Anti-patterns

- **Scaffolding ahead of demand.** Introducing an interface, an abstract base, or a plugin registry for a
  single concrete implementation in anticipation of future cases is speculative. It encodes assumptions
  that may never become true and costs every subsequent reader of that file.
- **"While I'm in here" refactors.** Noticing that a nearby function could be cleaner and editing it
  alongside the task's target change. The diff now contains two intents, neither of which is reviewable in
  isolation.
- **Noise commits.** Reformatting a file, then making the intended change in the same edit. The signal is
  buried; the gate can't tell which line caused a failure.
- **Silently fixing pre-existing bugs.** A bug found outside the task's scope is real — but fixing it
  inline and not surfacing it means the reviewer cannot tell whether the fix was intentional, the test
  coverage for it was already there, or the change introduces a subtle regression elsewhere.
