---
name: ralphctl-codebase-design
description: Shared vocabulary and tests for module design — deep modules (much behaviour behind a small interface), seams placed where behaviour actually varies, the deletion test for pass-through layers, and the interface as the test surface. Use when planning module boundaries, deciding where a seam or abstraction belongs, judging whether a layer earns its keep, or making code easier to test through its interface.
license: MIT
---

# Codebase Design

> Adapted from [mattpocock/skills — "Codebase Design"](https://github.com/mattpocock/skills) (MIT).
> Adapted for ralphctl's harness contract.

Design **deep modules**: a lot of behaviour behind a small interface, placed at a clean seam, testable
through that interface. The aim is leverage for callers, locality for maintainers, and testability for
everyone. Reason with the vocabulary below; in code and in signals, keep the project's own terms when it
has established ones.

## When this applies

- **Plan** — when splitting work, prefer tasks that deepen one module behind a small interface over tasks
  that spread one concept across several shallow ones. When a task introduces a seam, name it in the
  steps along with what varies across it.
- **Execute** — whenever you add a module, an interface, or an abstraction. When reviewing, apply the
  deletion test and the one-adapter rule below to every new layer.

## Vocabulary

- **Module** — anything with an interface and an implementation, at any scale: a function, a type, a
  package, a slice spanning several layers.
- **Interface** — everything a caller must know to use the module correctly: the type signature, plus its
  invariants, ordering constraints, error modes, required configuration, and performance characteristics.
- **Implementation** — the code inside the module.
- **Depth** — leverage at the interface: how much behaviour a caller or test can exercise per unit of
  interface it has to learn. **Deep** when much sits behind little; **shallow** when the interface is
  nearly as complex as what it hides.
- **Seam** (Michael Feathers) — a place where behaviour can be altered without editing in that place; the
  location where a module's interface lives. Where to put the seam is its own decision.
- **Adapter** — a concrete thing that satisfies an interface at a seam. It names a role, not a size.
- **Leverage** — what callers gain from depth: more capability per thing they learn.
- **Locality** — what maintainers gain from depth: change, bugs, and knowledge concentrated in one place.
  Fix once, fixed everywhere.

## Principles

- **Depth is a property of the interface.** A deep module can be built from small, swappable internal
  parts; they are just not part of its interface. It may have internal seams for its own tests as well as
  the external seam callers use.
- **The deletion test.** Imagine deleting the module. If complexity vanishes, it was a pass-through. If
  the complexity reappears across many callers, it was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam. Needing to test past the
  interface means the module is the wrong shape.
- **One adapter is a hypothetical seam; two adapters is a real one.** Introduce a seam only where
  something actually varies across it — a second implementation, or a test fake standing in for slow or
  non-deterministic infrastructure.

When designing an interface, ask: can it have fewer operations, simpler parameters, more hidden inside?
Before committing to one shape, sketch two or three genuinely different interfaces for the same job and
compare them on depth, locality, and where the seam falls.

## Designing for testability

- **Accept dependencies instead of creating them.** A function that receives its payment gateway or
  clock can be tested with a fake; one that constructs the real thing internally cannot.
- **Return results instead of producing side effects.** Computing a discount and returning it is testable
  by assertion; mutating a shared total in place is testable only by inspection.
- **Keep the surface small.** Fewer operations mean fewer tests; fewer parameters mean simpler setup.

## Rejected framings

- **Depth as a ratio of implementation lines to interface lines** — it rewards padding the implementation.
  Depth here means leverage.
- **"Interface" as only a language keyword or a list of public methods** — too narrow; every fact a caller
  must know is part of it.
- **"Boundary"** for a seam — overloaded with domain-driven design's bounded context. Say seam or
  interface.

## Red flags

- A module whose interface mirrors its implementation one-to-one.
- A wrapper that only forwards calls.
- An interface with exactly one implementation and no test fake — a seam nothing varies across.
- A test that reaches past the interface into internals.
- One concept spread across several shallow modules that must always change together.
