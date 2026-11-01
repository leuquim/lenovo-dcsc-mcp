import assert from 'node:assert/strict';
import { storagePhysicalConfigurations } from '../../src/domain/storagePhysicalState.js';
import type { RawConfiguration } from '../../src/model/types.js';
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const rows = (v: unknown): Obj[] => Array.isArray(v) ? v.map(object) : [];
const key = (value: unknown) => JSON.stringify(value);
function commercial(raw: Obj) {
  const selections = rows(raw['tabs']).flatMap(t => rows(t['subTabs'])).flatMap(t => rows(t['sections']))
    .flatMap(s => rows(s['results']).filter(r => Number(r['quantity']) > 0)
      .map(r => ({ section: s['name'] ?? s['characterName'], code: r['code'], quantity: r['quantity'] })))
    .sort((a, b) => key(a).localeCompare(key(b)));
  return { code: raw['code'], totalPrice: raw['totalPrice'], selections };
}
/** The commercial rows (parts, quantities, prices) per physical instance, as the website imported them and as the MCP saved them. */
export function groupedCommercial(native: Obj, saved: Obj): { native: unknown[]; mcp: unknown[] } {
  const workspace = object(native['workspace']);
  const descend = (items: Obj[], parentCount = 1): Array<{ item: Obj; count: number }> => items.flatMap(item => {
    const count = Array.isArray(item['originalIds']) ? item['originalIds'].length : 1;
    assert.equal(count, Number(item['quantity'] ?? 1) * parentCount,
      'Native physical IDs must match quantity across all parent instances');
    return [{ item, count }, ...descend(rows(item['children']), count)];
  });
  const items = descend([...rows(workspace['nonRackArea']), ...rows(workspace['rackArea'])]);
  const expected = rows(native['configuration']).flatMap(c => {
    const owner = items.find(({ item }) => (item['configurationId'] ?? item['id']) === c['id']);
    assert(owner, 'Native configuration must have physical hierarchy ownership');
    return Array.from({ length: owner.count }, () => commercial(c));
  });
  const physicalWorkspace = { serverState: object(saved['serverState']),
    rackArea: rows(saved['rackArea']), nonRackArea: rows(saved['nonRackArea']) };
  const actual = rows(saved['configurations']).flatMap(c => {
    const raw = object(c['raw']);
    const instances = storagePhysicalConfigurations(physicalWorkspace, String(c['configurationId']), raw as RawConfiguration);
    return instances.length ? instances.map(instance => commercial(instance.raw)) : [commercial(raw)];
  });
  return { native: expected.sort((a, b) => key(a).localeCompare(key(b))), mcp: actual.sort((a, b) => key(a).localeCompare(key(b))) };
}

export function assertGroupedCommercialParity(native: Obj, saved: Obj): void {
  const { native: expected, mcp } = groupedCommercial(native, saved);
  assert.deepEqual(mcp, expected, 'Native/MCP physical product counts, selected parts or prices differ');
}
