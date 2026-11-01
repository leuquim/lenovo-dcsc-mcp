/** Following the continuation links the paged MCP tools return. */
import assert from 'node:assert/strict';

import type { Json, Mcp } from './mcp.js';

export interface Continuation { tool: string; arguments: Json }

export const object = (value: unknown): Json => {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object.');
  return value as Json;
};
export const array = (value: unknown): unknown[] => {
  assert(Array.isArray(value), 'Expected an array.');
  return value;
};

export function continuation(value: unknown): Continuation {
  const record = object(value);
  assert.equal(typeof record['tool'], 'string');
  return { tool: record['tool'] as string, arguments: object(record['arguments']) };
}

export const optionalContinuation = (value: unknown): Continuation | undefined =>
  value === undefined ? undefined : continuation(value);

/** Calls a continuation, or a tool with arguments, and yields every page by following `next`. */
export async function* pages(mcp: Mcp, start: Continuation): AsyncGenerator<Json> {
  let link: Continuation | undefined = start;
  while (link) {
    const page: Json = await mcp.call(link.tool, link.arguments);
    yield page;
    link = optionalContinuation(page['next']);
  }
}

/** Reads one field of a compacted row through its detail continuation. */
export async function detailField(mcp: Mcp, link: Continuation, key: string): Promise<unknown> {
  const page = await mcp.call(link.tool, link.arguments);
  const field = array(page['items']).map(object).find(item => item['key'] === key);
  assert(field, `${link.tool} detail omitted ${key}.`);
  return field['value'];
}

/** Concatenates the text pages of a long string field. */
export async function readText(mcp: Mcp, start: Continuation): Promise<string> {
  let text = '';
  for await (const page of pages(mcp, start)) text += String(page['text']);
  return text;
}

/** Ids of every row of a paged collection; compacted rows are resolved through their detail continuation. */
export async function enumerateIds(mcp: Mcp, tool: string, args: Json, collection: string, idKey: string) {
  const ids: string[] = [];
  let pageCount = 0;
  let fingerprint: unknown;
  for await (const page of pages(mcp, { tool, arguments: args })) {
    pageCount += 1;
    fingerprint ??= page['catalogFingerprint'];
    for (const raw of array(page[collection])) {
      const item = object(raw);
      const id = typeof item[idKey] === 'string' ? item[idKey] : await detailField(mcp, continuation(item['detail']), idKey);
      ids.push(String(id));
    }
  }
  return { ids, pages: pageCount, fingerprint };
}
