const DIAGNOSTIC_ARRAYS = {
    expansionMessages: 'info',
    errors: 'error',
    errorMessages: 'error',
    placementError: 'error',
    warnings: 'warning',
    warningMessages: 'warning',
    warn: 'warning',
    notices: 'info',
    serviceValidationMessages: 'error',
};
function str(v) {
    return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}
/** Starts a manufacturing-validation job and retains the exact descriptor array. */
export async function startLmcValidation(http, ctx, exportPayload, mode) {
    const body = { ...exportPayload, mode };
    const res = await http.send({
        endpoint: 'lmc_validation',
        method: 'POST',
        path: '/lmc_validation',
        body: { kind: 'json', value: body },
        responseKind: 'json',
        timeoutClass: 'heavy',
        ctx,
    });
    const descriptors = Array.isArray(res.raw)
        ? res.raw
        : typeof res.raw === 'object' && res.raw !== null
            ? [res.raw]
            : [];
    const entry = descriptors[0];
    const first = (typeof entry === 'object' && entry !== null ? entry : {});
    return {
        buildEntityNumber: str(first['buildEntityNumber']),
        uuid: str(first['uuid']),
        lmcURL: str(first['lmcURL']),
        raw: res.raw,
        descriptors,
    };
}
/** Makes one bounded result request. The caller decides whether a later retry is supported. */
export async function fetchLmcValidationResult(http, ctx, start) {
    if (start.descriptors.length === 0) {
        return {
            ...start,
            status: 'unknown',
            terminal: false,
            isValid: false,
            messages: [],
            requestError: {
                phase: 'start',
                message: 'DCSC returned no manufacturing-validation job descriptors.',
            },
        };
    }
    try {
        const res = await http.send({
            endpoint: 'lmc_validation_result',
            method: 'POST',
            path: '/lmc_validation/result',
            body: { kind: 'json', value: start.descriptors },
            responseKind: 'json',
            timeoutClass: 'heavy',
            ctx,
        });
        return parseLmcValidationResult(start, res.raw);
    }
    catch (err) {
        return {
            ...start,
            status: 'pending',
            terminal: false,
            isValid: false,
            messages: [],
            requestError: requestError('result', err),
        };
    }
}
/** Starts a job and performs exactly one result request. */
export async function runLmcValidation(http, ctx, exportPayload, mode) {
    let start;
    try {
        start = await startLmcValidation(http, ctx, exportPayload, mode);
    }
    catch (err) {
        return {
            raw: undefined,
            descriptors: [],
            status: 'unavailable',
            terminal: false,
            isValid: false,
            messages: [],
            requestError: requestError('start', err),
        };
    }
    return fetchLmcValidationResult(http, ctx, start);
}
export function parseLmcValidationResult(start, raw) {
    const values = Array.isArray(raw) ? raw : [raw];
    const messages = [];
    let finished = false;
    let pending = values.length === 0;
    let timedOut = false;
    let unknownShape = false;
    for (const value of values) {
        if (typeof value !== 'string') {
            unknownShape = true;
            continue;
        }
        const trimmed = value.trim();
        if (/^finish$/i.test(trimmed)) {
            finished = true;
            continue;
        }
        if (/^no data found$/i.test(trimmed)) {
            pending = true;
            continue;
        }
        if (/^time out$/i.test(trimmed)) {
            timedOut = true;
            continue;
        }
        for (const rawLine of value.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (line === '')
                continue;
            messages.push(parseReportLine(line));
        }
    }
    const hasErrors = messages.some((message) => message.severity === 'error');
    const status = hasErrors
        ? 'invalid'
        : timedOut
            ? 'unavailable'
            : finished
                ? 'valid'
                : pending
                    ? 'pending'
                    : 'unknown';
    const finalStatus = unknownShape && (status === 'valid' || status === 'pending') ? 'unknown' : status;
    return {
        ...start,
        status: finalStatus,
        terminal: finalStatus === 'valid' || finalStatus === 'invalid',
        isValid: finalStatus === 'valid',
        messages,
        resultRaw: raw,
        ...(timedOut
            ? {
                requestError: {
                    phase: 'result',
                    message: 'DCSC manufacturing validation timed out.',
                },
            }
            : {}),
    };
}
/**
 * Collects local diagnostics from the configuration tree. This includes the
 * top-level expansionMessages plus nested section, placement and wizard errors.
 */
