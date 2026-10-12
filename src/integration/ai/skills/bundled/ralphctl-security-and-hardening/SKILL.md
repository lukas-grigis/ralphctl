---
name: ralphctl-security-and-hardening
description: Security posture for code that crosses a trust boundary — threat-model first, then validate untrusted input, keep secrets out of code and logs, check authorization, guard destructive operations on derived paths, review new dependencies, minimise personal data, and treat model output as untrusted. Use when writing or reviewing code that handles external input, authentication, sensitive data, file-system targets, third-party services, dependencies, or LLM output; it goes deeper than the security axis of ralphctl-code-review-and-quality (when installed), which it complements.
license: MIT
---

# Security and Hardening

> Adapted from [addyosmani/agent-skills — "Security and Hardening"](https://github.com/addyosmani/agent-skills)
> (MIT). Adapted for ralphctl's harness contract.

Treat every external input as hostile, every secret as sacred, and every authorization check as
mandatory. Security is not a phase — it is a constraint on every line that touches untrusted data,
credentials, or an external system. The concrete controls differ by stack (a web service, a CLI, a
library, a data pipeline); the principles below do not. Apply the ones that match what the code
actually does and skip the ones for surfaces it does not have.

## When this applies

- **Plan** — map the trust boundaries a ticket touches and turn abuse cases into verification
  criteria. A task that changes authentication, stores a new class of sensitive data, adds an external
  integration, or loosens an access rule should say so explicitly in its steps, so the implementing
  session is authorised to make that change rather than having to stop and escalate it.
- **Execute** — when writing code, apply the tiers below as you go. When reviewing a change (the
  evaluator), use them as the security lens: a reachable vulnerability blocks completion, and a
  sensitive change the task never asked for is a finding even when the code itself is sound.
- **Create PR** — name the security-relevant parts of the change (a new trust boundary, an auth or
  permission change, a new dependency, secret or personal-data handling) so the human reviewer knows
  where to look.

## Threat model first

Controls bolted on without a threat model are guesses. Before hardening — or before judging someone
else's hardening — spend a few minutes thinking like an attacker:

1. **Map the trust boundaries.** Where does untrusted data enter? Network requests, form fields,
   uploaded files, webhooks, third-party APIs, message queues, CLI arguments, config files, and **LLM
   output** — plus local values that only look internal because the OS handed them to you: another
   process's command line or environment, filenames on a shared volume, a path inside a job payload.
   Trust follows who _wrote_ a value, not which channel delivered it.
2. **Name the assets.** What is worth stealing or breaking? Credentials, personal data, payment data,
   privileged actions, the integrity of files on disk.
3. **Run STRIDE over each boundary** — a quick lens, not a ceremony:

| Threat                     | Ask                                           | Typical mitigation                                   |
| -------------------------- | --------------------------------------------- | ---------------------------------------------------- |
| **S**poofing               | Can someone impersonate a user or service?    | Authentication, signature verification               |
| **T**ampering              | Can data be altered in transit or at rest?    | Integrity checks, parameterised queries, TLS         |
| **R**epudiation            | Can an action be denied later?                | Audit logging of security-relevant events            |
| **I**nformation disclosure | Can data leak?                                | Encryption, field allowlists, generic error messages |
| **D**enial of service      | Can it be overwhelmed?                        | Rate limits, input size caps, timeouts               |
| **E**levation of privilege | Can someone gain rights they should not have? | Authorization checks, least privilege                |

4. **Write abuse cases next to use cases.** For each behaviour, ask "how would I misuse this?" When
   your session may edit the tree, make that abuse case a test; when it is read-only, name the missing
   abuse-case test as a finding.

If you cannot name the trust boundaries a change touches, you are not ready to secure it — most breaches
begin in design, not code.

## The three tiers

### Always

- **Validate external input at the boundary** with an allowlisting schema (shape, lengths, enums,
  formats); downstream code uses only the parsed, typed value.
- **Parameterise every query and command** — never build SQL, NoSQL, shell commands, or file paths by
  concatenating input strings.
- **Encode output for its context** (HTML, shell, SQL, log line) using the platform's escaping, and do
  not bypass it.
- **Use encrypted transport** for anything leaving the machine.
- **Hash passwords with a slow, salted algorithm** built for the purpose (bcrypt, scrypt, argon2) —
  never store them reversibly.
- **Check authorization, not just authentication** — the caller must own, or be permitted on, the
  specific resource they named.
- **Run the project's dependency audit tool** (when it has one) after adding or upgrading a dependency.

### Escalate first

These changes are sometimes exactly the task — and sometimes a side effect nobody asked for. Make them
when the task's steps or verification criteria explicitly call for them; otherwise, do not make them
silently:

- Adding or changing an authentication flow, session handling, or permission/role logic.
- Storing a new category of sensitive data (credentials, personal data, payment data).
- Adding a new external service integration, network listener, or outbound call.
- Loosening a cross-origin, firewall, sandbox, or file-permission rule.
- Accepting uploaded or user-supplied files.
- Changing rate limits or throttling.
- Granting elevated permissions, or running something with more privilege than it had.

How to escalate depends on the session. With an interactive channel, ask the operator before
proceeding. Without one, never stall on a question nobody can answer, and never quietly widen the
change:

- When acting as the **generator** and the change is needed to meet the criteria but the task does not
  authorise it, stop and emit a `task-blocked` signal with `blockerClass: "ambiguous-request"`, a
  `question` naming the security decision, and `whatUnblocksMe` naming who must make it.
- Otherwise — the change is out of scope, or you are reviewing rather than writing — record it as a
  `note` signal in `signals.json` when the prompt's output-contract section lists it, otherwise fold it
  into the required signal's own findings or rationale fields.

### Never

- **Never commit secrets** — API keys, passwords, tokens, private keys — to code, fixtures, or config.
- **Never log sensitive data** — passwords, tokens, full card numbers, personal data beyond what the
  log needs.
- **Never treat client-side or caller-side validation as a security boundary.**
- **Never disable a security control for convenience** (certificate verification, a sandbox, a
  security header, a permission check) — not even "temporarily".
- **Never evaluate untrusted data as code** — no dynamic `eval`, no raw-HTML injection of user content,
  no shell interpolation of input.
- **Never expose stack traces or internal error details** to the end user or caller; they belong in
  server-side or local logs.

## Hardening controls

### Injection and access control

- Parameterised queries and argument-vector process spawns (not a shell string) close most injection
  classes at once.
- Where raw markup is unavoidable, sanitise with an allowlist sanitiser first.
- Check authorization on every request or operation, scoped to the specific resource — a valid identity
  is not permission to touch someone else's record.

### Authentication, sessions, and network surfaces

When the project serves requests over a network:

- Session secrets come from the environment, never from code. Session tokens live where client scripts
  cannot read them, are bound to the transport, and expire.
- Send the platform's standard security headers; tighten the content policy rather than loosening it.
- Restrict cross-origin access to an explicit origin list from configuration — never a wildcard with
  credentials.
- Strip sensitive fields (password hashes, reset tokens) before any response; error bodies stay generic.
- Rate-limit generally and authentication strictly. Once more than one process serves traffic, an
  in-memory counter silently becomes `limit × instances` — back the limiter with a shared store.

### Uploads and server-side fetches

- Uploaded files: allowlist types, cap size, and verify content when it matters — the extension proves
  nothing.
- Any URL the input influences (webhooks, import-from-URL, previews) can be aimed at internal services.
  Allowlist scheme and host, resolve **all** addresses and reject private, loopback, link-local, and
  reserved ranges (IPv4 and IPv6), and forbid redirects. For high-risk surfaces, pin the resolved
  address — the check alone leaves a DNS-rebinding gap.

### Destructive operations on derived paths

A delete, move, or overwrite is only as safe as the value naming its target. A shape check proves
well-formedness, not authorization. Before the call, require all three: the resolved target (symlinks
resolved) sits under an **allowlisted root**; it is at least one level **below** that root; and it
carries **ownership evidence read before the operation**. On refusal, log the rejected target and stop —
never fall back to a broader default path. Remember the check and the use are separate moments: keep
the window between them small and re-verify when the stakes are high.

### Secrets

Secrets come from the environment or a secret store. Example config is committed with placeholders;
real secret files and key material are ignored by version control. Before signalling completion, read
your own diff for key material. A secret that has already reached a shared history is compromised the
moment it lands — it must be rotated, and rewriting history is not your call in this session: surface it
(see the escalation guidance above) rather than editing history yourself.

### Dependencies and supply chain

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

### Personal data and privacy

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

### AI / LLM features

Calling a model adds attack surface; map it to the OWASP Top 10 for LLM Applications:

- **Model output is untrusted input.** Never pass it into `eval`, a query, a shell, raw markup, or a file
  path; parse defensively, validate against a schema, then encode.
- **Prompts can be hijacked.** Untrusted text in the context — a user message, a fetched page, a
  document — can carry instructions. The system prompt is not a security boundary; enforce permissions in
  code.
- **Keep secrets, other tenants' data, and the full system prompt out of the context window.** Scope
  tool permissions, validate every tool argument, confirm destructive actions, and cap tokens, request
  rate, and recursion depth.

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

## Red flags

- Untrusted input passed directly into a query, a shell command, a file path, or rendered markup.
- A delete, move, or overwrite whose target comes from a payload, a config value, or another process's
  command line, guarded only by a shape check.
- Secrets in source, fixtures, logs, or history.
- Operations that touch a resource without an authorization check on that resource.
- Wildcard cross-origin access, or a security control disabled "temporarily".
- No rate limit on authentication, or an in-memory limiter in front of more than one instance.
- Stack traces or internal errors reaching the user.
- A new dependency with unreviewed install scripts, competing lockfiles, or a forced audit fix.
- A server-side fetch of an input-supplied URL without an allowlist.
- Model output passed into a query, markup, a shell, or `eval`; secrets or personal data placed in a
  model's context window.
- Personal data collected with no stated purpose, retention limit, or working deletion path.
- An auth, permission, or sensitive-data change the task never asked for, made silently.

## Self-check

Before signalling completion — or a passing review — for security-relevant code:

- [ ] The trust boundaries the change touches are named, and each has an abuse case covered or flagged.
- [ ] External input is validated at the boundary; queries and commands are parameterised.
- [ ] Authorization is checked per resource, not just authentication per caller.
- [ ] No secrets in the diff, fixtures, or logs.
- [ ] Destructive filesystem operations resolve symlinks, then verify allowlisted root, minimum depth,
      and ownership before running.
- [ ] Errors reaching the caller carry no internal detail.
- [ ] New or upgraded dependencies were reviewed, and the dependency audit (when the project has one)
      shows no reachable critical or high finding left unmitigated.
- [ ] Model output, when present, is validated and encoded before use.
- [ ] Personal data, when present, is classified, minimised to a purpose, and deletable.
- [ ] Every escalate-first change was either authorised by the task or surfaced per the escalation
      guidance — none made silently.
