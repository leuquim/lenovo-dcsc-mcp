import { storagePhysicalTemplateIds } from './storagePreferences.js';
/** The editable template and the server-derived placed product are separate records. */
export function storagePhysicalConfigurations(workspace, templateId, template) {
    const stored = workspace.serverState?.storagePhysicalConfigurations;
    const records = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    return [...storagePhysicalTemplateIds(workspace)].filter(([, root]) => root === templateId)
        .map(([physicalId]) => {
        const value = records[physicalId];
        if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value) ||
            value.id !== templateId)) {
            throw new Error(`Invalid derived storage record for ${physicalId}. Recalculate the physical layout before using its price.`);
        }
        return { physicalId, raw: (value ?? template) };
    });
}
//# sourceMappingURL=storagePhysicalState.js.map