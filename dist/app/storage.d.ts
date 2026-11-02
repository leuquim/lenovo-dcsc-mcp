import { type StorageWizardChange } from '../domain/storageWizard.js';
import { type PciWizardChange } from '../domain/pciWizard.js';
import { type StorageNetworkChanges } from '../domain/storagePreferences.js';
import { type PowerControlChanges } from '../domain/powerControls.js';
import { type WorkspaceNetworkSelection } from '../domain/networkPreferences.js';
import { type DetachedStorageComponent } from '../domain/storageComponentLifecycle.js';
import { type StorageNetworkInput } from '../domain/storagePreferences.js';
import { type AcceptedStoragePlacement } from '../domain/storagePlacement.js';
import { type RequestCtx } from '../http/request.js';
import type { Runtime } from './runtime.js';
export declare function inspectStorageWizard(rt: Runtime, handle: string, expectedWorkspaceRevision?: number): {
    session: string;
    workspace: string;
    workspaceRevision: number;
    configurationRevision: number;
    available: boolean;
    affectedConfigurationIds: string[];
    options: import("../util/coerce.js").Obj[];
    errors: {};
    warnings: {};
    notices: {};
};
export declare function setStorageWizard(rt: Runtime, handle: string, change: StorageWizardChange, expectedWorkspaceRevision: number, ctx: RequestCtx): Promise<{
    session: string;
    workspace: string;
    workspaceRevision: number;
    configurationRevision: number;
    available: boolean;
    affectedConfigurationIds: string[];
    options: import("../util/coerce.js").Obj[];
    errors: {};
    warnings: {};
    notices: {};
}>;
export declare function inspectPciWizard(rt: Runtime, handle: string, expectedWorkspaceRevision?: number): {
    session: string;
    workspace: string;
    workspaceRevision: number;
    configurationRevision: number;
    available: boolean;
    affectedConfigurationIds: string[];
    options: import("../util/coerce.js").Obj[];
};
export declare function setPciWizard(rt: Runtime, handle: string, change: PciWizardChange, expectedWorkspaceRevision: number, ctx: RequestCtx): Promise<{
    session: string;
    workspace: string;
    workspaceRevision: number;
    configurationRevision: number;
    available: boolean;
    affectedConfigurationIds: string[];
    options: import("../util/coerce.js").Obj[];
}>;
export declare function inspectWorkspacePowerControls(rt: Runtime, handle: string, expectedWorkspaceRevision?: number): {
    available: boolean;
    current: {
        voltage: string | null;
        loadFactor: number | null;
        powerPolicy: {} | null;
    };
    voltages: {
        id: string;
        voltage: import("../util/coerce.js").Obj;
    }[];
    policies: {
        value: unknown;
        description: unknown;
        key: unknown;
    }[];
    loadFactorRange: {
        min: number;
        max: number;
        step: number;
    };
    workspace: string;
    workspaceRevision: number;
    session: string;
    configurationRevision: number;
    affectedConfigurationIds: string[];
};
/** Mirrors the Engineering Power Report dialog's calculate + Save, in one durable transaction. */
export declare function setPowerControls(rt: Runtime, handle: string, changes: PowerControlChanges, expectedWorkspaceRevision: number, ctx: RequestCtx): Promise<{
    available: boolean;
    current: {
        voltage: string | null;
        loadFactor: number | null;
        powerPolicy: {} | null;
    };
    voltages: {
        id: string;
        voltage: import("../util/coerce.js").Obj;
    }[];
    policies: {
        value: unknown;
        description: unknown;
        key: unknown;
    }[];
    loadFactorRange: {
        min: number;
        max: number;
        step: number;
    };
    workspace: string;
    workspaceRevision: number;
    session: string;
    configurationRevision: number;
    affectedConfigurationIds: string[];
    report: import("../domain/power.js").PowerReport | undefined;
}>;
/** The rack + Storage Network action installs physical instances of managed templates. */
export declare function placeStorageNetwork(rt: Runtime, handle: string, opts: {
    name: string;
    rackId: string;
    expectedRevision?: number | undefined;
    ctx: RequestCtx;
}): Promise<{
    workspace: string;
    revision: number;
    storageName: string;
    placements: AcceptedStoragePlacement[];
    templates: Array<{
        session: string;
        configurationId: string;
        created: boolean;
    }>;
}>;
export declare function openStorageController(rt: Runtime, handle: string, opts: {
    name: string;
    expectedRevision?: number | undefined;
    ctx: RequestCtx;
}): Promise<{
    controllerId: string;
    workspace: string;
    revision: number;
    storageName: string;
    session: string;
    created: boolean;
}>;
export declare function openStorageSwitch(rt: Runtime, handle: string, opts: {
    name: string;
    expectedRevision?: number | undefined;
    ctx: RequestCtx;
}): Promise<{
    switchId: string;
    workspace: string;
    revision: number;
    storageName: string;
    session: string;
    created: boolean;
}>;
/** Applies the website's server-to-storage selection in full workspace context. */
export declare function assignStorageNetwork(rt: Runtime, handle: string, opts: {
    networkName: string | null;
    expectedRevision?: number | undefined;
    autoConnect?: boolean | undefined;
    ctx: RequestCtx;
}): Promise<{
    workspace: string;
    session: string;
    configurationId: string;
    revision: number;
    configurationRevision: number;
    selectedStorageNetwork: string;
    autoConnectRequired: boolean;
    connectionCount?: number;
    connectionGraphStale: boolean;
}>;
export declare function addStorageNetwork(rt: Runtime, handle: string, opts: {
    input: Omit<StorageNetworkInput, 'controllerId'> & {
        controllerId?: string | undefined;
    };
    expectedRevision?: number | undefined;
    ctx: RequestCtx;
}): Promise<{
    workspace: string;
    revision: number;
    storageNetworkCount: number;
}>;
export declare function editStorageNetwork(rt: Runtime, handle: string, opts: {
    action: 'rename' | 'remove';
    name: string;
    newName?: string | undefined;
    clearAssignments?: boolean | undefined;
    expectedRevision?: number | undefined;
}): Promise<{
    workspace: string;
    revision: number;
    storageNetworkCount: number;
    updatedAssignments: number;
    removedConfigurations: number;
}>;
export declare function reconfigureStorageNetwork(rt: Runtime, handle: string, opts: {
    name: string;
    changes: StorageNetworkChanges;
    expectedRevision: number;
    autoConnect?: boolean | undefined;
    ctx: RequestCtx;
}): Promise<{
    workspace: string;
    revision: number;
    storageNetworkCount: number;
    connectionGraphStale: boolean;
    autoConnectRequired: boolean;
    connectionCount?: number;
    retainedComponents: Array<Omit<DetachedStorageComponent, 'physicalIds'> & {
        physicalCount: number;
    }>;
}>;
export declare function setNetworkPreferences(rt: Runtime, handle: string, opts: {
    selections: WorkspaceNetworkSelection[];
    expectedRevision?: number | undefined;
    autoConnect?: boolean | undefined;
    ctx: RequestCtx;
}): Promise<{
    workspace: string;
    revision: number;
    selections: unknown[];
    connectionCount?: number;
    connectionGraphStale: boolean;
    autoConnectRequired: boolean;
}>;
/** The Storage preference panel: definitions, which configurations use them, and hardware left behind by edits. */
export declare function inspectStorageNetworks(rt: Runtime, handle: string, expectedRevision?: number): {
    workspace: string;
    revision: number;
    report: {
        storageNetworks: unknown;
        assignments: {
            session: string;
            configurationId: string;
            storageNetwork: string;
        }[];
        detachedStorageComponents: {};
    };
};
export type StorageDefinitionFields = Omit<StorageNetworkInput, 'name' | 'controllerId'> & {
    controllerId?: string | undefined;
};
export type StorageChange = ({
    action: 'add';
    name: string;
} & StorageDefinitionFields) | {
    action: 'update';
    name: string;
    changes: StorageNetworkChanges;
    autoConnect?: boolean | undefined;
} | {
    action: 'rename';
    name: string;
    newName: string;
} | {
    action: 'remove';
    name: string;
    clearAssignments?: boolean | undefined;
} | {
    action: 'assign';
    networkName: string | null;
    autoConnect?: boolean | undefined;
} | {
    action: 'place';
    name: string;
    rackId: string;
} | {
    action: 'customize';
    name: string;
    component: 'controller' | 'switch';
};
/** Applies one Storage panel change; the result reports the new workspace revision and the action's details. */
export declare function applyStorageChange(rt: Runtime, handle: string, change: StorageChange, expectedRevision: number | undefined, ctx: RequestCtx): Promise<Record<string, unknown>>;
