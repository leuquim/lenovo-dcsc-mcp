import { expect, it } from 'vitest';
import { projectJsonPage } from '../src/model/pagedJson.js';
import { readJsonProjection } from '../scripts/lib/read-json-projection.js';

it('reconstructs nested bounded tool pages, long Unicode strings and empty containers', async () => {
  const source = { empty: [], nothing: null, groups: Object.fromEntries(Array.from({ length: 55 }, (_, index) =>
    [`group-${index}`, { nodes: Array.from({ length: 30 }, (_value, node) => ({ id: node, note: 'node'.repeat(100) })),
      label: '🔌'.repeat(700), index }])) };
  let calls = 0;
  const call = async (tool: string, args: Record<string, unknown>) => {
    expect(tool).toBe('inspect');
    calls += 1;
    return projectJsonPage(source, { tool, arguments: {}, path: args.path as string[],
      offset: args.offset as number, limit: args.limit as number });
  };
  expect(await readJsonProjection(call, { tool: 'inspect', arguments: { path: [], offset: 0, limit: 7 } }, 'object'))
    .toEqual(source);
  expect(calls).toBeGreaterThan(55);
});

it('rejects a truncated projection instead of accepting an incomplete restart comparison', async () => {
  await expect(readJsonProjection(async () => ({ total: 2, offset: 0, items: [{ key: '0', value: 'first' }] }),
    { tool: 'inspect', arguments: {} }, 'array')).rejects.toThrow('ended before all values');
});
