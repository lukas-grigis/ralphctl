import { describe, expect, it } from 'vitest';
import type { Task } from '@src/domain/entity/task.ts';
import {
  renderContractMd,
  renderTicketRefsSection,
  renderVerificationCriteriaSection,
} from '@src/integration/ai/prompts/_engine/renderers/task.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';

const taskWith = (overrides: Partial<Task>): Task => ({ ...makeTodoTask(), ...overrides }) as Task;

describe('renderVerificationCriteriaSection', () => {
  it('renders one bullet per criterion with id + check tag, embedding the command for auto criteria', () => {
    const task = taskWith({
      verificationCriteria: [
        { id: 'C1', assertion: 'TypeScript compiles', check: 'auto', command: 'npm run typecheck' },
        { id: 'C2', assertion: 'API returns 400 on invalid input', check: 'manual' },
      ],
    });
    const out = renderVerificationCriteriaSection(task);
    expect(out).toContain('## Done criteria');
    expect(out).toContain('- **[C1]** (auto) `npm run typecheck` — TypeScript compiles');
    expect(out).toContain('- **[C2]** (manual) — API returns 400 on invalid input');
  });

  it('returns empty string when criteria array is empty', () => {
    const task = taskWith({ verificationCriteria: [] });
    expect(renderVerificationCriteriaSection(task)).toBe('');
  });
});

describe('renderContractMd', () => {
  it('renders title + description + a per-criterion table with id / check / command / assertion', () => {
    const task = taskWith({
      name: 'add-feature',
      description: 'wire up the new endpoint',
      verificationCriteria: [
        { id: 'C1', assertion: 'TypeScript compiles', check: 'auto', command: 'npm run typecheck' },
        { id: 'C2', assertion: 'API returns 400 on invalid input', check: 'manual' },
      ],
    });
    const md = renderContractMd(task);
    expect(md).toContain('# add-feature');
    expect(md).toContain('## Description');
    expect(md).toContain('wire up the new endpoint');
    expect(md).toContain('## Criteria');
    expect(md).toContain('| id | check | command | assertion |');
    expect(md).toContain('| C1 | auto | `npm run typecheck` | TypeScript compiles |');
    expect(md).toContain('| C2 | manual | — | API returns 400 on invalid input |');
  });

  it('omits the description section when description is undefined', () => {
    // `makeTodoTask()` produces no description, so dropping it via override-without-set is the
    // shape we want — strip explicitly through a manual structural cast.
    const seed = makeTodoTask();
    const { description: _drop, ...rest } = seed;
    void _drop;
    const task = {
      ...rest,
      verificationCriteria: [{ id: 'C1', assertion: 'X', check: 'manual' }],
    } as Task;
    const md = renderContractMd(task);
    expect(md).not.toContain('## Description');
    expect(md).toContain('## Criteria');
  });

  it('falls back to a placeholder line when no criteria are declared', () => {
    const task = taskWith({ verificationCriteria: [] });
    const md = renderContractMd(task);
    expect(md).toContain('## Criteria');
    expect(md).toContain('_No verification criteria declared._');
  });
});

describe('renderTicketRefsSection', () => {
  it('renders a single `Closes <ref>` line for a single-element refs array', () => {
    expect(renderTicketRefsSection(['#123'])).toBe('Closes #123');
  });

  it('renders one `Closes <ref>` line per ref, newline-joined', () => {
    expect(renderTicketRefsSection(['#123', '!456'])).toBe('Closes #123\nCloses !456');
  });

  it('returns the empty string for undefined', () => {
    expect(renderTicketRefsSection(undefined)).toBe('');
  });

  it('returns the empty string for an empty array', () => {
    expect(renderTicketRefsSection([])).toBe('');
  });

  it('dedupes repeated refs (set-style) while preserving first-seen order', () => {
    expect(renderTicketRefsSection(['#123', '#123', '!456', '#123'])).toBe('Closes #123\nCloses !456');
  });

  it('drops whitespace-only entries and trims survivors', () => {
    expect(renderTicketRefsSection(['  #123  ', '', '  ', '\t#999'])).toBe('Closes #123\nCloses #999');
  });

  it('returns empty when every entry is whitespace-only', () => {
    expect(renderTicketRefsSection(['  ', '\t', ''])).toBe('');
  });
});
