# README capture of the generator → evaluator loop (#220).
#
# Run from the repository root (needs vhs, ttyd and ffmpeg on PATH):
#
#   vhs .github/assets/demo.tape
#
# `pnpm demo:record` (scripts/record-demo.ts) seeds a throwaway sandbox and replays the canned
# two-round transcript through the real implement chain — no AI CLI is spawned, no tokens spent.
# Round 1: the generator edits hello.py, the evaluator FAILS correctness with a critique.
# Round 2: the generator applies the critique, the evaluator PASSES, the task commits.
# When running as root (CI containers), export VHS_NO_SANDBOX=true first.

Output .github/assets/demo.gif

Require pnpm

Set Shell "bash"
Set FontSize 14
Set Width 1200
Set Height 720
Set Padding 16
Set Framerate 12
Set TypingSpeed 40ms
Set Theme "Builtin Dark"

# Seed + boot off camera: tsx startup is not part of the story.
Hide
Type "pnpm -s demo:record"
Enter
Wait+Screen@90s /tasks pending/
# Let the home menu finish its first paint before the camera rolls.
Sleep 1s
Show

# Home → new flow → Implement → start with defaults → keep the current branch.
Sleep 500ms
Type "n"
Wait+Screen@10s /Pick a flow to run/
Sleep 400ms
Enter
Wait+Screen@10s /Start \(use defaults\)/
Sleep 400ms
Enter
Wait+Screen@10s /Branch strategy/
Sleep 400ms
Enter

# The loop: round 1 FAILS correctness, round 2 applies the critique and PASSES.
Wait+Screen@30s /COMPLETED/
Sleep 2s
