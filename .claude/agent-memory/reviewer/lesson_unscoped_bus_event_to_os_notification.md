---
name: unscoped-bus-event-to-os-notification
description: A new bus event wired to an OS notification must be scoped to the case that needs the ping; publishing from a shared enqueue point also fires for foreground, user-initiated prompts
metadata:
  type: feedback
---

`createInkInteractivePrompt` publishes `awaiting-input` from its single enqueue point, and
`notification-subscriber` turns every such event into an `attention` OS notification. That adapter is also used for
launch-time pickers (repository picker, Start/Customize/Cancel) and project-detail prompts, which have no
`rootSessionId()` and are asked while the operator is looking at the terminal. The subscriber has no sessionId filter
and the dispatcher has no focus gate, so each AI-flow launch pings "Waiting on you".

**Why:** the unit test pins "no sessionId outside a run" for the queue and "event carries sessionId" for the bus, but
never asserts that a sessionless prompt stays silent — the seam that decides who gets pinged is untested.

**How to apply:** when a diff adds a bus event consumed by the notification subscriber, list every producer of the
shared code path (grep the factory's call sites) and ask which ones are foreground. Prefer filtering on a field that
marks the background case (`sessionId !== undefined`) in the subscriber, and require a negative test.
Also: timer-based tests (`setTimeout(.., 5)` inside, `setTimeout(res, 30)` outside) fail only under full-suite load —
run the full `pnpm test` once, not just the touched file.
