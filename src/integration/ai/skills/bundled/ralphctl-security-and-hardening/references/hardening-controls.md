# Hardening Controls

Per-surface controls; apply only the surfaces the code actually has.

## Injection and access control

- Parameterised queries and argument-vector process spawns (not a shell string) close most injection
  classes at once.
- Where raw markup is unavoidable, sanitise with an allowlist sanitiser first.
- Check authorization on every request or operation, scoped to the specific resource — a valid identity
  is not permission to touch someone else's record.

## Authentication, sessions, and network surfaces

When the project serves requests over a network:

- Session secrets come from the environment, never from code. Session tokens live where client scripts
  cannot read them, are bound to the transport, and expire.
- Cookies carrying a session: `Secure`, `HttpOnly`, `SameSite=Lax` or `Strict`. State-changing requests from a browser need CSRF protection unless SameSite and origin checks already cover them.
- Send the platform's standard security headers; tighten the content policy rather than loosening it.
- Restrict cross-origin access to an explicit origin list from configuration — never a wildcard with
  credentials.
- Strip sensitive fields (password hashes, reset tokens) before any response; error bodies stay generic.
- Rate-limit generally and authentication strictly. Once more than one process serves traffic, an
  in-memory counter silently becomes `limit × instances` — back the limiter with a shared store.

## Uploads and server-side fetches

- Uploaded files: allowlist types, cap size, and verify content when it matters — the extension proves
  nothing.
- Any URL the input influences (webhooks, import-from-URL, previews) can be aimed at internal services.
  Allowlist scheme and host, resolve **all** addresses and reject private, loopback, link-local, and
  reserved ranges (IPv4 and IPv6), and forbid redirects. Every server-side fetch of a user-influenced URL
  resolves the host once, rejects those ranges, and pins the resolved address for the request — the check
  alone leaves a DNS-rebinding gap.

## Destructive operations on derived paths

A delete, move, or overwrite is only as safe as the value naming its target. A shape check proves
well-formedness, not authorization. Before the call, require all three: the resolved target (symlinks
resolved) sits under an **allowlisted root**; it is at least one level **below** that root; and it
carries **ownership evidence read before the operation**. On refusal, log the rejected target and stop —
never fall back to a broader default path. Remember the check and the use are separate moments: keep
the window between them small and re-verify when the stakes are high.

## Secrets

Secrets come from the environment or a secret store. Example config is committed with placeholders;
real secret files and key material are ignored by version control. Before signalling completion, read
your own diff for key material. A secret that has already reached a shared history is compromised the
moment it lands — it must be rotated, and rewriting history is not your call in this session: surface it
(see the escalation guidance above) rather than editing history yourself.

## Dependencies and supply chain

- Prefer what the stack already has; every new dependency is attack surface.
- Use the manager the project already uses, at the installation boundary that owns its lockfile; stop
  and escalate on competing lockfiles rather than picking one.
- Install scripts run code at install time. Inspect a new dependency's scripts before allowing them,
  and never blanket-approve.
- Triage audit findings by **reachability** (runtime, build, test, deploy paths) and fix availability.
  Never apply an audit tool's forced-remediation mode automatically — it can cross declared version
  ranges; upgrade one package at a time and let the tests decide.
- Audits match known advisories only. They do not catch a newly malicious or typosquatted package.
  Review new dependencies and lockfile diffs together: ownership, maintenance, release age, provenance,
  transitive graph. Verify registry signatures where the ecosystem supports them.

## Personal data and privacy

Hardening asks "can an attacker read it?" Privacy asks "should we hold it at all, and for how long?" The
cheapest data to protect is data you never collected.

- **Classify fields as you add them** (non-personal, personal, sensitive) and handle each class
  accordingly.
- **Collect only against a stated purpose.** "Might be useful later" is breach scope, not a purpose.
  Keep personal data out of telemetry.
- **Set retention up front, and make deletion work** — including caches, indexes, backups, and
  analytics copies.
- **Design for the data-subject rights the jurisdiction requires** (export, correct, delete): a user's
  data must be findable and erasable, not smeared across systems.
- **Sending personal data to a third party is sharing** — analytics, ads, or an LLM vendor — and needs
  consent and an agreement in place.

A privacy or security incident needs a root-cause pass, not a patch — the
ralphctl-debugging-and-error-recovery skill (when installed) covers that loop.

## AI / LLM features

Calling a model adds attack surface; map it to the OWASP Top 10 for LLM Applications (2025 edition):

- **Model output is untrusted input.** Never pass it into `eval`, a query, a shell, raw markup, or a file
  path; parse defensively, validate against a schema, then encode.
- **Prompts can be hijacked.** Untrusted text in the context — a user message, a fetched page, a
  document — can carry instructions. The system prompt is not a security boundary; enforce permissions in
  code.
- **Keep secrets, other tenants' data, and the full system prompt out of the context window.** Scope
  tool permissions, validate every tool argument, confirm destructive actions, and cap tokens, request
  rate, and recursion depth.
- **Retrieval (RAG) has its own weaknesses** (vector and embedding weaknesses, LLM08). Enforce access control on retrieved chunks per caller, and treat retrieved text as untrusted input.

## Common rationalisations

| Rationalisation                                   | Reality                                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| "This is an internal tool, security can wait"     | Internal tools get compromised. Attackers target the weakest link.                                                   |
| "We'll add security later"                        | Retrofitting security is far harder than building it in.                                                             |
| "No one would try to exploit this"                | Automated scanners will find it. Obscurity is not security.                                                          |
| "The framework handles security"                  | Frameworks provide tools, not guarantees — they still have to be used correctly.                                     |
| "It's just a prototype"                           | Prototypes become production. Security habits start on day one.                                                      |
| "Threat modelling is overkill here"               | A few minutes of "how would I attack this?" prevents design flaws no control can patch later.                        |
| "It's just LLM output, it's only text"            | That text can be a query, a script tag, or a shell command. Treat it like any untrusted input.                       |
| "The audit passed, so the dependency is safe"     | Audits match known advisories; they do not detect a new malicious package or vet install scripts.                    |
| "The criteria need it, so I'll just add the auth" | An auth or permission change the task's steps never named is a decision, not an implementation detail — escalate it. |
| "Collect it now, we might need it later"          | Data you don't hold can't be breached or mis-deleted. "Might need it" is not a purpose.                              |
