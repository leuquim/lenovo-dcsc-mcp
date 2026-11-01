import { expect, it } from 'vitest';
import { applyFloorPreference } from '../src/domain/floor.js';
import { buildFloorState } from '../src/domain/floorWire.js';
import type { WorkspaceSession } from '../src/model/session.js';

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

it('produces the FloorInformation the website exports after Row +, rack distance 0.5, cold aisle 4 and tray cabling', () => {
  const workspace = { serverState: {}, floorItems: [], rackArea: [{ id: 'rack', type: 'rack', code: '7D6DCTO1WW', size: 42, rackItems: [] }],
  } as unknown as WorkspaceSession;
  const edited = applyFloorPreference({}, { rowCount: 4, rackDist: 0.5, coldDist: 4, useTrayCabling: true });
  const { information } = buildFloorState({ ...workspace, serverState: { floorInformation: edited } } as unknown as WorkspaceSession);
  expect(information.floorGridSettings).toEqual({ colCount: 5, rowCount: 4, hotIndexes: [1], coldIndexes: [3] });
  expect(information.floorPreference).toEqual({ growthRatioHorizontal: 1, growthRatioVertical: 1, rackDist: 0.5, vertDist: 0.5,
    coldDist: 4, hotDist: 2, slackDist: 0, useTrayCabling: true });
  const grid = information.floorGrid as Array<{ row: number; aisle?: string }>;
  expect(grid).toHaveLength(20);
  expect(grid.find(cell => cell.row === 3)?.aisle).toBe('C');
});