export function collectLocalDiagnostics(targets) {
    const out = [];
    const seen = new Set();
    for (const target of targets) {
        walkDiagnostics(target.raw, '$', undefined, target.configurationId, out, seen);
    }
    return out;
}
/** Backward-compatible name; now includes all known nested local diagnostics. */
export function collectExpansionMessages(targets) {
    return collectLocalDiagnostics(targets);
}
export function summariseValidation(server, localDiagnostics) {
    const messages = server?.messages ?? [];
    const authoritative = countMessages(messages);
    const local = countMessages(localDiagnostics);
    const status = server?.status ?? 'unavailable';
    return {
        server,
        messages,
        localDiagnostics,
        status,
        ...authoritative,
        localErrorCount: local.errorCount,
        localWarningCount: local.warningCount,
        localInfoCount: local.infoCount,
        isValid: status === 'valid' && local.errorCount === 0,
    };
}
function parseReportLine(line) {
    const matched = /^(ERROR|WARN(?:ING)?|INFO)\s*-\s*(.*)$/i.exec(line);
    if (!matched)
        return { severity: 'error', message: line };
    const label = matched[1]?.toLowerCase();
    const severity = label === 'error' ? 'error' : label?.startsWith('warn') ? 'warning' : 'info';
    return { severity, message: matched[2]?.trim() || line };
}
function walkDiagnostics(value, path, section, configurationId, out, seen) {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => {
            walkDiagnostics(entry, `${path}[${index}]`, section, configurationId, out, seen);
        });
        return;
    }
    if (typeof value !== 'object' || value === null)
        return;
    const obj = value;
    const localSection = path.includes('.sections[') && typeof obj['name'] === 'string' ? obj['name'] : section;
    for (const [key, child] of Object.entries(obj)) {
        const fallback = DIAGNOSTIC_ARRAYS[key];
        if (fallback && Array.isArray(child)) {
            child.forEach((entry, index) => {
                const message = toLocalMessage(entry, fallback, `${path}.${key}[${index}]`, localSection, configurationId);
                if (!message)
                    return;
                const identity = [
                    message.severity,
                    message.code ?? '',
                    message.message,
                    message.section ?? '',
                    message.configurationId ?? '',
                ].join('\u0000');
                if (!seen.has(identity)) {
                    seen.add(identity);
                    out.push(message);
                }
            });
        }
        walkDiagnostics(child, `${path}.${key}`, localSection, configurationId, out, seen);
    }
}
function toLocalMessage(value, fallback, sourcePath, section, configurationId) {
    if (typeof value === 'string') {
        if (value.trim() === '')
            return undefined;
        return { severity: fallback, message: value, section, configurationId, sourcePath };
    }
    if (typeof value !== 'object' || value === null)
        return undefined;
    const obj = value;
    const type = String(obj['severity'] ?? obj['type'] ?? obj['errorType'] ?? '').toLowerCase();
    const severity = type === 'error' || type === 'err' || type.includes('error')
        ? 'error'
        : type === 'warn' || type === 'warning' || type.includes('warn')
            ? 'warning'
            : fallback;
    const message = str(obj['text']) ?? str(obj['message']) ?? str(obj['description']) ?? str(obj['messageKey']);
    if (!message)
        return undefined;
    return {
        severity,
        code: str(obj['code']) ?? str(obj['messageKey']),
        message,
        section: str(obj['sectionName']) ?? str(obj['section']) ?? section,
        configurationId,
        sourcePath,
    };
}
function countMessages(messages) {
    return {
        errorCount: messages.filter((message) => message.severity === 'error').length,
        warningCount: messages.filter((message) => message.severity === 'warning').length,
        infoCount: messages.filter((message) => message.severity === 'info').length,
    };
}
function requestError(phase, err) {
    const obj = (typeof err === 'object' && err !== null ? err : {});
    const userMessage = str(obj['userMessage']);
    const ordinaryMessage = err instanceof Error ? err.message : undefined;
    const status = typeof obj['status'] === 'number' ? obj['status'] : undefined;
    const retryable = typeof obj['retryable'] === 'boolean' ? obj['retryable'] : undefined;
    return {
        phase,
        message: userMessage ?? ordinaryMessage ?? String(err),
        ...(status !== undefined ? { status } : {}),
        ...(retryable !== undefined ? { retryable } : {}),
    };
}
//# sourceMappingURL=validate.js.map