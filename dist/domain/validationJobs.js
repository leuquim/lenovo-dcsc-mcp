import { createHash } from 'node:crypto';
import { fetchLmcValidationResult, parseLmcValidationResult, lmcValidationBody, startLmcValidation, } from './validate.js';
import { errorMessage, isObject } from '../util/coerce.js';
export const VALIDATION_JOBS_STATE_KEY = 'validationJobs';
export const DEFAULT_VALIDATION_DEADLINE_MS = 5 * 60_000;
/** Hashes the exact semantic start body, independent of object key insertion order. */
export function validationPayloadSha256(payload, mode) {
    return createHash('sha256').update(canonicalJson(lmcValidationBody(payload, mode))).digest('hex');
}
/**
 * Starts and completes one job under one deadline. There is exactly one result
 * request. Non-terminal, failed, timed-out, or interrupted retrievals require
 * a fresh validation because safe retry of a pending descriptor is unproven.
 */
export async function runValidationJob(http, ctx, exportPayload, mode, options) {
    const now = options.now ?? Date.now;
    const startedAt = now();
    let job = {
        version: 1,
        ...(options.target ? { target: structuredClone(options.target) } : {}),
        id: `${options.validatedRevision}:${validationPayloadSha256(exportPayload, mode)}:${startedAt}`,
        payloadSha256: validationPayloadSha256(exportPayload, mode),
        validatedRevision: options.validatedRevision,
        mode,
        status: 'pending',
        terminal: false,
        freshValidationRequired: false,
        descriptors: [],
        startedAt,
    };
    const bounded = deadlineContext(ctx, options.deadlineMs ?? DEFAULT_VALIDATION_DEADLINE_MS);
    const publish = async () => options.onUpdate?.(structuredClone(job));
    try {
        let start;
        try {
            start = await bounded.race(startLmcValidation(http, bounded.ctx, exportPayload, mode));
        }
        catch (error) {
            job = unavailable(job, 'start', error, now(), true);
            await publish();
            return job;
        }
        job = {
            ...job,
            descriptors: structuredClone(start.descriptors),
            startRaw: structuredClone(start.raw),
            descriptorReceivedAt: now(),
        };
        if (start.descriptors.length === 0) {
            job = unavailable(job, 'start', new Error('DCSC returned no manufacturing-validation job descriptors.'), now(), true);
            await publish();
            return job;
        }
        await publish();
        if (bounded.signal.aborted) {
            job = unavailable(job, 'result', abortReason(bounded.signal), now(), true);
            await publish();
            return job;
        }
        // Persist this marker before issuing the one allowed result request. A
        // process loss after this point cannot lead to an accidental replay.
        job = { ...job, resultRequestedAt: now() };
        await publish();
        let result;
        try {
            result = await bounded.race(fetchLmcValidationResult(http, bounded.ctx, start));
        }
        catch (error) {
            job = unavailable(job, 'result', error, now(), true);
            await publish();
            return job;
        }
        job = jobFromResult(job, result, now());
        await publish();
        return job;
    }
    finally {
        bounded.close();
    }
}
/** True when canonical edits or a different export projection supersede a result. */
export function isValidationJobStale(job, revision, payloadSha256) {
    return job.validatedRevision !== revision ||
        (payloadSha256 !== undefined && job.payloadSha256 !== payloadSha256);
}
/** Rehydrates the existing report contract from a persisted job snapshot. */
export function validationResultFromJob(job) {
    const first = isObject(job.descriptors[0]) ? job.descriptors[0] : {};
    const start = {
        buildEntityNumber: nonemptyString(first['buildEntityNumber']),
        uuid: nonemptyString(first['uuid']),
        lmcURL: nonemptyString(first['lmcURL']),
        raw: structuredClone(job.startRaw),
        descriptors: structuredClone(job.descriptors),
    };
    if (job.resultRaw !== undefined) {
        const parsed = parseLmcValidationResult(start, structuredClone(job.resultRaw));
        return {
            ...parsed,
            status: job.status,
            terminal: job.terminal,
            isValid: job.status === 'valid' && job.terminal,
            ...(job.error ? { requestError: structuredClone(job.error) } : {}),
        };
    }
    return {
        ...start,
        status: job.status,
        terminal: job.terminal,
        isValid: false,
        messages: [],
        ...(job.error ? { requestError: structuredClone(job.error) } : {}),
    };
}
/**
 * Restores persisted jobs. Any non-terminal attempt may have crossed the
 * one-shot result boundary before a crash, so it is made unavailable rather
 * than offered for automatic resume.
 */
