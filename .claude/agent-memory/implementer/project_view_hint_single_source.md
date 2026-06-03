---
name: project-view-hint-single-source
description: TUI hints share one source of truth with handlers via useViewHints enabledWhen; inline body-footer hint prose is a duplicate that must be removed when gating a key
metadata:
  type: project
---

A TUI view's advertised keys and its handlers must share ONE source of truth. The canonical
mechanism is `useViewHints([...])` (rendered by the router's StatusBar), and `ViewHint.enabledWhen`
(added in the Wave-2 refactor, defined in `use-view-hints.tsx`) gates an individual hint's
visibility. The provider filters out `enabledWhen === false`; `undefined`/`true` always show.
Prefer a static array with `enabledWhen` flags over conditional `...(cond ? [hint] : [])` spreads.

**Why:** advertising a key whose handler is gated (e.g. ticket add/remove gated on draft-only,
`e rename` gated on `status !== 'done'`, repo chords gated on a focused repo row) lies to the user.
§6.3 of DESIGN-SYSTEM.md: "Any undocumented key is a bug" — and the inverse, an advertised dead
key, is equally a bug.

**How to apply:** When gating a hint, also hunt for a SECOND ungated advertisement. Several views
(sprints-view, project-detail-view) carried an inline dim body-footer `<Text>` re-listing the same
keys (`· c create · e rename · d delete`). That footer doesn't respect `enabledWhen` and re-asserts
the key ungated — remove it (keep only non-key content like the item count) so the hint strip is the
only key advertisement. The sprint-detail `ActionBar` footer is fine because it lists ONLY
always-available nav chords (`↑/↓ focus`, `↵/o expand`, `n flows`, `esc back`) and never advertises
a gated key. Tests assert hint visibility by `frame.toContain('add ticket')` /
`.not.toContain('e rename')` against the rendered StatusBar — note these will ALSO catch a stray
body-footer duplicate, which is how the conflict surfaces.
