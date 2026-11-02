/**
 * Floor-grid placement for racks.
 *
 * There is no floor API on DCSC. The SPA keeps the grid entirely client-side
 * (`storeFloorGrid` is a Redux action; `constructFloorGrid` runs in the
 * browser). The 359 mined endpoints contain no `/floor*` path, and probing
 * confirms 404s. Floor coordinates therefore cannot be validated by the
 * server — they are planning state only, the same way the web UI treats them.
 *
 * We still refuse placements that reference a rack DCSC has never seen in
 * this workspace, and we surface an explicit warning so callers do not
 * confuse a local tile with a server-accepted layout.
 */
/** SPA defaults used when building floorPreference for export / auto_connect. */
export const DEFAULT_FLOOR_PREFERENCE = {
    growthRatioHorizontal: 1,
    growthRatioVertical: 1,
    rackDist: 0.01,
    vertDist: 0.5,
    coldDist: 3,
    hotDist: 2,
    slackDist: 0,
    useTrayCabling: false,
};
/**
 * Records a floor placement after checking the rack is in the workspace.
 *
 * Does not invent stability, clearance or aisle rules — the SPA does not
 * ask the server for those either.
 */
export function placeRackOnFloor(opts) {
    const rack = opts.rackArea.find((r) => String(r['id']) === opts.rackId);
    if (!rack) {
        throw new Error(`Rack ${opts.rackId} is not in this workspace. Add one with dcsc_rack_add first.`);
    }
    if (!Number.isInteger(opts.x) || opts.x < 0 || !Number.isInteger(opts.y) || opts.y < 0) {
        throw new Error('Floor coordinates must be non-negative integers (tile indices).');
    }
    const occupant = opts.existing.find((f) => f.rackId !== opts.rackId && f.x === opts.x && f.y === opts.y);
    if (occupant) {
        throw new Error(`Tile (${opts.x}, ${opts.y}) is already occupied by rack ${occupant.rackId}. ` +
            'Move that rack first or pick another tile.');
    }
    const item = {
        id: opts.newId,
        rackId: opts.rackId,
        x: opts.x,
        y: opts.y,
    };
    return {
        item,
        clientSide: true,
        warning: 'Floor placement is client-side planning only — DCSC has no floor-grid endpoint ' +
            'and does not validate tile coordinates. The web UI behaves the same. ' +
            'FLOOR export remains blocked (export endpoint rejects the rack payload shape).',
    };
}
export const FLOOR_PREFERENCE_KEYS = [
    'growthRatioHorizontal', 'growthRatioVertical', 'rackDist', 'vertDist', 'coldDist', 'hotDist', 'slackDist', 'useTrayCabling',
];
/** Applies the Floor Preference modal fields to the stored floor information. */
export function applyFloorPreference(info, change) {
    const preference = { ...DEFAULT_FLOOR_PREFERENCE, ...info['floorPreference'] };
    for (const key of FLOOR_PREFERENCE_KEYS)
        if (change[key] !== undefined)
            preference[key] = change[key];
    const settings = { ...info['floorGridSettings'] };
    if (change.rowCount !== undefined)
        settings['rowCount'] = change.rowCount;
    if (change.colCount !== undefined)
        settings['colCount'] = change.colCount;
    return { ...info, floorPreference: preference, floorGridSettings: settings };
}
/** Workspace Auto Arrange / COG Validation switches override the per-call defaults of every layout request. */
export function layoutToggleOverrides(serverState, forceArrange = false) {
    const flags = (serverState['layoutControls'] ?? {});
    return {
        ...(flags['autoArrange'] === false && !forceArrange ? { autoArrange: false } : {}),
        ...(typeof flags['cogValidation'] === 'boolean' ? { cogValidation: flags['cogValidation'] } : {}),
    };
}
/** Sets the colour of one rack item, as the website's item Color action does; returns undefined when no rack holds the item. */
export function colourRackItem(rackArea, itemId, color) {
    const holdsItem = (rack) => Array.isArray(rack['rackItems']) && rack['rackItems'].some(item => item['id'] === itemId);
    if (!rackArea.some(holdsItem))
        return undefined;
    return rackArea.map(rack => holdsItem(rack)
        ? { ...rack, rackItems: rack['rackItems'].map(item => item['id'] === itemId ? { ...item, color } : item) }
        : rack);
}
//# sourceMappingURL=floor.js.map