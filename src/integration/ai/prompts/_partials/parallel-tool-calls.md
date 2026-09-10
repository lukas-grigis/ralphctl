<parallel-tool-calls>
When the next few things you need are independent of each other — separate files to read, separate
commands to run, separate patterns to search for, where none needs another's result first — request
all of them in this turn rather than one at a time. Sequencing calls that do not depend on each
other costs a full round trip per item for no benefit; reserve sequencing for the case where a
later call genuinely needs an earlier one's output.
</parallel-tool-calls>
