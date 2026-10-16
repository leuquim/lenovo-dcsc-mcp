import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { assertAcceptedNestedEdit, stageConfiguredNodeCopy } from '../src/domain/nestedPhysical.js';
import type { RackObject } from '../src/domain/rack.js';

type Obj = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/parity/nested-node-copy.json', import.meta.url), 'utf8',
)) as Obj;

function options() {
  return {
    rackArea: structuredClone(fixture['rackArea'] as RackObject[]),
    nonRackArea: structuredClone(fixture['nonRackArea'] as RackObject[]),
    chassisId: 'chassis-1', sourceNodeId: 'node-source', copyId: String(fixture['copyId']),
  };
}

describe('browser-authoritative configured node copy into chassis', () => {
  it('accepts corrected physical metadata but rejects a node moved into the wrong child collection', () => {
    const expected = stageConfiguredNodeCopy(options());
    const accepted = structuredClone(expected);
    const chassis = (accepted.rackArea[0]!.rackItems as RackObject[])[0]!;
    chassis.position = 3;
    chassis.filler = { code: 'BWJQ', size: 3 };
    expect(() => assertAcceptedNestedEdit(expected, accepted)).not.toThrow();
    chassis.rackItems = chassis.nodes;
    chassis.nodes = [];
    expect(() => assertAcceptedNestedEdit(expected, accepted)).toThrow(/containment/);
  });

  it('keeps the configured source and stages one metadata-complete nested physical copy', () => {
    const input = options();
    const before = structuredClone(input);
    const staged = stageConfiguredNodeCopy(input);
    const chassis = (staged.rackArea[0]!['rackItems'] as Obj[])[0]!;
    const copy = (chassis['nodes'] as Obj[])[0]!;

    expect(staged.placement).toEqual({
      rackId: 'rack-1', chassisId: 'chassis-1', nodeId: 'node-copy', occupiedBay: 1,
    });
    expect(staged.configurationIdMapping).toEqual({ 'node-copy': 'node-source' });
    expect(staged.nonRackArea).toEqual(before.nonRackArea);
    expect(copy).toEqual({ ...(before.nonRackArea[0] as Obj), id: 'node-copy' });
    expect(copy).not.toHaveProperty('configurationId');
    expect(copy['opaqueNode']).toEqual({ retained: true });
    expect(input).toEqual(before);
  });

  it('rejects identity ambiguity, unsupported sources, and non-chassis targets', () => {
    const collision = options();
    collision.copyId = 'rack-1';
    expect(() => stageConfiguredNodeCopy(collision)).toThrow(/already exists/);

    const missing = options();
    missing.sourceNodeId = 'missing';
    expect(() => stageConfiguredNodeCopy(missing)).toThrow(/not one unique non-rack item/);

    const wrongSource = options();
    wrongSource.nonRackArea[0]!['type'] = 'server';
    expect(() => stageConfiguredNodeCopy(wrongSource)).toThrow(/not a node/);

    const wrongTarget = options();
    ((wrongTarget.rackArea[0]!['rackItems'] as Obj[])[0]!)['type'] = 'server';
    expect(() => stageConfiguredNodeCopy(wrongTarget)).toThrow(/not a chassis/);
  });

  it('requires captured capacity metadata and refuses over-capacity staging', () => {
    const noCapacity = options();
    delete ((noCapacity.rackArea[0]!['rackItems'] as Obj[])[0]!)['capacity'];
    expect(() => stageConfiguredNodeCopy(noCapacity)).toThrow(/no authoritative capacity/);

    const full = options();
    const chassis = (full.rackArea[0]!['rackItems'] as Obj[])[0]!;
    chassis['capacity'] = 1;
    chassis['nodes'] = [{ id: 'existing', type: 'node', occupiedBay: 1 }];
    expect(() => stageConfiguredNodeCopy(full)).toThrow(/exceeds chassis.*capacity/);
  });

  it('does not infer occupied bays or accept a nested source hierarchy', () => {
    const noBay = options();
    delete noBay.nonRackArea[0]!['occupiedBay'];
    expect(() => stageConfiguredNodeCopy(noBay)).toThrow(/no authoritative occupiedBay/);

    const nested = options();
    nested.nonRackArea[0]!['children'] = [{ id: 'unexpected' }];
    expect(() => stageConfiguredNodeCopy(nested)).toThrow(/unsupported child hierarchy/);
  });
});
