/** Older recovery records have no scope. They cannot establish that only history was lost. */
export function hasUnrepairedRecoveryData(workspace) {
    return (workspace.recoveryData ?? []).some(record => {
        if (typeof record !== 'object' || record === null || Array.isArray(record))
            return true;
        const value = record;
        return value.kind !== 'discarded-history' || typeof value.warning !== 'string' || !('record' in value);
    });
}
export function assertConfigurationReconciliationAllowed(workspace) {
    if (workspace.integrity === 'damaged' || hasUnrepairedRecoveryData(workspace)) {
        throw new Error('Damaged or quarantined configuration/layout state must be repaired or re-imported from complete CFXML before reconciliation. Recovery export preserves the original records; a configuration derive cannot recover missing physical state.');
    }
}
/** Configuration derive does not verify placements, floor plans, cords or connections. */
export function hasPhysicalState(workspace) {
    return workspace.racks.size > 0 || workspace.rackArea.length > 0 ||
        workspace.nonRackArea.length > 0 || workspace.floorItems.length > 0 ||
        workspace.cables.length > 0 || workspace.powerSelections.length > 0;
}
//# sourceMappingURL=workspaceIntegrity.js.map