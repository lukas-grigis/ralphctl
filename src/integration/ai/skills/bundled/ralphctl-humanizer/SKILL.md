---
name: ralphctl-humanizer
description: Edit prose so it reads like a specific person wrote it, without changing what it says — remove staged contrasts, restating closers, run-up openers, reflexive lists of three, dash-chained clauses, inflated significance, promotional and stock model vocabulary, decorative bold and headings, and chat leftovers, while keeping every fact and the format the output contract requires. Use when writing or revising human-facing text such as a PR description, requirements prose, or a summary.
license: MIT
---

# Humanizer

> Concept from [blader/humanizer](https://github.com/blader/humanizer) (MIT), which builds on Wikipedia's
> "Signs of AI writing" guide. The pattern catalogue below is written fresh for ralphctl, not copied.
> Adapted for ralphctl's harness contract.

Generated prose defaults to whatever suits the most readers, so the same safe moves recur in every text.
Someone writing for a particular reader makes particular choices. This skill strips the defaults and keeps
the content.

## How this runs here

- Apply it while writing the prose your output signal carries. The signal gets only the final text — no
  draft, no list of patterns found, no commentary about the edit.
- The prompt's output contract wins: keep its required headings, sections, field formats, and literal
  values. Leave code, commands, paths, identifiers, and link targets exactly as they are.
- Add nothing. No fact, name, number, date, or claim that is not in your source material. When a sentence
  needs a detail you lack, write a simpler sentence.

## When this applies

- **Create PR** — the title and the description body.
- **Refine** — the prose around the requirements. Plain wording never costs a criterion its precision; a
  testable predicate stays testable.

## Method

1. **Find the tells.** Read the whole text and mark every pattern below, at sentence and paragraph scale —
   a contrast split over two sentences, or the same closer after every section, is the same tell bigger.
2. **Rewrite each point plainly.** State it directly; rebuild an awkward paragraph around its main point
   rather than patching phrases. Let sentence length vary.
3. **Check the result.** Nothing added, nothing lost. Then look once more for the tells that survive a
   rewrite most often: contrasts, closers, threes, dashes, and bold labels.

## Patterns, strongest first

### Staging instead of saying

1. **Contrast with a claim nobody made.** "This isn't just X — it's Y", "rather than X", a "No, it's
   not…" sentence followed by the real point, a trailing "— no X needed". The negative half inflates the
   positive one. Keep a contrast only when it corrects something the reader actually believes, or when
   both halves carry information.
2. **Closers that restate.** A last short line repeating the paragraph ("That's the whole point."), a
   string of fragments for drama, emphasis by capitals or dotted words. Cut it unless it adds a fact.
3. **Borrowed depth.** "At its heart", "the real question is", "X is the currency of Y". Replace the
   saying with the specific claim.
4. **Run-ups.** Announcing what comes next ("Here's the thing", "Let's walk through it", "Quick note").
   Start with the content.
5. **Answering no one.** "To be clear", "This doesn't mean", "You might think". Remove the defence unless
   the objection is real in context.

### Rhythm by habit

6. **Reflexive threes.** Three items because three sounds complete. Keep three only when there are three
   distinct things.
7. **Repeated openings.** Several sentences in a row starting the same way. Merge them or vary the
   subject.
8. **Dashes as default glue.** Prefer a period, comma, colon, or parentheses; keep a dash only where
   nothing else fits. Dashes inside code, commands, paths, and URLs stay.
9. **Piled hedges.** "Could potentially perhaps". Keep one qualifier where the doubt is real.

### Inflation

10. **Stock model vocabulary.** Words that turn up far more in generated text than in people's: delve,
    seamless, leverage and harness (as figurative verbs), robust (when not technical), crucial, pivotal,
    myriad, realm, tapestry, landscape (abstract), foster, elevate, empower, unlock, streamline,
    showcase, underscore, testament, meticulous, game-changing, cutting-edge. Use the plain word. One on
    its own is weak evidence; a cluster is strong.
11. **Inflated significance.** "Marks a turning point", "paves the way", "raises the bar", a closing
    paragraph about what the future holds. End on the last concrete fact.
12. **Editorialising -ing tails.** "…, highlighting its importance", "…, ensuring a smooth experience".
    Keep the fact; drop the tail unless the source supports it.
13. **Promotional tone.** "Powerful", "effortless", "best-in-class", "beautifully". Say what the thing does.
14. **Vague authority.** "Experts agree", "widely regarded". Name the source or drop the claim.
15. **Dodging plain verbs.** "Serves as", "functions as", "boasts". Use is and has.
16. **Vague links.** "Associated with", "tied to". Name the actual relation, or keep the vague wording
    when the source gives nothing more.

### Formatting by habit

17. **Bold everywhere.** Bold on ordinary words, or every bullet opening with a bold label and a colon.
    Drop the bold; turn labelled bullets into prose when the labels add nothing.
18. **Decorated headings.** Title Case, emoji, arrows, a rule between every section. Use sentence case and
    plain headings, unless the contract prescribes the heading text.

### Leftovers

19. **Chat residue.** "I hope this helps", "Great question", "Let me know if you'd like", offers to do
    more. Remove the wrapper, keep the content.
20. **Writing about the text.** "Below is a summary of", "this description was generated from",
    narrating how the text was assembled. Describing what a change replaces is fine in a PR description —
    that is its subject.
21. **Knowledge-limit filler.** Admitting a gap and then filling it with a plausible guess. State what is
    not known, or cut the sentence.

### Wrong reader

22. **Re-explaining what the reader knows.** A reviewer already has the ticket and the diff. Lead with the
    decision and keep only the reasoning that would change whether they agree.

## Before and after

Before:

> This PR doesn't just fix the retry loop — it fundamentally transforms how we handle 503 responses,
> ensuring a robust, seamless experience. Retries now stop at the configured limit.

After:

> Retries on a 503 response now stop at the configured limit instead of looping.

Before:

> **Performance:** Performance has been improved. **Reliability:** Reliability has been enhanced.

After: cut both lines. Neither says what changed; name the concrete changes from the diff instead.

## When not to act

Leave a watched phrase alone inside a quotation, a name or title, or text that discusses the phrase. A
single tell is weak evidence; act on clusters. Keep what carries a writer's voice — an unusual specific
detail, mixed feelings, a genuine aside.

## Self-check

- [ ] Every fact, number, and name from the source survives; nothing new was added.
- [ ] The contract's required structure and literal values are untouched.
- [ ] No staged contrast, restating closer, or run-up remains.
- [ ] Code, commands, and paths are unchanged.
