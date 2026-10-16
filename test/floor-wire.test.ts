import { expect, it } from 'vitest';
import { buildFloorState } from '../src/domain/floorWire.js';
import type { WorkspaceSession } from '../src/session/SessionStore.js';

it('uses native slim numeric floor nodes while preserving full physical placement metadata', () => {
  const node = { id: 'node', code: '7DD1CTOLWW', sliceCtoCode: '7DD1CTOLWW', type: 'node',
    size: { value: 1, availableSpace: [1] }, occupiedBay: 1, description: 'Node',
    features: [{ name: 'BASE', results: [{ code: 'BWSY', quantity: 1 }] }],
    placementInfo: { sequence: '', spaceConnector: null } };
  const workspace = { serverState: {}, floorItems: [{ id: 'cell', rackId: 'rack', x: 0, y: 0 }],
    rackArea: [{ id: 'rack', type: 'rack', code: '7D6DCTO1WW', size: 42, rackItems: [
      { id: 'chassis', type: 'chassis', code: '7DD0CTOLWW', position: 1, size: 2, nodes: [node] },
    ] }] } as unknown as WorkspaceSession;
  const before = structuredClone(workspace);
  const floor = buildFloorState(workspace);
  const expectedNode = { id: 'node', code: '7DD1CTOLWW', sliceCtoCode: '7DD1CTOLWW', type: 'node',
    size: 1, position: 1, description: 'Node' };
  expect(floor.information.floorGrid).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'rack', items: [expect.objectContaining({ nodes: [expectedNode] })] }),
  ]));
  expect(floor.items[0]).toMatchObject({ rackItem: { items: [{ nodes: [expectedNode] }] } });
  expect(workspace).toEqual(before);
});
