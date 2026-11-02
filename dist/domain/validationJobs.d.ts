import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import { type LmcValidationResult, type ValidationRequestError, type ValidationStatus, type LocalMessage } from './validate.js';
import { type Obj } from '../util/coerce.js';
export declare const VALIDATION_JOBS_STATE_KEY = "validationJobs";
export declare const DEFAULT_VALIDATION_DEADLINE_MS: number;
/** JSON-safe, persistence-ready state for one manufacturing validation attempt. */
export interface ValidationJob {
    version: 1;
    id: string;
    payloadSha256: string;
    validatedRevision: number;
    target?: {
        handle: string;
        scope: 'configuration' | 'workspace';
    } | undefined;
    mode: string;
    status: ValidationStatus;
    /** The non-terminal wire status observed before safe normalization, if any. */
    observedStatus?: ValidationStatus | undefined;
    terminal: boolean;
    /** A true value forbids descriptor reuse; submit a new validation instead. */
    freshValidationRequired: boolean;
    descriptors: unknown[];
    startRaw?: unknown;
    resultRaw?: unknown;
    startedAt: number;
    descriptorReceivedAt?: number | undefined;
    resultRequestedAt?: number | undefined;
    resultReceivedAt?: number | undefined;
    completedAt?: number | undefined;
    error?: ValidationRequestError | undefined;
    /** Public, derived diagnostics captured with the validated payload. */
    projection?: ValidationJobProjection | undefined;
}
export interface ValidationJobProjection {
    localDiagnostics: LocalMessage[];
    headroom: Array<{
        configuration: string;
        productCode: string;
        constraints: unknown[];
        breached: string[];
    }>;
    rackDataOmitted: boolean;
    validatedScope: {
        scope: 'configuration' | 'workspace';
        configurations: number;
        racksInSolution: number;
        racksValidated: number;
        covers: string;
    };
}
export interface RunValidationJobOptions {
    validatedRevision: number;
    target?: ValidationJob['target'];
    deadlineMs?: number | undefined;
    now?: (() => number) | undefined;
    /** Persist each snapshot. Called after start, before result, and after result. */
    onUpdate?: ((job: ValidationJob) => void | Promise<void>) | undefined;
}
/** Hashes the exact semantic start body, independent of object key insertion order. */
export declare function validationPayloadSha256(payload: Record<string, unknown>, mode: string): string;
/**
 * Starts and completes one job under one deadline. There is exactly one result
 * request. Non-terminal, failed, timed-out, or interrupted retrievals require
 * a fresh validation because safe retry of a pending descriptor is unproven.
 */
export declare function runValidationJob(http: DcscHttpClient, ctx: RequestCtx, exportPayload: Record<string, unknown>, mode: string, options: RunValidationJobOptions): Promise<ValidationJob>;
/** True when canonical edits or a different export projection supersede a result. */
export declare function isValidationJobStale(job: ValidationJob, revision: number, payloadSha256?: string): boolean;
/** Rehydrates the existing report contract from a persisted job snapshot. */
export declare function validationResultFromJob(job: ValidationJob): LmcValidationResult;
/**
 * Restores persisted jobs. Any non-terminal attempt may have crossed the
 * one-shot result boundary before a crash, so it is made unavailable rather
 * than offered for automatic resume.
 */
export declare function loadValidationJobs(serverState: Obj, now?: number): ValidationJob[];
/** Reads stored jobs without treating an actively running request as interrupted. */
export declare function readValidationJobs(serverState: Obj): ValidationJob[];
/** Returns a cloned workspace-state object with the job upserted and bounded. */
export declare function saveValidationJob(serverState: Obj, job: ValidationJob, maxJobs?: number): Obj;
