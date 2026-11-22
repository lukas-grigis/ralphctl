# Export the reports table as CSV

## Problem

People using the reports page cannot take the table's data out of the app to work with it elsewhere.

## Outcome

Open question: who does what differently once the table can be exported — whoever requested the ticket

**Signal:** Open question: what would show that change — whoever requested the ticket

## Assumptions

- Open question: do people who open the reports page need its data in another tool — whoever requested the ticket

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
