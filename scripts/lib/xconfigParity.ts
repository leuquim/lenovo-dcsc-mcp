import assert from 'node:assert/strict';
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const rows = (v: unknown): Obj[] => Array.isArray(v) ? v.map(object) : [];
const sorted = (values: Obj[]) => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const items = (values: unknown) => sorted(rows(values).map(i => ({ code: i['code'], position: i['position'], size: i['size'] })));

export function assertNativeFloorHandoff(native: Obj, saved: Obj): void {
  const codes = new Map(rows(native['configuration']).map(c => [c['id'], c['code']]));
  const actual = sorted(rows(object(native['floorInformation'])['floorGrid']).filter(c => c['type'] === 'rack')
    .map(c => ({ code: codes.get(c['id']), x: c['col'], y: c['row'], items: items(c['items']) })));
  const expected = sorted(rows(saved['floorItems']).map(f => {
    const rack = rows(saved['rackArea']).find(r => r['id'] === f['rackId']);
    assert(rack, 'Saved floor rack must exist');
    return { code: rack['code'], x: f['x'], y: f['y'], items: items(rack['rackItems']) };
  }));
  assert.deepEqual(actual, expected, 'Native reimport changed the physical floor/rack layout');
}
