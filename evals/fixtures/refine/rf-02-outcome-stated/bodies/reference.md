# Export the reports table as CSV

## Problem

Account managers who need report data outside the app have to ask support to export it for them.

## Outcome

Account managers pull report data themselves instead of asking support for it.

**Signal:** support requests tagged `report-export`, about a dozen a week today, drop to zero.

## Assumptions

- The table as shown is the data account managers ask support for — **Check:** compare it with last month's `report-export` requests together with the support lead

## Scope

**In scope:**

- A button on the reports page that downloads the current table as a CSV file.

**Out of scope:**

- Other file formats.
- Scheduled or emailed exports.

## Acceptance criteria

### AC1 — Download the current table

- **Given** the reports page shows a table, **When** the user clicks the export button, **Then** a CSV file with the table's rows and columns downloads.
- **Given** the table has no rows, **When** the user clicks the export button, **Then** a CSV file with only the header row downloads.
