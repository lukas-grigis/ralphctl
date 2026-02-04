import { describe, expect, it } from 'vitest';
import { filterProgressByProject } from './progress.ts';

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
