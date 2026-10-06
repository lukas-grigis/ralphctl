import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { flattenLeaves, type Element, withDisplay } from '@src/application/chain/element.ts';
import { buildPlanTree, type PlanNode } from '@src/application/chain/plan-tree.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { guard } from '@src/application/chain/build/guard.ts';
import { loop } from '@src/application/chain/build/loop.ts';

type Ctx = Record<string, never>;

const noop = (name: string, opts?: { label?: string; internal?: boolean }): Element<Ctx> =>
  leaf<Ctx, void, void>(name, {
    useCase: { execute: async () => Result.ok(undefined) },
    input: () => undefined,
    output: (c) => c,
    ...opts,
  });

/** A hand-written element: no `kind`, optionally exposing children. */
const handWritten = (name: string, children?: ReadonlyArray<Element<Ctx>>): Element<Ctx> => ({
  name,
  ...(children !== undefined ? { children } : {}),
  execute: async (ctx) => Result.ok({ ctx, trace: [] }),
});

const planLeaves = (node: PlanNode): readonly PlanNode[] =>
  node.children.length === 0 ? [node] : node.children.flatMap(planLeaves);

const tree = (): Element<Ctx> =>
  handWritten('with-lock', [
    sequential<Ctx>('root', [
      noop('load', { label: 'Load', internal: true }),
      sequential<Ctx>(
        'task-1',
        [
          loop<Ctx>(
            'attempts',
            guard<Ctx>('runnable', () => true, sequential<Ctx>('attempt', [noop('generate'), noop('evaluate')])),
            { label: 'Attempt', maxIterations: 3 }
          ),
          handWritten('custom-step'),
        ],
        { label: 'Fix the bug', workItem: { kind: 'task', id: '1' } }
      ),
      loop<Ctx>('uncapped', noop('tick')),
    ]),
  ]);

describe('buildPlanTree', () => {
  it('maps kind, label, internal, workItem and maxIterations from the elements', () => {
    const plan = buildPlanTree(tree());
    const root = plan.children[0]!;
    const [load, task, uncapped] = root.children;

    expect(plan).toMatchObject({ name: 'with-lock', kind: 'sequential', internal: false });
    expect(root).toMatchObject({ name: 'root', kind: 'sequential', internal: false });
    expect(load).toEqual({ name: 'load', label: 'Load', kind: 'leaf', internal: true, children: [] });
    expect(task).toMatchObject({
      name: 'task-1',
      label: 'Fix the bug',
      kind: 'sequential',
      workItem: { kind: 'task', id: '1' },
    });
    const attempts = task!.children[0]!;
    expect(attempts).toMatchObject({ name: 'attempts', kind: 'loop', label: 'Attempt', maxIterations: 3 });
    expect(attempts.children[0]).toMatchObject({ name: 'runnable', kind: 'guard' });
    expect(uncapped).toMatchObject({ name: 'uncapped', kind: 'loop' });
  });

  it('exposes a loop maxIterations only when the caller passed one', () => {
    const uncapped = buildPlanTree(tree()).children[0]!.children[2]!;
    expect('maxIterations' in uncapped).toBe(false);
  });

  it('infers kind for hand-written elements from whether they expose children', () => {
    expect(buildPlanTree(handWritten('opaque')).kind).toBe('leaf');
    expect(buildPlanTree(handWritten('empty', [])).kind).toBe('leaf');
    expect(buildPlanTree(handWritten('wrapper', [noop('inner')])).kind).toBe('sequential');
  });

  it('leaves optional keys absent when the element carries none', () => {
    const node = buildPlanTree(noop('bare'));
    expect(node).toEqual({ name: 'bare', kind: 'leaf', internal: false, children: [] });
  });

  it('has exactly the leaves flattenLeaves yields, in the same order', () => {
    const element = tree();
    expect(planLeaves(buildPlanTree(element)).map((n) => n.name)).toEqual(flattenLeaves(element).map((e) => e.name));
  });
});

describe('withDisplay', () => {
  it('adds a label and work item to a built element, merging its display and keeping execution', async () => {
    const built = sequential<Ctx>('unit', [noop('step')], { internal: true });
    const shown = withDisplay(built, { label: 'Ticket one', workItem: { kind: 'ticket', id: 't1' } });

    expect(buildPlanTree(shown)).toMatchObject({
      name: 'unit',
      kind: 'sequential',
      label: 'Ticket one',
      internal: true,
      workItem: { kind: 'ticket', id: 't1' },
    });
    const run = await shown.execute({});
    expect(run.ok && run.value.trace.map((e) => e.elementName)).toEqual(['step']);
  });
});
