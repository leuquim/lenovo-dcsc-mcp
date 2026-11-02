import type { ActionHistoryFactory } from '../domain/actionHistory.js';
import type { Catalog } from '../domain/catalog.js';
import type { AggregatedPower, PowerReport } from '../domain/power.js';
import type { RackObject, RackSummary } from '../domain/rack.js';
import { type ReducedConfiguration } from '../domain/reduce.js';
import type { RawConfiguration } from '../model/types.js';
import type { ConfigSession, WorkspaceSession } from '../model/session.js';
import { type SessionStore } from '../session/SessionStore.js';
import type { SolutionContext } from '../config/schema.js';
/** Resolves a configuration handle that belongs to a workspace, or fails with the caller's message. */
export declare function requireConfiguration(sessions: SessionStore, handle: string, message: string): {
    session: ConfigSession;
    workspace: WorkspaceSession;
};
export declare function assertWorkspaceRevision(workspace: WorkspaceSession, expected: number | undefined): void;
export declare function linkedGroup(workspace: WorkspaceSession, configurationId: string): import("../domain/linkedCloneEdit.js").LinkedCloneGroup;
export declare function linkedMembers(workspace: WorkspaceSession, group: {
    memberIds: readonly string[];
}): ConfigSession[];
/** Recomputes the fields derived from `raw` after it was edited. */
export declare function rebuildDerived(session: ConfigSession, owner: {
    solution: SolutionContext;
}): void;
/**
 * Returns a cached uppercased product-code set for a Catalog object so
 * `modesContaining` resolves membership in O(1) per requested code instead of
 * scanning all catalog entries on every call.
 */
export declare function catalogCodeSet(catalog: Catalog): ReadonlySet<string>;
/** Reduces a raw rackArea the same way customizeLayout does, without a round trip. */
export declare function summariseRackArea(rackArea: RackObject[]): RackSummary[];
export declare function addHistoryFactory(configurationId: string): ActionHistoryFactory;
export declare function replicateHistoryFactory(sourceId: string, command: 'COPY' | 'CLONE' | 'UNCLONE', quantity: number, resultId?: string): ActionHistoryFactory;
export declare function updateHistoryFactory(configurationId: string): ActionHistoryFactory;
export declare function moveHistoryFactory(id: string): ActionHistoryFactory;
export declare function removeHistoryFactory(id: string): ActionHistoryFactory;
export declare function networkChangeHistoryFactory(): ActionHistoryFactory;
export declare function storageChangeHistoryFactory(): ActionHistoryFactory;
export declare function configurationControlsHistoryFactory(): ActionHistoryFactory;
export declare function floorMoveHistoryFactory(rackId: string): ActionHistoryFactory;
export declare function rackLockHistoryFactory(target: {
    itemId: string;
} | {
    rackId: string;
    position: number;
}, locked: boolean): ActionHistoryFactory;
/** A part DCSC could not carry across an import, as it reports it. */
export interface ImportPart {
    productCode: string;
    description?: string;
    quantity?: number;
}
export interface ImportDiagnostics {
    /** Parts in the file that DCSC could not resolve at all. */
    missingParts: ImportPart[];
    /** Parts dropped because of rule changes or withdrawal. */
    removedParts: ImportPart[];
    /** Parts DCSC substituted for a successor. */
    replacedParts: ImportPart[];
    /** DCSC flagged one or more parts as export-controlled. Informational. */
    eccnRestricted: boolean;
    warnings?: string[];
}
/** Sizing for a cluster built by replicating one designed node. */
export interface ScaleOutPlan {
    nodeCode: string;
    nodeDescription: string;
    nodeSizeU: number;
    nodeWeightKg: number;
    rackCode: string;
    rackSizeU: number;
    nodes: number;
    /** How many DCSC actually accepted per cabinet, not the arithmetic maximum. */
    nodesPerRack: number;
    racksNeeded: number;
    totalListPrice: number;
    currency: string;
    priceScope: 'configured-nodes-only';
    excludedCosts: string[];
    lastRackNodes: number;
    fullestRackNodes: number;
    lastRackWeightKg: number;
    fullestRackWeightKg: number;
    totalWeightKg: number;
    powerPerNode?: PowerReport;
    clusterPower?: AggregatedPower;
    powerPerRack?: AggregatedPower;
    lastRackPower?: AggregatedPower;
}
export interface ImportResult {
    workspaceId: string;
    sessions: ConfigSession[];
    diagnostics: ImportDiagnostics;
    standaloneKind?: 'software' | 'service' | 'hardware';
}
/** The subset of /multiple/cfxml_import's response that we depend on. */
export interface RawImportResponse extends Record<string, unknown> {
    configuration?: RawConfiguration[] | null;
    missingParts?: unknown;
    removedParts?: unknown;
    differentPartMap?: unknown;
    eccnRestricted?: boolean | null;
}
export declare function toImportParts(value: unknown): ImportPart[];
/**
 * `differentPartMap` is keyed by configuration id and is the only place the
 * import reports substitutions, so replacements are gathered from there.
 */
export declare function collectReplacedParts(value: unknown): ImportPart[];
export declare function prepareConfigurationChanges(session: ConfigSession, changes: Array<{
    section: string;
    code: string;
    quantity: number;
}>): {
    reduced: ReducedConfiguration;
    softwareEdit: boolean;
};
