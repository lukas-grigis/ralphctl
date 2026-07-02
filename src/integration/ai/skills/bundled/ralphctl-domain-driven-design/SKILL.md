---
name: ralphctl-domain-driven-design
description: Domain-modelling skill — align code with the business domain through ubiquitous language, bounded contexts, small aggregates, domain events, and core-domain focus. Use when naming concepts, drawing module or service boundaries, deciding entity vs value object, integrating external systems, or when the code no longer matches how the business talks about itself.
license: MIT
---

# Domain-Driven Design

> Adapted from [wondelai/skills](https://github.com/wondelai/skills) (MIT), itself distilling
> Eric Evans' _Domain-Driven Design: Tackling Complexity in the Heart of Software_ (2003).
> Adapted for ralphctl's harness contract.

Framework for tackling software complexity by modeling code around the business domain. The
greatest risk in software is not technical failure — it is building a model that does not
reflect how the business actually works.

**Core principle: the model is the code; the code is the model.** When domain experts and
developers speak the same language and that language is directly expressed in the codebase,
complexity becomes manageable and the system evolves gracefully as the business changes.

## When this applies

- **Refine** — name acceptance criteria in the domain's language; a criterion that needs technical jargon to state usually hides an unmodelled concept.
- **Plan** — draw task boundaries along context and aggregate boundaries, not along technical layers.
- **Execute** — apply the building blocks below when creating or renaming types, modules, and events.

## 1. Ubiquitous Language

A shared, rigorous language between developers and domain experts, used consistently in
conversation, documentation, and code. Ambiguity is the root cause of most modeling failures —
when a developer says "order" and an expert means "purchase request," bugs are inevitable.

- The language emerges from collaboration, not a glossary bolted on after the fact.
- If a concept is hard to name, the model is likely wrong — naming difficulty is a design signal.
- Technical jargon (`DataProcessor` vs. `ClaimAdjudicator`) hides domain logic from the experts who could correct it.
- Name classes and methods after domain concepts and verbs — `LoanApplication`, `policy.underwrite()`, not `RequestHandler`, `process()`.
- Organize modules by domain concept (`shipping/`, `billing/`), not technical role (`controllers/`, `services/`).
- In review, flag `Manager`, `Helper`, `Processor`, `Utils` as naming smells.

## 2. Bounded Contexts and Context Mapping

A bounded context is an explicit boundary within which a particular domain model applies. The
same word ("Customer") can mean different things in different contexts — and that is fine.
Large systems that force a single unified model inevitably collapse into inconsistency.

- A bounded context is not a microservice — it is a linguistic and model boundary that may contain multiple services; start with modules in a monolith.
- Context boundaries often align with team boundaries (Conway's Law).
- The Anti-Corruption Layer is the most important defensive pattern — never let a foreign model leak into your core domain; the exception is a deliberately Conformist integration where you accept the upstream model wholesale to save translation cost.
- Translate external API responses into your own domain objects at the boundary; wrap legacy systems behind an adapter that speaks your domain language.
- A Shared Kernel couples two teams; keep it small and explicitly governed.

## 3. Entities, Value Objects, and Aggregates

Entities have identity that persists across state changes. Value Objects are defined entirely by
their attributes and are immutable. Aggregates are clusters with a single root that enforces
consistency boundaries.

- Entity test: "Am I the same thing even if all my attributes change?" (a person changes name and address — still the same person).
- Value Object test: "Am I defined only by my attributes?" (any $10 bill is interchangeable with another).
- Most things should be Value Objects, not Entities — prefer immutability; replace, never mutate — except where the domain genuinely tracks identity over time.
- Keep aggregates small (one root plus a minimal cluster); reference other aggregates by ID, not object reference.
- Immediate consistency only within an aggregate; design for eventual consistency between aggregates.

## 4. Domain Events

A domain event captures something that happened that experts care about, named in past tense
(`OrderPlaced`, `PaymentReceived`) — a fact that has already occurred. Events decouple cause
from effect: shipping, billing, and notifications each react to `OrderPlaced` independently,
without the ordering context knowing about them.

- Events are immutable facts — once published, they cannot be changed or retracted.
- Domain events are internal to a bounded context; integration events cross boundaries.
- Not every state change deserves an event — only publish what the domain cares about.

## 5. Repositories and Factories

Repositories provide the illusion of an in-memory collection of domain objects, hiding
persistence. Factories encapsulate complex creation so aggregates are always born valid — an
invalid instance becomes unrepresentable.

- The repository interface belongs in the domain layer; its implementation belongs in infrastructure.
- Repository methods speak the ubiquitous language: `findPendingOrders()`, not `getByStatusCode(3)`.
- Factories are warranted for complex rules or multi-part assembly; a two-field Value Object just needs a constructor.

## 6. Strategic Design and Distillation

Not all parts of a system are equally important. Identify the Core Domain — where competitive
advantage lives — and distinguish it from Supporting Subdomains (necessary, not differentiating)
and Generic Subdomains (commodity).

- Core Domain: invest the deepest modeling. Supporting: build, but don't over-engineer. Generic (auth, email, payments): buy or use off-the-shelf.
- Revisit what is "core" as the business evolves — today's differentiator may become tomorrow's commodity.

## Common Mistakes

| Mistake                           | Why It Fails                                                                   | Fix                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Technical names, not domain terms | Logic hidden behind `DataManager`; experts can't validate the model            | Rename to domain terms; if no domain term exists, the concept may be wrong |
| One model to rule them all        | A single `Customer` class for billing, shipping, and marketing becomes bloated | Bounded contexts: each gets its own `Customer` with only what it needs     |
| Giant aggregates                  | Concurrency conflicts, slow loads, transactional bottlenecks                   | Keep aggregates small; reference by ID; eventual consistency between       |
| Anemic domain model               | Objects are data bags; rules scatter across services and duplicate             | Move behavior into entities and value objects; services orchestrate only   |
| No Anti-Corruption Layer          | Foreign models leak in; code couples to external schemas                       | Wrap every external system behind a translation layer                      |
| Bounded context = microservice    | Premature extraction; distributed complexity without benefit                   | A context is a model boundary, not a deployment unit                       |
| Skipping domain experts           | Developers invent a model that doesn't match reality; expensive rework         | Model against the domain vocabulary in the task's source material          |

## Quick Diagnostic

- Can a domain expert read your class names and understand them? If not — rename to the ubiquitous language.
- Are bounded context boundaries explicitly defined? If not — draw a context map with translations.
- Are aggregates small (one root + minimal cluster)? If not — split; reference by ID.
- Do domain objects contain behavior, not just data? If not — move rules out of services into the model.
- Is there an Anti-Corruption Layer at every external integration? If not — add a translation layer at the boundary.
- Have you identified which subdomain is core? If not — classify, and spend the deep modeling there.
