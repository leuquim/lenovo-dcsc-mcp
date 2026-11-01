import type { WorkspaceSession } from '../model/session.js';
import { projectLockedSpaceToSpa } from './rackLocks.js';
import type { Obj } from '../util/coerce.js';


/** The website exports both grid cells and their flattened report representation. */
export function buildFloorState(workspace: WorkspaceSession): { information: Obj; items: Obj[] } {
  const saved = (workspace.serverState.floorInformation ?? {}) as Obj;
  const settings = (saved.floorGridSettings ?? {}) as Obj;
  const existing = Array.isArray(saved.floorGrid) ? structuredClone(saved.floorGrid) as Obj[] : [];
  const explicit = new Map(workspace.floorItems.map((item) => [item.rackId, item]));
  const columns = Math.max(5, Number(settings.colCount) || 0, ...workspace.floorItems.map((item) => item.x + 1));
  const cells = new Map<string, Obj>();
  // Preserve aisle/empty cells and custom metadata; rack cells are refreshed
  // from current physical state so moves and deletions cannot leave stale items.
  for (const cell of existing) if (cell.type !== 'rack') cells.set(`${cell.row}:${cell.col}`, cell);
  for (let index = 0; index < workspace.rackArea.length; index++) {
    const rack = workspace.rackArea[index]!;
    const old = existing.find((cell) => cell.id === rack.id) ?? {};
    const placement = explicit.get(String(rack.id));
    let row = placement?.y ?? (typeof old.row === 'number' ? old.row : Math.floor(index / columns) * 2);
    let col = placement?.x ?? (typeof old.col === 'number' ? old.col : index % columns);
    if (!placement && old.row === undefined) {
      while (cells.get(`${row}:${col}`)?.type === 'rack') {
        col++;
        if (col >= columns) { col = 0; row += 2; }
      }
    }
    const key = `${row}:${col}`;
    if (cells.get(key)?.type === 'rack') throw new Error(`Multiple racks occupy floor cell ${key}.`);
    const physicalItems = Array.isArray(rack.rackItems) ? rack.rackItems as Obj[] : [];
    const items = physicalItems.map((item) => ({
      code: item.code, sliceCtoCode: item.sliceCtoCode ?? item.code, id: item.id,
      position: item.position, size: item.size, type: item.type, color: item.color ?? '#abbb80',
      description: item.description, nodes: Array.isArray(item.nodes) ? (item.nodes as Obj[]).map(node => ({
        code: node.code, sliceCtoCode: node.sliceCtoCode ?? node.code, id: node.id,
        position: node.occupiedBay,
        size: node.size && typeof node.size === 'object' && !Array.isArray(node.size)
          ? (node.size as Obj).value : node.size || 1,
        type: node.type, description: node.description,
      })) : [],
    }));
    cells.set(key, {
      ...old, id: rack.id, sourceId: rack.id, facing: old.facing ?? 'N', adjusted: false,
      uheight: rack.uheight ?? 44.45, type: 'rack', depth: rack.depth,
      color: old.color ?? '#21bbbb', size: rack.size,
      lockedSpace: projectLockedSpaceToSpa(rack.lockedSpace ?? [], Number(rack.size)),
      description: rack.description, sliceCtoCode: rack.sliceCtoCode ?? rack.code,
      items, row, col, coordinate: `${String.fromCharCode(65 + row)}${col + 1}`,
    });
  }
  const rows = Math.max(2, Number(settings.rowCount) || 0,
    ...[...cells.values()].map((cell) => Number(cell.row) + (cell.type === 'rack' ? 2 : 1)));
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const key = `${row}:${col}`;
      if (!cells.has(key)) cells.set(key, {
        key: `floor-${row}-${col}`, type: row % 2 ? 'aisle' : 'empty',
        ...(row % 2 ? { aisle: row % 4 === 1 ? 'H' : 'C' } : {}),
        row, col, coordinate: `${String.fromCharCode(65 + row)}${col + 1}`,
      });
    }
  }
  const grid = [...cells.values()].sort((a, b) => Number(a.row) - Number(b.row) || Number(a.col) - Number(b.col));
  return {
    information: {
      ...saved, floorGrid: grid,
      floorGridSettings: { ...settings, colCount: columns, rowCount: rows,
        hotIndexes: settings.hotIndexes ?? [1], coldIndexes: settings.coldIndexes ?? [3] },
      floorPreference: saved.floorPreference ?? {
        growthRatioHorizontal: 1, growthRatioVertical: 1, rackDist: 0.01, vertDist: 0.5,
        coldDist: 3, hotDist: 2, slackDist: 0, useTrayCabling: false,
      },
      cloneRackMapping: saved.cloneRackMapping ?? {},
    },
    items: grid.map((cell) => ({
      row: cell.row, col: cell.col, aisle: cell.aisle ?? '',
      rackItem: cell.type === 'rack' ? { ...cell, code: '' } : {},
    })),
  };
}
