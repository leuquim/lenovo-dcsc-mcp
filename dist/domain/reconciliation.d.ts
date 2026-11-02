import { type ExportGroupProduct } from './exportGroups.js';
import type { RawConfiguration } from '../model/types.js';
import type { WorkspaceSession } from '../model/session.js';
import { type Obj } from '../util/coerce.js';
export declare const RECONCILIATION_HISTORY_STATE_KEY = "reconciliationHistory";
/** Pending proposals are metadata and must not invalidate their own source hash. */
export declare const RECONCILIATION_PROPOSALS_STATE_KEY = "reconciliationProposals";
export interface FaithfulDerivedConfiguration {
    /** Stable MCP configuration handle, mapped from the returned DCSC id. */
    sessionId: string;
    configurationId: string;
    /** True only after DCSC accepted and returned this complete configuration. */
    accepted: true;
    raw: RawConfiguration;
}
/**
 * Evidence produced by one successful, current workspace derive.
 *
 * The caller computes sourceHash before the HTTP request. This prevents a
 * response produced from one workspace snapshot being reconciled into another.
 */
export interface FaithfulDerivedWorkspace {
    workspaceId: string;
    sourceRevision: number;
    sourceHash: string;
    country: string;
    currency: string;
    solutionMode: string;
    completedAt: number;
    configurations: FaithfulDerivedConfiguration[];
}
export interface SelectionLine {
    path: {
        tabType: string;
        tabTitle: string;
        subTab: string;
        source: string;
        section: string;
        sectionCode: string;
    };
    code: string;
    quantity: number;
    type: string;
    result: Obj;
}
export interface BomSnapshot {
    currency: string;
    products: ExportGroupProduct[];
    /** Full upstream structures retained so normalized products cannot hide loss. */
    associatedSoftware: unknown[];
    associatedServices: unknown[];
}
export interface PricingSnapshot {
    currency: string;
    quantity: number;
    unitPrice: number | null;
    totalPrice: number | null;
    totalPrices: unknown[];
    priceNotAvailable: boolean;
}
export interface ReconciliationComparison<T> {
    changed: boolean;
    before: T;
    after: T;
}
export interface ConfigurationReconciliationDiff {
    sessionId: string;
    configurationId: string;
    productCode: string;
    changed: boolean;
    selections: ReconciliationComparison<SelectionLine[]>;
    bom: ReconciliationComparison<BomSnapshot>;
    pricing: ReconciliationComparison<PricingSnapshot>;
}
export interface ReconciliationWarning {
    code: 'legacy-integrity-warning' | 'missing-edit-intent' | 'omitted-software-field' | 'omitted-service-field' | 'catalog-or-intent-ambiguity' | 'recovery-data-retained';
    message: string;
    sessionId?: string | undefined;
}
interface ReconciliationTarget {
    completedAt: number;
    country: string;
    currency: string;
    solutionMode: string;
    configurations: Array<{
        sessionId: string;
        configurationId: string;
        raw: RawConfiguration;
    }>;
}
export interface ReconciliationProposal {
    version: 1;
    id: string;
    workspaceId: string;
    sourceRevision: number;
    sourceHash: string;
    targetHash: string;
    createdAt: number;
    status: 'no-change' | 'changes-proposed';
    diffs: ConfigurationReconciliationDiff[];
    warnings: ReconciliationWarning[];
    /** Internal complete state. Tool projections should return diffs, not this payload. */
    target: ReconciliationTarget;
}
export interface ReconciliationAcceptance {
    proposalId: string;
    acceptedAt: number;
}
export declare class ReconciliationConflictError extends Error {
    constructor(message: string);
}
/** Hashes the canonical source that must remain unchanged until acceptance. */
export declare function canonicalWorkspaceHash(workspace: WorkspaceSession): string;
/** Builds a read-only, reviewable proposal from an accepted current derive. */
export declare function proposeLegacyReconciliation(workspace: WorkspaceSession, derived: FaithfulDerivedWorkspace, now?: number): ReconciliationProposal;
/**
 * Applies an explicitly accepted proposal to a detached workspace value.
 * SessionStore.transact remains responsible for revision bumps and durability.
 */
export declare function applyReconciliationProposal(workspace: WorkspaceSession, proposal: ReconciliationProposal, acceptance: ReconciliationAcceptance): WorkspaceSession;
export {};
