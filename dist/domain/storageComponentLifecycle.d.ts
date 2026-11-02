import type { RackObject } from './rack.js';
import { type AdditionalStorageManagedTemplate, type StoragePlacementRole } from './storagePlacement.js';
import type { StorageConnectionNetwork } from './storagePreferences.js';
import { type Obj } from '../util/coerce.js';
export declare const NATIVE_DETACHED_STORAGE_COMMERCIAL_DIFFERENCE: 'website-counts-detached-template';
export interface DetachedStorageComponent extends AdditionalStorageManagedTemplate {
    roles: [StoragePlacementRole];
    physicalIds: string[];
    sourceNetworkName: string;
    reason: 'definition-replaced';
    nativeCommercialDifference: typeof NATIVE_DETACHED_STORAGE_COMMERCIAL_DIFFERENCE;
}
export interface DetachedStorageTransition {
    detachedStorageComponents: DetachedStorageComponent[];
    retained: DetachedStorageComponent[];
}
interface StorageWorkspaceShape {
    serverState?: Obj | undefined;
    rackArea?: RackObject[] | undefined;
    nonRackArea?: RackObject[] | undefined;
}
export declare function detachedStorageComponentSource(state: Obj): unknown;
/** Strict reader used by mutations and identity-sensitive projections. */
export declare function readDetachedStorageComponents(state: Obj): DetachedStorageComponent[];
/** Tolerant identity projection used while exposing a recovery snapshot. */
export declare function detachedStorageTemplateIds(state: Obj): Set<string>;
/**
 * Retains a configured component when a storage definition replaces or clears it.
 *
 * Browser r48 keeps the template configuration, dependency/color root and rack
 * aliases. The native exporter then accidentally charges for the loose template
 * as well as its alias. We record the lifecycle explicitly so MCP projections
 * retain editability but count physical aliases only.
 */
export declare function retainReplacedStorageComponents(options: {
    workspace: StorageWorkspaceShape;
    previousNetworks: readonly StorageConnectionNetwork[];
    nextNetworks: readonly StorageConnectionNetwork[];
    definitionName: string;
}): DetachedStorageTransition;
export {};
