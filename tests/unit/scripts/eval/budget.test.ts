import { describe, expect, it } from 'vitest';
import { createBudget } from '../../../../scripts/eval/budget.ts';

const CONFIG = { maxTokens: 10_000, reserveTokens: 0, allowUnmetered: false } as const;

describe('createBudget', () => {
  it('admits the very first trial with the default zero reserve', () => {
    expect(createBudget(CONFIG, 0).admit('evaluate', 0)).toEqual({ admitted: true });
  });

  it('reserves the largest cost seen for the flow before admitting the next trial', () => {
    const budget = createBudget(CONFIG, 0);
    budget.record('evaluate', { inputTokens: 4000, outputTokens: 1000 });
    expect(budget.admit('evaluate', 0)).toEqual({ admitted: true }); // 5000 + 5000 ≤ 10000
    budget.record('evaluate', { inputTokens: 1000, outputTokens: 500 });
    expect(budget.admit('evaluate', 0)).toEqual({ admitted: false, reason: 'budget' }); // 6500 + 5000 > 10000
  });

  it('counts cache read and cache creation tokens toward admission and the snapshot', () => {
    const budget = createBudget(CONFIG, 0);
    budget.record('evaluate', { inputTokens: 10, outputTokens: 500, cacheReadTokens: 6000, cacheCreationTokens: 1500 });
    expect(budget.snapshot(0)).toMatchObject({ inputTokens: 10, cacheReadTokens: 6000, cacheCreationTokens: 1500 });
    // spent 8010, reserve 8010 (the whole trial, cache included) > 10000
    expect(budget.admit('evaluate', 0)).toEqual({ admitted: false, reason: 'budget' });
  });

  it('keeps the reserve per flow: a cheap flow is still admitted when an expensive one is not', () => {
    const budget = createBudget(CONFIG, 0);
    budget.record('implement', { inputTokens: 6000, outputTokens: 1000 });
    budget.record('detect-scripts', { inputTokens: 300, outputTokens: 100 });
    expect(budget.admit('implement', 0)).toEqual({ admitted: false, reason: 'budget' });
    expect(budget.admit('detect-scripts', 0)).toEqual({ admitted: true });
  });

  it('uses reserveTokens for a flow with no observation yet', () => {
    const budget = createBudget({ ...CONFIG, reserveTokens: 20_000 }, 0);
    expect(budget.admit('evaluate', 0)).toEqual({ admitted: false, reason: 'budget' });
  });

  it('stops on the wall-clock cap', () => {
    const budget = createBudget({ ...CONFIG, maxWallMs: 1000 }, 100);
    expect(budget.admit('evaluate', 1099)).toEqual({ admitted: true });
    expect(budget.admit('evaluate', 1100)).toEqual({ admitted: false, reason: 'wall' });
  });

  it('fails closed on an unmetered trial, and never imputes its missing counts', () => {
    const budget = createBudget(CONFIG, 0);
    budget.record('evaluate', {});
    expect(budget.admit('evaluate', 0)).toEqual({ admitted: false, reason: 'unmetered' });
    expect(budget.snapshot(0)).toMatchObject({ inputTokens: 0, outputTokens: 0, unmeteredTrials: 1 });
  });

  it('counts a half-reported trial as unmetered while keeping the reported part', () => {
    const budget = createBudget(CONFIG, 0);
    budget.record('evaluate', { inputTokens: 700 });
    expect(budget.snapshot(0)).toMatchObject({ inputTokens: 700, unmeteredTrials: 1 });
  });

  it('treats an explicit metered:false trial as unmetered even when both sums are present', () => {
    const budget = createBudget(CONFIG, 0);
    budget.record('evaluate', { inputTokens: 1, outputTokens: 1, metered: false });
    expect(budget.admit('evaluate', 0)).toEqual({ admitted: false, reason: 'unmetered' });
  });

  it('keeps going past unmetered trials when allowed', () => {
    const budget = createBudget({ ...CONFIG, allowUnmetered: true }, 0);
    budget.record('evaluate', {});
    expect(budget.admit('evaluate', 0)).toEqual({ admitted: true });
    expect(budget.snapshot(50)).toMatchObject({ unmeteredTrials: 1, wallMs: 50 });
  });
});
