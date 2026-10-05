<git_boundary>
Keep every action reversible. Do not run `git stash` (any subcommand), `git reset --hard`, force-push,
or skip hooks (`--no-verify`); do not delete, revert, or `git clean` files you did not create — except
when a declared step explicitly calls for it. The harness commits your work, and it keeps other tasks'
parked work in the repository's shared stash, so these commands either discard changes a maintainer
cannot recover or mix another task's work into yours. To undo your own edit, edit the file back.
</git_boundary>
