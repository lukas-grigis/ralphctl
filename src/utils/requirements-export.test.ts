import { describe, expect, it } from 'vitest';
import { exportRequirementsToMarkdown } from './requirements-export.ts';
import type { Sprint, Ticket } from '@src/schemas/index.ts';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('requirements-export', () => {
  describe('exportRequirementsToMarkdown', () => {
    it('exports sprint with no tickets', async () => {
      const sprint: Sprint = {
        id: '20260101-120000-test',
        name: 'Test Sprint',
        status: 'draft',
        createdAt: '2026-01-01T12:00:00Z',
        activatedAt: null,
        closedAt: null,
        tickets: [],
      };

      const outputPath = join(tmpdir(), `test-requirements-${String(Date.now())}.md`);
      await exportRequirementsToMarkdown(sprint, outputPath);

      const content = await readFile(outputPath, 'utf-8');
      expect(content).toContain('# Sprint Requirements: Test Sprint');
      expect(content).toContain('Sprint ID: 20260101-120000-test');
      expect(content).toContain('Status: draft');
      expect(content).toContain('_No tickets in this sprint._');

      await rm(outputPath);
    });

    it('exports sprint with single ticket', async () => {
      const ticket: Ticket = {
        id: 'abc123',
        title: 'Test Feature',
        projectName: 'test-project',
        requirementStatus: 'approved',
        requirements: '## Problem\nSolve the test problem\n\n## Acceptance Criteria\n- Works',
      };

      const sprint: Sprint = {
        id: '20260101-120000-test',
        name: 'Test Sprint',
        status: 'active',
        createdAt: '2026-01-01T12:00:00Z',
        activatedAt: '2026-01-01T13:00:00Z',
        closedAt: null,
        tickets: [ticket],
      };

      const outputPath = join(tmpdir(), `test-requirements-${String(Date.now())}.md`);
      await exportRequirementsToMarkdown(sprint, outputPath);

      const content = await readFile(outputPath, 'utf-8');
      expect(content).toContain('# Sprint Requirements: Test Sprint');
      expect(content).toContain('## test-project - Test Feature');
      expect(content).toContain('**Ticket ID:** abc123');
      expect(content).toContain('**Status:** approved');
      expect(content).toContain('### Requirements');
      expect(content).toContain('Solve the test problem');
      expect(content).toContain('- Works');

      await rm(outputPath);
    });

    it('exports ticket with link', async () => {
      const ticket: Ticket = {
        id: 'abc123',
        title: 'Test Feature',
        projectName: 'test-project',
        requirementStatus: 'approved',
        requirements: 'Test requirements',
        link: 'https://jira.example.com/JIRA-456',
      };

      const sprint: Sprint = {
        id: '20260101-120000-test',
        name: 'Test Sprint',
        status: 'active',
        createdAt: '2026-01-01T12:00:00Z',
        activatedAt: '2026-01-01T13:00:00Z',
        closedAt: null,
        tickets: [ticket],
      };

      const outputPath = join(tmpdir(), `test-requirements-${String(Date.now())}.md`);
      await exportRequirementsToMarkdown(sprint, outputPath);

      const content = await readFile(outputPath, 'utf-8');
      expect(content).toContain('**Link:** https://jira.example.com/JIRA-456');

      await rm(outputPath);
    });

    it('exports multiple tickets', async () => {
      const tickets: Ticket[] = [
        {
          id: 'abc123',
          title: 'Feature 1',
          projectName: 'proj-a',
          requirementStatus: 'approved',
          requirements: 'Req 1',
        },
        {
          id: 'def456',
          title: 'Feature 2',
          projectName: 'proj-b',
          requirementStatus: 'approved',
          requirements: 'Req 2',
        },
      ];

      const sprint: Sprint = {
        id: '20260101-120000-test',
        name: 'Test Sprint',
        status: 'active',
        createdAt: '2026-01-01T12:00:00Z',
        activatedAt: '2026-01-01T13:00:00Z',
        closedAt: null,
        tickets,
      };

      const outputPath = join(tmpdir(), `test-requirements-${String(Date.now())}.md`);
      await exportRequirementsToMarkdown(sprint, outputPath);

      const content = await readFile(outputPath, 'utf-8');
      expect(content).toContain('## proj-a - Feature 1');
      expect(content).toContain('## proj-b - Feature 2');
      expect(content).toContain('Req 1');
      expect(content).toContain('Req 2');

      await rm(outputPath);
    });

    it('handles ticket with no requirements', async () => {
      const ticket: Ticket = {
        id: 'abc123',
        title: 'Test Feature',
        projectName: 'test-project',
        requirementStatus: 'pending',
      };

      const sprint: Sprint = {
        id: '20260101-120000-test',
        name: 'Test Sprint',
        status: 'draft',
        createdAt: '2026-01-01T12:00:00Z',
        activatedAt: null,
        closedAt: null,
        tickets: [ticket],
      };

      const outputPath = join(tmpdir(), `test-requirements-${String(Date.now())}.md`);
      await exportRequirementsToMarkdown(sprint, outputPath);

      const content = await readFile(outputPath, 'utf-8');
      expect(content).toContain('_No requirements defined_');

      await rm(outputPath);
    });
  });
});
