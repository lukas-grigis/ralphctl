import { describe, expect, it } from 'vitest';
import { filterProgressByProject, summarizeProgressForContext } from './progress.ts';

describe('filterProgressByProject', () => {
  it('returns empty string for empty progress', () => {
    expect(filterProgressByProject('', '/frontend')).toBe('');
    expect(filterProgressByProject('  \n  ', '/frontend')).toBe('');
  });

  it('includes entries matching the project path', () => {
    const progress = `## 2024-01-15T10:00:00Z - task-1
<!-- project: /frontend -->

Did some work

---

## 2024-01-15T11:00:00Z - task-2
<!-- project: /backend -->

Other work

---

`;
    const result = filterProgressByProject(progress, '/frontend');
    expect(result).toContain('task-1');
    expect(result).toContain('Did some work');
    expect(result).not.toContain('task-2');
    expect(result).not.toContain('Other work');
  });

  it('includes entries without project marker (legacy/general)', () => {
    const progress = `## 2024-01-15T10:00:00Z

General note without project marker

---

## 2024-01-15T11:00:00Z - task-1
<!-- project: /frontend -->

Frontend work

---

`;
    const result = filterProgressByProject(progress, '/frontend');
    expect(result).toContain('General note');
    expect(result).toContain('Frontend work');
  });

  it('returns empty when no entries match', () => {
    const progress = `## 2024-01-15T10:00:00Z - task-1
<!-- project: /backend -->

Backend only work

---

`;
    const result = filterProgressByProject(progress, '/frontend');
    expect(result).toBe('');
  });

  it('handles project paths with special characters', () => {
    const progress = `## 2024-01-15T10:00:00Z - task-1
<!-- project: /Users/dev/my-app -->

Work done

---

`;
    const result = filterProgressByProject(progress, '/Users/dev/my-app');
    expect(result).toContain('Work done');
  });

  it('includes entries with visible project marker format', () => {
    const progress = `## 2024-01-15T10:00:00Z - task-1

**Project:** /frontend

Did some work

---

## 2024-01-15T11:00:00Z - task-2

**Project:** /backend

Other work

---

`;
    const result = filterProgressByProject(progress, '/frontend');
    expect(result).toContain('task-1');
    expect(result).toContain('Did some work');
    expect(result).not.toContain('task-2');
    expect(result).not.toContain('Other work');
  });

  it('handles mixed legacy HTML and visible format markers', () => {
    const progress = `## 2024-01-15T10:00:00Z - task-1
<!-- project: /frontend -->

Legacy format work

---

## 2024-01-15T11:00:00Z - task-2

**Project:** /frontend

New format work

---

## 2024-01-15T12:00:00Z - task-3

**Project:** /backend

Backend work

---

`;
    const result = filterProgressByProject(progress, '/frontend');
    expect(result).toContain('Legacy format work');
    expect(result).toContain('New format work');
    expect(result).not.toContain('Backend work');
  });
});

