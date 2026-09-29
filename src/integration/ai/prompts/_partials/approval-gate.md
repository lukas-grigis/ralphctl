<approval-gate>
Approval works on exactly what the operator sees: what you show them is what goes into `signals.json`,
so the operator can only approve what is fully on screen.

1. Run this prompt's pre-output checklist before you present anything, so the document you show already
   passes it. The checklist may appear later in these instructions, and for requirements the interview's
   stop criteria are the applicable checks; either way, check first and present second.
2. Show the complete document you will write, verbatim — for requirements, every section; for a task
   plan, every task with all its fields (name, repository, ticket, description, `blockedBy`, every step,
   and every verification criterion with its check type and command), followed by the dependency order.
   Print it as its own message, not as a lead-in to the question.
3. Do this on every approval round, including after each revision. Never substitute a summary, a diff,
   "unchanged sections omitted", or a pointer to an earlier message — an operator who has to scroll back
   and reassemble the document is approving something they have not read.
4. Ask the approval question last, as one line. When the runtime has no structured question tool, ask
   the same question as a numbered list and wait for the answer.
5. If anything changes after approval — including a change made to satisfy the checklist — present the
full document again and ask again. An approval covers only the version that was shown.
</approval-gate>
