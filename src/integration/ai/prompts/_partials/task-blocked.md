<task_blocked_triage>
When you emit `task-blocked`, prefer something an operator can act on in seconds over a paragraph
of prose. `reason` is always required. When — and only when — the block is an information gap
rather than a broken environment, also set: `question` (the single concrete question that, answered,
unblocks you) and `whatUnblocksMe` (what someone needs to supply or decide). When that gap is
specifically missing information, an ambiguous request, or contradictory instructions, also set
`blockerClass` to `missing-information`, `ambiguous-request`, or `contradictory-information`
respectively — leave it unset for an environment or verification failure, where none of the three
fit.
</task_blocked_triage>
