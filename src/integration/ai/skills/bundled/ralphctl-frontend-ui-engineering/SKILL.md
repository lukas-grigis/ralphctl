---
name: ralphctl-frontend-ui-engineering
description: UI engineering discipline for user-facing interfaces — follow the project's design system and tokens instead of a generic look, handle loading, empty, error, and permission states, meet accessibility basics (keyboard access, labels, focus, contrast, never colour alone), and keep components focused with data loading separate from presentation. Use when building or changing screens, components, layouts, or interaction states in any UI stack.
license: MIT
---

# Frontend UI Engineering

> Adapted from [addyosmani/agent-skills — "Frontend UI Engineering"](https://github.com/addyosmani/agent-skills)
> (MIT). Adapted for ralphctl's harness contract.

Build interfaces that look like a design-aware engineer made them for this product: the project's own
design system, every state handled, usable from a keyboard and a screen reader. The specifics differ by
stack — a component framework, server-rendered templates, a native toolkit — so learn this project's
before writing any UI.

## When this applies

- **Execute** — whenever the task builds or changes something a user sees or operates. When reviewing a
  UI change, use the self-check below as the lens: a missing state or an inaccessible control is a
  finding, not a nit.

## Discover the UI stack first

Find the component library, the theme or token file (colour, spacing, type, radius), the existing
components that already solve part of the task, and how the project tests UI (component tests,
accessibility checks, visual or browser tests). Reuse a house component before writing a new one.

## Components

- **One job per component.** A component that fetches, transforms, and renders is three things.
- **Composition over configuration.** A growing list of layout and variant flags signals a component
  that should accept children or slots instead.
- **Data apart from presentation.** A container loads data and decides which state to show; a
  presentational piece renders what it is given. The presentational piece is then trivial to test.
- **The simplest state that works.** Local state first; lift it only when siblings share it; a shared
  context for read-mostly app-wide values; the URL for shareable view state (filters, pagination); the
  project's server-data layer for remote data; a global store only for complex client state many places
  share. Use the mechanisms the project already has.

## Follow the design system

- Use the project's tokens for colour, spacing, type, and radius — never a raw value off the scale.
- Keep the type hierarchy: heading levels in order, heading styles only on headings.
- Use realistic content when building, not placeholder text — real lengths reveal wrapping and overflow.
- Avoid the generic generated look: a default accent palette on everything, decorative gradients,
  maximal rounding, uniform oversized padding, stock card grids, stacked shadows. Each one ignores the
  product's real hierarchy; the project's system already decided these.

## Handle every state

Each view that loads or changes data needs, where it applies:

- **Loading** — a placeholder that keeps the layout stable.
- **Empty** — what this is and the next action, never a blank area.
- **Error** — what went wrong in plain words and a way to retry.
- **Partial or not permitted** — what the user can still do.
- **Success** — feedback that the action happened.

Check long and short content, and the narrowest and widest layouts the product supports.

## Accessibility basics

- Use native interactive elements (buttons, links, inputs) over clickable generic containers. A custom
  control needs a role, keyboard focus, and the expected key handling.
- Every control is reachable and operable from the keyboard, in a sensible order.
- Every input has a label; an icon-only control has an accessible name.
- Move focus deliberately when content changes — into a dialog when it opens, back when it closes.
- Text meets WCAG AA contrast (4.5:1 for body text, 3:1 for large text).
- Never convey state by colour alone; pair it with text or an icon.

## Verification

Extend the project's existing UI tests for the new states and controls. When the project has no way to
check something in this session (a visual check, a screen-reader pass), say what was not verified in a
`note` signal when the prompt's output-contract section lists it; otherwise fold it into the required
signal's own fields.

## Red flags

- Raw colour or spacing values instead of tokens.
- A view with no loading, empty, or error state.
- A clickable element that the keyboard cannot reach.
- Colour as the only indicator of state.
- A new component that duplicates one the project already has.

## Self-check

- [ ] Uses the project's components and tokens.
- [ ] Loading, empty, error, permission, and success states are handled where they apply.
- [ ] Every interactive element works from the keyboard and has an accessible name.
- [ ] Focus moves correctly when content changes.
- [ ] Contrast meets AA; no state is conveyed by colour alone.
- [ ] Works at the narrowest and widest supported layouts.
