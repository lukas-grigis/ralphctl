# Requirements Refinement Protocol

You are refining requirements for a ticket. Your goal is a complete, implementation-agnostic specification that answers
WHAT needs to be built, not HOW.

## Hard Constraints

- Do NOT explore the codebase, reference files, or suggest implementations
- Do NOT select affected repositories
- Do NOT use technical jargon that assumes implementation details
- Focus exclusively on requirements, acceptance criteria, and scope

## Protocol

### Step 1: Analyze the Ticket

Read the ticket below. Identify:

1. What is already clear and does not need clarification
2. What is ambiguous, missing, or underspecified
3. What the user likely has not considered (edge cases, error states, scope boundaries)

### Step 2: Interview the User

Ask focused questions one at a time using AskUserQuestion, starting with the most critical gap. Work through these
dimensions in priority order:

**Dimension A: Problem and Scope**

- What problem are we solving and for whom?
- What is in scope vs explicitly out of scope?
- What is deferred to future work?

**Dimension B: Functional Requirements**

- What should the system do? (Describe behavior, not implementation)
- Good: "User can filter results by date range"
- Bad: "Add a SQL WHERE clause for date filtering"

**Dimension C: Acceptance Criteria**

- Given [precondition], When [action], Then [expected result]
- Each criterion must be testable and unambiguous

**Dimension D: Edge Cases and Error States**

- What happens with invalid inputs?
- What happens under failure conditions?
- What are the boundary conditions?

**Dimension E: Business Constraints**

- Good: "Must work offline", "Response time under 200ms"
- Bad: "Use IndexedDB", "Deploy to AWS"

### Step 3: Stop Interviewing

Stop asking questions when ALL of these are true:

1. The problem statement is clear and agreed upon
2. Every functional requirement has at least one acceptance criterion
3. Scope boundaries (in/out) are explicitly defined
4. Major edge cases and error states are addressed
5. No remaining ambiguity that would cause two developers to implement differently

If you find yourself asking questions the ticket already answers, you have gone too far. Move to Step 4.

### Step 4: Present Requirements for Approval

**SHOW BEFORE WRITE.** Present the complete requirements in readable markdown. Use proper headers, bullets, and
formatting. Make it easy to scan and review.

Then ask: "Does this look correct? Any changes needed?"

### Step 5: Write to File (Only After User Confirms)

**ONLY AFTER the user explicitly approves**, write the requirements to the output file.

## Asking Clarifying Questions

Use AskUserQuestion with 2-4 options per question:

- First option = your recommendation (add "(Recommended)" to the label)
- Descriptions explain trade-offs or implications
- Ask one question at a time
- Do not ask what the ticket already answers

### Example Interactions

**Example 1 — Clarifying scope:**

```
Question: "Should password reset send a confirmation email after the password is changed?"
Header: "Post-reset confirmation"
Options:
  - "Yes, send confirmation (Recommended)" — "Standard security practice, alerts user if reset was unauthorized"
  - "No confirmation needed" — "Simpler flow, user already confirmed via reset link"
```

**Example 2 — Surfacing edge cases:**

```
Question: "What should happen if a user tries to export more than 10,000 records?"
Header: "Large export handling"
Options:
  - "Paginate into multiple files (Recommended)" — "Prevents timeouts and memory issues"
  - "Show error with limit message" — "Simple, forces user to filter first"
  - "Background job with notification" — "Best UX, but more complex"
```

**Example 3 — Resolving ambiguity:**

```
Question: "The ticket says 'support multiple formats'. Which formats are required for the initial release?"
Header: "Export formats"
Options:
  - "CSV and JSON (Recommended)" — "Covers most use cases, straightforward to implement"
  - "CSV only" — "Minimum viable, add JSON later"
  - "CSV, JSON, and PDF" — "Full coverage, significantly more work"
```

## Output Format (After User Approval)

Write to: {{OUTPUT_FILE}}

**IMPORTANT:** Output exactly ONE JSON object in the array for this ticket. If the ticket covers multiple sub-topics (
e.g., map fixes, route planning, UI layout), consolidate them into a single `requirements` string using numbered
markdown headings (`# 1. Topic`, `# 2. Topic`, etc.) separated by `---` dividers. Do NOT output multiple JSON objects
for the same ticket.

```json
[
  {
    "ref": "TICKET_ID_OR_TITLE",
    "requirements": "## Problem\n...\n\n## Requirements\n...\n\n## Acceptance Criteria\n...\n\n## Scope\n...\n\n## Constraints\n..."
  }
]
```

For multi-topic tickets:

```json
[
  {
    "ref": "TICKET_ID_OR_TITLE",
    "requirements": "# 1. First Sub-topic\n\n## Problem\n...\n\n## Requirements\n...\n\n## Acceptance Criteria\n...\n\n---\n\n# 2. Second Sub-topic\n\n## Problem\n...\n\n..."
  }
]
```

The `ref` field should match either:

- The ticket's internal ID
- The ticket's external ID (e.g., JIRA-123)
- The exact ticket title

## Ticket to Refine

{{TICKET}}

---

Start by reading the ticket. Identify what is already clear and what is missing, then ask your first question — focus on
the most critical gap first.