export function loadValidationJobs(serverState, now = Date.now()) {
    const raw = serverState[VALIDATION_JOBS_STATE_KEY];
    if (!Array.isArray(raw))
        return [];
    const jobs = [];
    for (const value of raw) {
        const parsed = parseJob(value);
        if (!parsed)
            continue;
        jobs.push(parsed.terminal ? parsed : {
            ...parsed,
            status: 'unavailable',
            freshValidationRequired: true,
            completedAt: parsed.completedAt ?? now,
            error: parsed.error ?? {
                phase: parsed.descriptors.length > 0 ? 'result' : 'start',
                message: 'Validation was interrupted; submit a fresh validation.',
            },
        });
    }
    return jobs;
}
/** Reads stored jobs without treating an actively running request as interrupted. */
export function readValidationJobs(serverState) {
    const raw = serverState[VALIDATION_JOBS_STATE_KEY];
    return Array.isArray(raw) ? raw.flatMap(value => {
        const job = parseJob(value);
        return job ? [job] : [];
    }) : [];
}
/** Returns a cloned workspace-state object with the job upserted and bounded. */
export function saveValidationJob(serverState, job, maxJobs = 20) {
    if (!Number.isInteger(maxJobs) || maxJobs < 1)
        throw new Error('maxJobs must be a positive integer.');
    const previous = Array.isArray(serverState[VALIDATION_JOBS_STATE_KEY])
        ? serverState[VALIDATION_JOBS_STATE_KEY].filter((value) => {
            const parsed = parseJob(value);
            return parsed !== undefined && parsed.id !== job.id;
        })
        : [];
    return {
        ...structuredClone(serverState),
        [VALIDATION_JOBS_STATE_KEY]: [...previous, structuredClone(job)].slice(-maxJobs),
    };
}
function jobFromResult(job, result, at) {
    if (result.terminal && (result.status === 'valid' || result.status === 'invalid')) {
        return {
            ...job,
            status: result.status,
            terminal: true,
            freshValidationRequired: false,
            resultRaw: structuredClone(result.resultRaw),
            resultReceivedAt: at,
            completedAt: at,
            ...(result.requestError ? { error: structuredClone(result.requestError) } : {}),
        };
    }
    return {
        ...job,
        status: 'unavailable',
        observedStatus: result.status,
        terminal: false,
        freshValidationRequired: true,
        resultRaw: structuredClone(result.resultRaw),
        resultReceivedAt: at,
        completedAt: at,
        error: result.requestError ?? {
            phase: 'result',
            message: result.status === 'pending'
                ? 'DCSC validation is not complete; safe descriptor retry is unproven. Submit a fresh validation.'
                : 'DCSC returned an unrecognised validation result; submit a fresh validation.',
        },
    };
}
function unavailable(job, phase, error, at, freshValidationRequired) {
    return {
        ...job,
        status: 'unavailable',
        terminal: false,
        freshValidationRequired,
        completedAt: at,
        error: toRequestError(phase, error),
    };
}
function parseJob(value) {
    if (!isObject(value) || value['version'] !== 1 || typeof value['id'] !== 'string' ||
        typeof value['payloadSha256'] !== 'string' || !Number.isInteger(value['validatedRevision']) ||
        typeof value['mode'] !== 'string' || !isStatus(value['status']) ||
        typeof value['terminal'] !== 'boolean' || typeof value['freshValidationRequired'] !== 'boolean' ||
        !Array.isArray(value['descriptors']) || typeof value['startedAt'] !== 'number')
        return undefined;
    return structuredClone(value);
}
function deadlineContext(ctx, deadlineMs) {
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
        throw new Error('Validation deadline must be positive.');
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(ctx.signal?.reason ?? new Error('Validation cancelled.'));
    if (ctx.signal?.aborted)
        abortFromCaller();
    else
        ctx.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`Validation deadline of ${deadlineMs}ms exceeded.`)), deadlineMs);
    const boundedCtx = { ...ctx, signal: controller.signal };
    return {
        ctx: boundedCtx,
        signal: controller.signal,
        race(promise) {
            if (controller.signal.aborted)
                return Promise.reject(abortReason(controller.signal));
            return Promise.race([
                promise,
                new Promise((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(abortReason(controller.signal)), { once: true })),
            ]);
        },
        close() {
            clearTimeout(timer);
            ctx.signal?.removeEventListener('abort', abortFromCaller);
        },
    };
}
function abortReason(signal) {
    return signal.reason instanceof Error ? signal.reason : new Error('Validation cancelled.');
}
function toRequestError(phase, error) {
    const value = isObject(error) ? error : {};
    const message = typeof value['userMessage'] === 'string'
        ? value['userMessage']
        : errorMessage(error);
    return {
        phase,
        message,
        ...(typeof value['status'] === 'number' ? { status: value['status'] } : {}),
        ...(typeof value['retryable'] === 'boolean' ? { retryable: value['retryable'] } : {}),
    };
}
function canonicalJson(value) {
    return JSON.stringify(normalize(value));
}
function normalize(value) {
    if (Array.isArray(value))
        return value.map((entry) => normalize(entry) ?? null);
    if (!isObject(value))
        return value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
        const normalized = normalize(value[key]);
        if (normalized !== undefined)
            out[key] = normalized;
    }
    return out;
}
function isStatus(value) {
    return value === 'pending' || value === 'valid' || value === 'invalid' ||
        value === 'unavailable' || value === 'unknown';
}
function nonemptyString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
//# sourceMappingURL=validationJobs.js.map