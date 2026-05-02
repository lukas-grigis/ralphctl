/**
 * JSON schema string the AI is told to write its refined-requirements
 * output against. Returned as a stringified JSON Schema (Draft 7-ish)
 * so it drops cleanly into the `{{SCHEMA}}` placeholder in
 * `ticket-refine.md`.
 *
 * Kept as a hand-authored constant rather than derived from a Zod
 * schema because:
 *  - we don't import Zod in business/ on principle (no runtime deps);
 *  - the prompt schema is not the same shape as the persistence schema
 *    (the AI writes a per-ticket array; we store a single ticket entity);
 *  - regenerating from Zod adds noise to the schema (defaults, refinements)
 *    that distracts the AI without changing what it should produce.
 *
 * If this drifts from `Ticket.approveRequirements` or the parser in
 * `refine-single-ticket.ts`, the integration tests will catch it.
 */
export const REFINED_REQUIREMENTS_JSON_SCHEMA = JSON.stringify(
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'RefinedRequirements',
    description: 'Per-ticket refinement output written by the refine AI session',
    type: 'array',
    items: {
      type: 'object',
      required: ['ref', 'requirements'],
      properties: {
        ref: {
          type: 'string',
          minLength: 1,
          description: 'Either the ticket id or its exact title — used to match the array entry to a ticket',
        },
        requirements: {
          type: 'string',
          minLength: 1,
          description:
            'Markdown body — Problem / Requirements / Acceptance Criteria / Scope / Constraints sections. Multi-topic tickets use numbered headings ("# 1. Topic", "# 2. Topic", …) separated by `---`.',
        },
      },
    },
  },
  null,
  2
);
