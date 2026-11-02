import { buildAutoDeriveRequest } from './reduce.js';
/** The website appends the SW-scope "OS & Software" tab to the HW tree when the HW response asks for it. */
export function mergeLfoSoftwareTab(hardware, software) {
    if (hardware['needLaunchSwTab'] !== true || !Array.isArray(software.tabs))
        return hardware;
    const tabs = hardware.tabs ?? [];
    return { ...hardware, tabs: hardware['swTabIsAfter'] === false ? [...software.tabs, ...tabs] : [...tabs, ...software.tabs] };
}
/** Captured LFO hardware DTO: the CTO-only configuration fields are rejected. */
export function buildLfoHardwareDeriveRequest(configuration, workspace) {
    const base = buildAutoDeriveRequest(configuration, { validationMode: 'guided', autoCorrect: false });
    delete base.callServiceVarintOnly;
    delete base.statusRelatedResult;
    const fields = [
        'workspaceId', 'products', 'id', 'name', 'showPrice', 'sections', 'autoDerivedResultId',
        'voltage', 'currentPowerPolicy', 'loadFactor', 'solutionMode', 'ctoCode', 'lfoCode',
        'shippingStatus', 'showExpressMode', 'expressModeAvailable', 'showExpressT2Mode',
        'storageWizardOption', 'operationHistories', 'pinnedList', 'delta',
    ];
    base.configurations = [Object.fromEntries(fields
            .filter(key => configuration[key] !== undefined)
            .map(key => [key, structuredClone(configuration[key])]))];
    const source = workspace ? [...workspace.configurations.values()]
        .find(session => session.configurationId === configuration.id)?.raw : undefined;
    base.importInformation = [structuredClone(source?.['importInformation'] ?? null)];
    if (workspace) {
        const physical = buildAutoDeriveRequest(workspace, { validationMode: 'guided', autoCorrect: false });
        for (const key of ['workspaceInformation', 'controllerExpansionMap', 'virtualContainerIdMapping',
            'virtualContainerRule2ConfigMapping', 'virtualContainerInvalidRuleIdMapping']) {
            base[key] = physical[key];
        }
    }
    return base;
}
//# sourceMappingURL=lfoWire.js.map