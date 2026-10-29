export class RackCapacityIncompleteError extends Error {
    calls;
    requestBudget;
    acceptedLowerBound;
    rejectedUpperBound;
    maxProbeCount;
    constructor(calls, requestBudget, acceptedLowerBound, rejectedUpperBound, maxProbeCount) {
        super(`Rack capacity remains incomplete after ${calls}/${requestBudget} probe requests. ` +
            `DCSC authoritatively accepted at least ${acceptedLowerBound} node(s)` +
            (rejectedUpperBound === undefined
                ? ', but no rejected upper bound was established.'
                : ` and rejected ${rejectedUpperBound} node(s), but the exact boundary was not reached.`) +
            (maxProbeCount !== undefined
                ? ` The safe probe ceiling of ${maxProbeCount} nodes was reached; raise it only when verified physical rack bounds require it.`
                : ' Retry with a larger per-tool request budget;') +
            ' No capacity was guessed.');
        this.calls = calls;
        this.requestBudget = requestBudget;
        this.acceptedLowerBound = acceptedLowerBound;
        this.rejectedUpperBound = rejectedUpperBound;
        this.maxProbeCount = maxProbeCount;
        this.name = 'RackCapacityIncompleteError';
    }
}
/**
 * Finds the exact DCSC-accepted node count using exponential probes followed by
 * binary search when DCSC rejects an oversized request without returning a
 * partial layout. A successful partial layout is already exact evidence: DCSC
 * saw every requested node and returned the subset it could place.
 */
export async function findRackCapacity(options) {
    if (!Number.isFinite(options.physicalSizeU) || options.physicalSizeU <= 0) {
        throw new Error('physicalSizeU must be a positive finite number.');
    }
    if (!Number.isInteger(options.requestBudget) || options.requestBudget < 1) {
        throw new Error('requestBudget must be a positive integer.');
    }
    const maxProbeCount = options.maxProbeCount ?? 128;
    if (!Number.isSafeInteger(maxProbeCount) || maxProbeCount < 1) {
        throw new Error('maxProbeCount must be a positive safe integer.');
    }
    let calls = 0;
    let acceptedLowerBound = 0;
    let acceptedLayout;
    let rejectedUpperBound;
    const probe = async (requestedCount) => {
        if (calls >= options.requestBudget) {
            throw new RackCapacityIncompleteError(calls, options.requestBudget, acceptedLowerBound, rejectedUpperBound);
        }
        calls += 1;
        const result = await options.probe({
            requestedCount,
            physicalSizeU: options.physicalSizeU,
            positionForOrdinal: (ordinal) => {
                if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > requestedCount) {
                    throw new Error(`Probe ordinal must be between 1 and ${requestedCount}.`);
                }
                return 1 + (ordinal - 1) * options.physicalSizeU;
            },
        });
        if (result.kind === 'layout') {
            if (!Number.isInteger(result.acceptedCount) ||
                result.acceptedCount < 0 ||
                result.acceptedCount > requestedCount) {
                throw new Error(`Invalid rack capacity response: DCSC accepted ${result.acceptedCount} of ${requestedCount} requested nodes.`);
            }
            if (result.acceptedCount < acceptedLowerBound) {
                throw new Error(`Inconsistent rack capacity response: DCSC previously accepted ${acceptedLowerBound} node(s) ` +
                    `but a later layout retained only ${result.acceptedCount}.`);
            }
        }
        return result;
    };
    let candidate = 1;
    for (;;) {
        const result = await probe(candidate);
        if (result.kind === 'capacity-rejected') {
            rejectedUpperBound = candidate;
            break;
        }
        if (result.acceptedCount < candidate) {
            return {
                capacity: result.acceptedCount,
                calls,
                physicalSizeU: options.physicalSizeU,
                acceptedLayout: result.layout,
                evidence: 'partial-layout',
            };
        }
        acceptedLowerBound = candidate;
        acceptedLayout = result.layout;
        if (candidate === maxProbeCount) {
            throw new RackCapacityIncompleteError(calls, options.requestBudget, acceptedLowerBound, undefined, maxProbeCount);
        }
        candidate = Math.min(candidate * 2, maxProbeCount);
    }
    while (rejectedUpperBound - acceptedLowerBound > 1) {
        const candidateCount = Math.floor((acceptedLowerBound + rejectedUpperBound) / 2);
        const result = await probe(candidateCount);
        if (result.kind === 'capacity-rejected') {
            rejectedUpperBound = candidateCount;
            continue;
        }
        if (result.acceptedCount < candidateCount) {
            return {
                capacity: result.acceptedCount,
                calls,
                physicalSizeU: options.physicalSizeU,
                acceptedLayout: result.layout,
                evidence: 'partial-layout',
            };
        }
        acceptedLowerBound = candidateCount;
        acceptedLayout = result.layout;
    }
    return {
        capacity: acceptedLowerBound,
        calls,
        physicalSizeU: options.physicalSizeU,
        ...(acceptedLayout !== undefined ? { acceptedLayout } : {}),
        evidence: 'capacity-rejection-bound',
    };
}
//# sourceMappingURL=rackCapacity.js.map