describe('summarizeProgressForContext', () => {
  it('returns empty string for empty progress', () => {
    expect(summarizeProgressForContext('', '/frontend')).toBe('');
    expect(summarizeProgressForContext('  \n  ', '/frontend')).toBe('');
  });

  it('extracts only Learnings and Notes sections', () => {
    const progress = `## 2024-01-15T10:00:00Z - a1b2c3d4: Add date filter

**Project:** /frontend

### Steps Completed

- [x] Added DateRangeSchema
- [x] Updated controller

### What Was Implemented

- New Zod schema for date range validation

### Learnings and Context

- All schemas use Zod with .openapi() for auto-docs
- Repository layer uses raw SQL, not an ORM

### Decisions and Rationale

- Chose ISO8601 format for consistency

### Notes for Next Tasks

- ExportRepository now supports optional date filtering
- Future filters can follow the same pattern

---

`;
    const result = summarizeProgressForContext(progress, '/frontend');
    // Should contain learnings
    expect(result).toContain('All schemas use Zod');
    expect(result).toContain('raw SQL');
    // Should contain notes for next tasks
    expect(result).toContain('ExportRepository now supports');
    expect(result).toContain('Future filters');
    // Should NOT contain steps completed or what was implemented
    expect(result).not.toContain('Steps Completed');
    expect(result).not.toContain('What Was Implemented');
    expect(result).not.toContain('Decisions and Rationale');
    // Should contain the entry header
    expect(result).toContain('a1b2c3d4');
  });

  it('limits to maxEntries most recent entries', () => {
    const entries = [];
    for (let i = 1; i <= 5; i++) {
      entries.push(`## 2024-01-${String(15 + i).padStart(2, '0')}T10:00:00Z - task-${String(i)}

**Project:** /frontend

### Learnings and Context

- Learning from task ${String(i)}

### Notes for Next Tasks

- Note from task ${String(i)}

---

`);
    }
    const progress = entries.join('');

    const result = summarizeProgressForContext(progress, '/frontend', 3);
    // Should contain last 3 entries (tasks 3, 4, 5)
    expect(result).toContain('Learning from task 3');
    expect(result).toContain('Learning from task 4');
    expect(result).toContain('Learning from task 5');
    // Should NOT contain first 2 entries
    expect(result).not.toContain('Learning from task 1');
    expect(result).not.toContain('Learning from task 2');
  });

  it('handles entries without learning sections gracefully', () => {
    const progress = `## 2024-01-15T10:00:00Z - task-1

**Project:** /frontend

### Steps Completed

- [x] Did something

### What Was Implemented

- Changed some files

---

## 2024-01-16T10:00:00Z - task-2

**Project:** /frontend

### Learnings and Context

- Important learning here

---

`;
    const result = summarizeProgressForContext(progress, '/frontend');
    // Should skip task-1 (no learnings or notes) and include task-2
    expect(result).toContain('Important learning here');
    expect(result).not.toContain('Did something');
    expect(result).not.toContain('Changed some files');
  });

  it('respects project filtering', () => {
    const progress = `## 2024-01-15T10:00:00Z - task-1

**Project:** /frontend

### Learnings and Context

- Frontend learning

---

## 2024-01-16T10:00:00Z - task-2

**Project:** /backend

### Learnings and Context

- Backend learning

---

`;
    const result = summarizeProgressForContext(progress, '/frontend');
    expect(result).toContain('Frontend learning');
    expect(result).not.toContain('Backend learning');
  });

  it('returns empty when no entries have learnings or notes', () => {
    const progress = `## 2024-01-15T10:00:00Z - task-1

**Project:** /frontend

### Steps Completed

- [x] Did something

---

`;
    const result = summarizeProgressForContext(progress, '/frontend');
    expect(result).toBe('');
  });

  it('handles entries with only notes section (no learnings)', () => {
    const progress = `## 2024-01-15T10:00:00Z - task-1

**Project:** /frontend

### Notes for Next Tasks

- Remember to update the config

---

`;
    const result = summarizeProgressForContext(progress, '/frontend');
    expect(result).toContain('Remember to update the config');
  });

  it('handles entries with only learnings section (no notes)', () => {
    const progress = `## 2024-01-15T10:00:00Z - task-1

**Project:** /frontend

### Learnings and Context

- The API returns paginated results

---

`;
    const result = summarizeProgressForContext(progress, '/frontend');
    expect(result).toContain('The API returns paginated results');
  });

  it('defaults to maxEntries of 3', () => {
    const entries = [];
    for (let i = 1; i <= 5; i++) {
      entries.push(`## 2024-01-${String(15 + i).padStart(2, '0')}T10:00:00Z - task-${String(i)}

**Project:** /frontend

### Learnings and Context

- Learning ${String(i)}

---

`);
    }
    const progress = entries.join('');

    // Default maxEntries = 3
    const result = summarizeProgressForContext(progress, '/frontend');
    expect(result).not.toContain('Learning 1');
    expect(result).not.toContain('Learning 2');
    expect(result).toContain('Learning 3');
    expect(result).toContain('Learning 4');
    expect(result).toContain('Learning 5');
  });
});
