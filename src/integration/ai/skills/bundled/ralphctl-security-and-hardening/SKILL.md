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
  criteria within the ticket's scope. A task that changes authentication, stores a new class of sensitive data, adds an external
  integration, or loosens an access rule should say so explicitly in its steps, so the implementing
  session is authorised to make that change rather than having to stop and escalate it.
- **Execute** — when writing code, apply the tiers below as you go. When reviewing a change (the
  evaluator), use them as the security lens: a reachable vulnerability blocks completion, and a
  sensitive change the task never asked for is a finding even when the code itself is sound.

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

4. **Write abuse cases next to use cases.** For each behaviour, ask "how would I misuse this?" Make it a test when the task's steps or criteria cover tests or the project already tests this boundary; otherwise name the missing abuse-case test in a note.

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

Read `references/hardening-controls.md` for the concrete controls of the surface your code touches:

- Injection and access control: when code builds queries, process spawns or markup from input, or checks permissions.
- Authentication, sessions, and network surfaces: when the project serves requests over a network.
- Uploads and server-side fetches: when it accepts files or fetches an input-supplied URL.
- Destructive operations on derived paths: when a delete, move or overwrite target is computed.
- Secrets: when handling credentials, tokens or keys.
- Dependencies and supply chain: when adding or upgrading a package.
- Personal data and privacy: when collecting or storing personal data.
- AI / LLM features: when calling a model or consuming its output.

The same file holds the common rationalisations to check yourself against.

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
