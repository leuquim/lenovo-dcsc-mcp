import { type AutoFixCandidate, type AutoFixResult } from '../domain/autoFix.js';
import { type ValidationReport } from '../domain/validate.js';
import { type VerifyMandatorySoftwareResult } from '../domain/mandatorySoftware.js';
import { type RequestCtx } from '../http/request.js';
import type { ConfigSession } from '../model/session.js';
import type { Runtime } from './runtime.js';
/**
 * Discovers candidate hardware sections eligible for auto-fix on a CTO configuration.
 */
export declare function inspectAutoFix(rt: Runtime, handle: string, ctx?: RequestCtx): Promise<{
    candidates: AutoFixCandidate[];
}>;
/**
 * Automatically resolves rule validation errors for eligible hardware CTO sections.
 * Runs as a transactional mutation with CAS optimistic concurrency.
 */
export declare function autoFix(rt: Runtime, handle: string, opts?: {
    sections?: string[] | undefined;
    expectedRevision?: number | undefined;
    ctx?: RequestCtx | undefined;
}): Promise<{
    session: ConfigSession;
    result: AutoFixResult;
}>;
type ValidationScope = 'configuration' | 'workspace';
export type ValidationOutcome = ValidationReport & {
    jobId: string;
    payloadSha256: string;
    freshValidationRequired: boolean;
    sessionHandle: string;
    validatedRevision: number;
    stale: boolean;
    workspaceId?: string | undefined;
    headroom: Array<{
        configuration: string;
        productCode: string;
        constraints: unknown[];
        breached: string[];
    }>;
    source: 'lmc_validation';
    /** True when racks were present but omitted from the LMC payload (same gap as export). */
    rackDataOmitted: boolean;
    /** What the isValid verdict actually covers. Never claims more than was sent. */
    validatedScope: {
        scope: ValidationScope;
        configurations: number;
        racksInSolution: number;
        racksValidated: number;
        covers: string;
    };
    warning?: string | undefined;
};
/**
 * Validates a configuration against DCSC's LMC validation endpoint.
 *
 * The SPA posts the export payload to /lmc_validation and receives a
 * manufacturing handoff (build entity + deep link). Local expansionMessages
 * from autoDerive are merged in so callers still see rule text that is
 * already on the tree.
 */
export declare function validate(rt: Runtime, sessionHandle: string, ctx: RequestCtx, opts?: {
    deadlineMs?: number | undefined;
}): Promise<ValidationOutcome>;
/** Saved reports are inspectable without making another result request. */
export declare function validationJobs(rt: Runtime, handle: string): {
    version: 1;
    id: string;
    payloadSha256: string;
    validatedRevision: number;
    target?: {
        handle: string;
        scope: 'configuration' | 'workspace';
    } | undefined;
    mode: string;
    status: import("../domain/validate.js").ValidationStatus;
    observedStatus?: import("../domain/validate.js").ValidationStatus | undefined;
    terminal: boolean;
    descriptors: unknown[];
    startRaw?: unknown;
    resultRaw?: unknown;
    startedAt: number;
    descriptorReceivedAt?: number | undefined;
    resultRequestedAt?: number | undefined;
    resultReceivedAt?: number | undefined;
    completedAt?: number | undefined;
    error?: import("../domain/validate.js").ValidationRequestError | undefined;
    projection?: import("../domain/validationJobs.js").ValidationJobProjection | undefined;
    stale: boolean;
    isValid: boolean;
    currentStatus: import("../domain/validate.js").ValidationStatus;
    freshValidationRequired: boolean;
    scopeWarning?: string;
    report: import("../domain/validate.js").LmcValidationResult;
}[];
export declare function diffSessions(rt: Runtime, sessionHandleA: string, sessionHandleB: string): {
    added: import("../model/diff.js").PartChange[];
    removed: import("../model/diff.js").PartChange[];
    replaced: import("../model/diff.js").Replacement[];
    quantityChanged: import("../model/diff.js").PartChange[];
    price: {
        before: number | null;
        after: number | null;
        delta: number | null;
        currency: string;
    };
    constraints: import("../model/project.js").Constraint[];
    autoChanges: number;
    sessionA: string;
    sessionB: string;
    productA: {
        code: string;
        description: string;
        type: string;
    };
    productB: {
        code: string;
        description: string;
        type: string;
    };
    currency: string;
};
/** Checks the mandatory OS/hypervisor selections of one configuration, as the website does before Summary. */
export declare function verifyMandatorySoftware(rt: Runtime, handle: string, ctx: RequestCtx): Promise<VerifyMandatorySoftwareResult>;
/** Saved validation jobs of a workspace, or one job's recorded report, as paged JSON. */
export declare function inspectValidationJobs(rt: Runtime, opts: {
    session: string;
    jobId?: string | undefined;
    path: string[];
    offset: number;
    limit: number;
}): Record<string, unknown>;
export {};
