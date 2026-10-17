---
name: ralphctl-api-and-interface-design
description: Interface-design discipline for any surface one piece of code exposes to another — network endpoints, library exports, module boundaries, CLI flags and exit codes, file and message formats. Contract first, one consistent error model, validation at the trust boundary, additive change over breaking change, and every observable behaviour treated as a commitment (Hyrum's law). Use when designing a new interface, changing an existing one, or planning work that crosses a module or service boundary.
license: MIT
---

# API and Interface Design

> Adapted from [addyosmani/agent-skills — "API and Interface Design"](https://github.com/addyosmani/agent-skills)
> (MIT). Adapted for ralphctl's harness contract.

Good interfaces make the right use easy and the wrong use hard. This applies to every surface where one
piece of code talks to another: a network API, a library's exports, a module boundary inside one
repository, a CLI's flags and exit codes, a file or message format. The guidance is language-neutral —
express it in the project's own idiom and with its own typing or schema mechanism.

## When this applies

- **Plan** — when a ticket adds or changes an interface, make the contract its own task or the first step
  of one, and put its shape in the verification criteria: inputs, outputs, error cases, and what existing
  consumers must keep seeing. Name who consumes the interface today.
- **Execute** — define the contract before the body, and check every change to an existing interface
  against its current consumers before making it. When reviewing, a breaking change the task did not ask
  for is a finding even when the new code is correct.

## Every observable behaviour is a commitment

Hyrum's law: with enough consumers, everything observable gets depended on — field order, error message
text, default values, timing, undocumented quirks. So:

- Expose deliberately. Anything a caller can observe is something you may have to keep.
- Keep implementation details out of the interface — storage ids, internal layout, stack traces in errors.
- Tests are necessary but not sufficient: a "safe" change still breaks a consumer that relies on behaviour
  no test pins. Search for real consumers before changing what they can see.

## Core principles

### Contract first

Write the interface — names, input and output shapes, error cases, invariants — before the
implementation. The contract is the spec; the body follows it. Separate what a caller provides from what
the system returns: generated fields (ids, timestamps) appear only in the output shape.

### One error model, everywhere

Pick one way to report failure and use it on every operation: the same envelope or error type, a stable
machine-readable code, a human-readable message, optional detail. Map failure classes consistently —
invalid input, not authenticated, not permitted, not found, conflict, internal. When some operations
throw, others return an empty value, and others return an error object, the caller cannot predict
behaviour. Internal failures never expose internals.

### Validate at the boundary, trust inside

Validate where untrusted data enters: request handlers, argument parsing, config and environment loading,
responses from third-party services, files the code did not write. After validation, internal code
trusts the types and does not re-validate. Third-party responses are untrusted — check shape and content
before using them in logic, rendering, or decisions. For the full trust-boundary treatment, see
ralphctl-security-and-hardening when installed.

### Prefer addition over modification

- Add optional fields, new operations, and new variants a consumer can ignore.
- Do not change a field's type, remove or rename a field, or narrow what was previously accepted.
- When a breaking change is unavoidable, treat it as a migration (ralphctl-deprecation-and-migration when
  installed), not an in-place edit.
- Extend one live version rather than forking a second one consumers must choose between.

### Predictable names and shapes

Follow the conventions the project already uses for this kind of surface, identically across every
operation: casing, resource naming, boolean prefixes, time and id formats. Model variants as an explicit
tagged union or discriminated record rather than a bag of optional fields. Where the language allows,
give each kind of id its own type so one cannot be passed for another. List operations paginate (a limit
plus a stable order or cursor) from the start; partial updates change only the fields provided.

### Retry safety

A state-changing operation either honours an idempotency key or is documented as unsafe to retry. When
it honours one:

- Derive the key from the intent (client-supplied, or an immutable id of the thing being done), never per
  attempt — a fresh random value or a timestamp makes every retry a new effect.
- Claim the key atomically — a uniqueness constraint or a single compare-and-set. A check followed by an
  act is a race.
- Reject the same key arriving with a different payload instead of replaying the first response.
- Decide on purpose what an in-flight duplicate gets: rejected, a bounded wait, or a pending status.
- A timeout is a third outcome — unknown. Record the intent before the side effect so it can be resolved.
- Keep keys longer than the longest path that can re-deliver the same request.

## Common rationalisations

| Rationalisation                            | Reality                                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| "Nobody uses that undocumented behaviour"  | If it is observable, someone depends on it. Treat it as a commitment.                     |
| "We'll pin the contract down later"        | The contract is the documentation. Define it first; the implementation follows it.        |
| "Internal interfaces don't need contracts" | Internal consumers are still consumers. Contracts are what let them change independently. |
| "We don't need pagination yet"             | Adding it once a list has grown is a breaking change.                                     |
| "Accepting the idempotency key is enough"  | Accepting it tells clients retries are safe; storing it against the result makes it so.   |

## Red flags

- An operation that returns different shapes depending on conditions.
- Inconsistent error formats across one interface.
- Validation scattered through internal code instead of at the boundary.
- A field changed, renamed, or removed in place.
- A list operation without pagination.
- Third-party responses used without validation.
- A lookup-then-insert idempotency check, or a key regenerated on every attempt.

## Self-check

- [ ] Every operation has explicit input and output shapes and named error cases.
- [ ] One error model across the whole interface.
- [ ] Validation happens at the boundary only.
- [ ] Changes to an existing interface are additive, or handled as a migration.
- [ ] Naming matches the conventions the project already uses.
- [ ] The retry behaviour of every state-changing operation is a deliberate choice.
