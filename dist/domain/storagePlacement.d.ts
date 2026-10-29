import { type RackConfigurationWire, type RackObject } from './rack.js';
import type { StorageConnectionNetwork } from './storagePreferences.js';
export type StoragePlacementRole = 'controller' | 'mainSwitch';
export interface StoragePlacementComponent {
    role: StoragePlacementRole;
    /** Fresh identity for this physical instance. The managed template keeps its own id. */
    physicalId: string;
    /** Full managed-template configuration, after launch/configuration. */
    configuration: RackObject;
}
export interface StageStorageNetworkPlacementOptions {
    rackArea: RackObject[];
    nonRackArea: RackObject[];
    storageConnectionNetworks: readonly StorageConnectionNetwork[];
    cloneDependency?: unknown;
    rackId: string;
    networkName: string;
    components: StoragePlacementComponent[];
}
export interface StoragePhysicalItem {
    role: StoragePlacementRole;
    templateId: string;
    physicalId: string;
    rackId: string;
    requestedPosition: number;
    raw: RackObject;
    originalId?: string | undefined;
    controllerExpansion?: RackObject | undefined;
}
export interface StagedStorageNetworkPlacement {
    rackArea: RackObject[];
    nonRackArea: RackObject[];
    cloneDependency: Record<string, string[]>;
    /** Only managed template configurations belong in the customize request. */
    wireConfigurations: RackConfigurationWire[];
    templateConfigurationIds: string[];
    physicalItems: StoragePhysicalItem[];
    physicalToTemplate: Record<string, string>;
}
export interface AcceptedStoragePlacement {
    role: StoragePlacementRole;
    templateId: string;
    physicalId: string;
    rackId: string;
    position: number;
    size: number;
    quantity: number;
    raw: RackObject;
    originalId?: string | undefined;
    controllerExpansion?: RackObject | undefined;
}
export interface ResolvedStoragePhysicalAlias {
    physicalId: string;
    templateId: string;
    roles: StoragePlacementRole[];
    networkNames: string[];
    area: 'rack' | 'non-rack';
    rackId?: string | undefined;
    raw: RackObject;
    originalId?: string | undefined;
    controllerExpansion?: RackObject | undefined;
}
/** Managed templates retained outside an active storage definition.
 *
 * The website keeps a configured SAN template and its physical aliases when
 * the definition is changed to Direct Attached. Callers provide these roots
 * separately so they remain managed without being exposed as active networks.
 */
export interface AdditionalStorageManagedTemplate {
    templateId: string;
    code: string;
    type: 'storage' | 'switch';
    roles: StoragePlacementRole[];
    networkNames?: string[] | undefined;
}
/**
 * Stages the browser's `+ Storage Network` rack action.
 *
 * The managed controller/SAN-switch configurations remain templates. Each action creates fresh
 * physical aliases at requested U1, extends cloneDependency from template to physical identity,
 * and lets `/ctos/racks/customize` authoritatively size and arrange them.
 */
export declare function stageStorageNetworkPlacement(options: StageStorageNetworkPlacementOptions): StagedStorageNetworkPlacement;
/** Validates DCSC's accepted layout and reports its authoritative placement metadata. */
export declare function parseStoragePlacementResponse(raw: unknown, staged: StagedStorageNetworkPlacement): AcceptedStoragePlacement[];
/** Resolves physical storage aliases without turning them into independent configurations. */
export declare function resolveStoragePhysicalAliases(options: {
    rackArea: RackObject[];
    nonRackArea: RackObject[];
    storageConnectionNetworks: readonly StorageConnectionNetwork[];
    managedTemplates?: readonly AdditionalStorageManagedTemplate[] | undefined;
    cloneDependency?: unknown;
}): ResolvedStoragePhysicalAlias[];
