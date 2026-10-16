import assert from 'node:assert/strict';

type Obj = Record<string, unknown>;
export type ProjectionCall = (name: string, args: Obj) => Promise<Obj>;
interface Continuation { tool: string; arguments: Obj }

/** Reconstruct a lossless tool detail by following both child and page links. */
export async function readJsonProjection(
  call: ProjectionCall, initial: Continuation, type: 'object' | 'array' | 'string',
): Promise<unknown> {
  const values: Record<string, unknown> = {};
  let text = '';
  let next: Continuation | undefined = initial;
  const visited = new Set<string>();
  let expectedTotal: number | undefined;
  while (next) {
    const key = JSON.stringify(next);
    assert(!visited.has(key), 'Projection returned a repeated continuation.');
    visited.add(key);
    const page = await call(next.tool, next.arguments);
    assert.equal(typeof page.total, 'number', 'Projection omitted its total.');
    expectedTotal ??= page.total as number;
    assert.equal(page.total, expectedTotal, 'Projection total changed between pages.');
    if (type === 'string') {
      assert.equal(page.offset, text.length, 'String projection has a gap.');
      assert.equal(typeof page.text, 'string');
      text += page.text;
    } else {
      assert(Array.isArray(page.items), 'Object projection omitted its items.');
      assert.equal(page.offset, Object.keys(values).length, 'Object projection has a gap.');
      for (const entry of page.items as Obj[]) {
        assert.equal(typeof entry.key, 'string');
        const field = entry.key as string;
        assert(!Object.hasOwn(values, field), `Projection repeated ${field}.`);
        if (entry.next) {
          assert(['object', 'array', 'string'].includes(String(entry.type)), 'Unknown child projection type.');
          values[field] = await readJsonProjection(call, entry.next as unknown as Continuation,
            entry.type as 'object' | 'array' | 'string');
        } else {
          assert(Object.hasOwn(entry, 'value'), 'Projection item has no value or continuation.');
          values[field] = entry.value;
        }
      }
    }
    next = page.next as Continuation | undefined;
  }
  assert.equal(type === 'string' ? text.length : Object.keys(values).length, expectedTotal,
    'Projection ended before all values were returned.');
  if (type === 'string') return text;
  if (type === 'array') {
    assert.deepEqual(Object.keys(values), Array.from({ length: expectedTotal! }, (_, index) => String(index)));
    return Object.values(values);
  }
  return values;
}
