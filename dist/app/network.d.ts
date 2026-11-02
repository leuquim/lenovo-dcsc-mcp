import { type WorkspaceNetworkSelection } from '../domain/networkPreferences.js';
import type { ConfigSession } from '../model/session.js';
import { type Runtime } from './runtime.js';
export declare const NETWORK_COLLECTIONS: readonly ['topologies', 'networkDevices', 'networkTypes', 'cables', 'selectedServices', 'nodeRoles', 'storageSwitches', 'storageControllers', 'leafNodeCabling', 'connectors'];
export type NetworkCollection = typeof NETWORK_COLLECTIONS[number];
export interface NetworkQuery {
    session?: string | undefined;
    solutionMode?: string | undefined;
    collection: NetworkCollection;
    topology?: string | undefined;
    optionId?: string | undefined;
    fields?: string[] | undefined;
    offset: number;
    limit: number;
    path?: string[] | undefined;
    expectedCatalogFingerprint?: string | undefined;
}
export type NetworkChange = {
    kind: 'topology';
    topology: string;
    networkName?: string | undefined;
    connectorIds?: string[] | undefined;
    ports?: string[] | undefined;
    autoConnect?: boolean | undefined;
} | {
    kind: 'nodeRole';
    role: string;
} | {
    kind: 'preferences';
    selections: WorkspaceNetworkSelection[];
    autoConnect?: boolean | undefined;
};
/** The one configuration a handle designates; a workspace handle qualifies only when it holds exactly one. */
export declare function requireSingleConfiguration(rt: Runtime, handle: string): ConfigSession;
export declare function browseNetwork(rt: Runtime, query: NetworkQuery): Promise<Record<string, unknown>>;
/** Applies one Network-tab change and reports the new workspace revision and whether cables need regenerating. */
export declare function setNetwork(rt: Runtime, handle: string, change: NetworkChange, expectedRevision: number | undefined): Promise<Record<string, unknown>>;
