import { z } from 'zod';
import { verifyMandatorySoftware } from '../app/validation.js';
import { guard } from './toolSupport.js';
import { objectOrEmpty } from '../util/coerce.js';
import { PAGE_BYTE_BUDGET } from '../config/constants.js';
import { jsonBytes } from '../util/jsonBytes.js';
function clipText(value, limit) {
    const characters = [...value];
    return characters.length <= limit
        ? { value, truncated: false }
        : { value: `${characters.slice(0, limit).join('')}…`, truncated: true };
}
function messagePreview(value) {
    const source = objectOrEmpty(value);
    const message = typeof source['message'] === 'string' ? source.message : '';
    const clip = (candidate, limit) => {
        if (typeof candidate !== 'string')
            return candidate;
        return clipText(candidate, limit).value;
    };
    const clippedMessage = clipText(message, 280);
    return {
        ...Object.fromEntries(['severity', 'code', 'section', 'configurationId', 'sourcePath']
            .filter(key => source[key] !== undefined).map(key => [key, clip(source[key], 160)])),
        message: clippedMessage.value,
        ...(clippedMessage.truncated ? { messageTruncated: true } : {}),
    };
}
/** Keeps ordinary validation results intact and makes oversized reports losslessly navigable. */
export function projectValidationToolResult(full, options) {
    const maxBytes = options.maxBytes ?? PAGE_BYTE_BUDGET;
    if (jsonBytes(full) <= Math.min(PAGE_BYTE_BUDGET, maxBytes))
        return full;
    const messages = Array.isArray(full['messages']) ? full.messages : [];
    const localDiagnostics = Array.isArray(full['localDiagnostics']) ? full.localDiagnostics : [];
    const headroom = Array.isArray(full['headroom']) ? full.headroom : [];
    const inspect = (path) => ({
        tool: 'dcsc_workspace_get',
        arguments: { session: options.session, view: 'validation', jobId: options.jobId, path, offset: 0, limit: 20 },
    });
    const pages = {
        savedJob: { inspect: inspect([]) },
        messages: { total: messages.length, inspect: inspect(['report', 'messages']) },
        localDiagnostics: { total: localDiagnostics.length, inspect: inspect(['projection', 'localDiagnostics']) },
        headroom: { total: headroom.length, inspect: inspect(['projection', 'headroom']) },
    };
    const headroomSummary = headroom.slice(0, 3).map(value => {
        const entry = objectOrEmpty(value);
        return {
            configuration: entry['configuration'],
            productCode: entry['productCode'],
            constraintCount: Array.isArray(entry['constraints']) ? entry.constraints.length : 0,
            breached: Array.isArray(entry['breached']) ? entry.breached : [],
        };
    });
    const { messages: _messages, localDiagnostics: _localDiagnostics, headroom: _headroom, warning, lmc: rawLmc, ...base } = full;
    const lmc = objectOrEmpty(rawLmc);
    const compactLmc = {};
    const lmcPages = {};
    for (const key of ['buildEntityNumber', 'uuid', 'lmcURL']) {
        const value = lmc[key];
        if (typeof value !== 'string')
            continue;
        const clipped = clipText(value, 240);
        compactLmc[key] = clipped.value;
        if (clipped.truncated) {
            compactLmc[`${key}Truncated`] = true;
            lmcPages[key] = { total: [...value].length, inspect: inspect(['report', key]) };
        }
    }
    if (Object.keys(lmcPages).length > 0)
        pages['lmc'] = lmcPages;
    const warningCharacters = typeof warning === 'string' ? [...warning] : [];
    const warningTruncated = warningCharacters.length > 500;
    const persistedWarning = warningTruncated ? `${warningCharacters.slice(0, 500).join('')}…` : warning;
    const compact = {
        ...base,
        ...(Object.keys(compactLmc).length > 0 ? { lmc: compactLmc } : {}),
        ...(persistedWarning !== undefined ? { warning: persistedWarning } : {}),
        ...(warningTruncated ? { warningTruncated: true } : {}),
        messages: messages.slice(0, 3).map(messagePreview),
        messagesReturned: Math.min(messages.length, 3),
        localDiagnostics: localDiagnostics.slice(0, 3).map(messagePreview),
        localDiagnosticsReturned: Math.min(localDiagnostics.length, 3),
        headroom: headroomSummary,
        headroomReturned: Math.min(headroom.length, 3),
        compacted: true,
        pages,
    };
    if (warningTruncated) {
        pages['warning'] = {
            total: warningCharacters.length,
            inspect: inspect(['error', 'message']),
        };
    }
    while (jsonBytes(compact) > maxBytes && compact['messages'].length > 0) {
        compact['messages'].pop();
        compact['messagesReturned'] = compact['messages'].length;
    }
    while (jsonBytes(compact) > maxBytes && compact['localDiagnostics'].length > 0) {
        compact['localDiagnostics'].pop();
        compact['localDiagnosticsReturned'] = compact['localDiagnostics'].length;
    }
    if (jsonBytes(compact) > maxBytes) {
        compact['headroom'] = headroomSummary.map(entry => ({
            configuration: entry.configuration,
            productCode: entry.productCode,
            constraintCount: entry.constraintCount,
            breachedCount: entry.breached.length,
        }));
    }
    while (jsonBytes(compact) > maxBytes && compact['headroom'].length > 0) {
        compact['headroom'].pop();
        compact['headroomReturned'] = compact['headroom'].length;
    }
    if (jsonBytes(compact) > maxBytes) {
        const keep = (key) => {
            const value = full[key];
            return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
                ? value
                : undefined;
        };
        const fallback = {
            session: keep('session'),
            workspaceId: keep('workspaceId'),
            source: keep('source'),
            status: keep('status'),
            isValid: keep('isValid'),
            terminal: keep('terminal'),
            jobId: options.jobId,
            payloadSha256: keep('payloadSha256'),
            validatedRevision: keep('validatedRevision'),
            stale: keep('stale'),
            freshValidationRequired: keep('freshValidationRequired'),
            errorCount: keep('errorCount'),
            warningCount: keep('warningCount'),
            infoCount: keep('infoCount'),
            localErrorCount: keep('localErrorCount'),
            localWarningCount: keep('localWarningCount'),
            localInfoCount: keep('localInfoCount'),
            compacted: true,
            contextOmitted: true,
            inspectSavedJob: inspect([]),
            ...(persistedWarning !== undefined ? { warning: persistedWarning } : {}),
            ...(warningTruncated ? {
                warningTruncated: true,
                warningInspect: inspect(['error', 'message']),
            } : {}),
        };
        if (jsonBytes(fallback) <= maxBytes)
            return fallback;
        return {
            status: keep('status'),
            isValid: keep('isValid'),
            terminal: keep('terminal'),
            jobId: options.jobId,
            stale: keep('stale'),
            freshValidationRequired: keep('freshValidationRequired'),
            errorCount: keep('errorCount'),
            warningCount: keep('warningCount'),
            infoCount: keep('infoCount'),
            localErrorCount: keep('localErrorCount'),
            localWarningCount: keep('localWarningCount'),
            localInfoCount: keep('localInfoCount'),
            compacted: true,
            contextOmitted: true,
            inspectSavedJob: inspect([]),
        };
    }
    return compact;
}
export function registerValidationTools(server, service) {
    server.registerTool('dcsc_validate', {
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        title: 'Validate for manufacturing',
        description: 'Runs DCSC manufacturing validation on a configuration or workspace and saves the job. Optionally also checks mandatory OS and hypervisor selections.',
        inputSchema: {
            session: z.string(),
            deadlineMs: z.number().int().min(1000).max(300000).optional().describe('Total validation deadline, at most five minutes.'),
            includeMandatorySoftware: z.boolean().optional().describe('Also verify mandatory software (configuration handles only).'),
        },
    }, async (args) => guard(async () => {
        const session = service.sessions.get(args.session);
        const ws = service.sessions.getWorkspace(args.session);
        if (!session && !ws)
            throw new Error(`No such session/workspace: ${args.session}`);
        const ctx = service.newCtx({
            locale: session?.locale ?? ws.locale,
            solution: session?.solution ?? ws.solution,
        });
        const report = await service.validate(args.session, ctx, { deadlineMs: args.deadlineMs });
        const mandatory = args.includeMandatorySoftware
            ? await verifyMandatorySoftware(service, args.session, ctx) : undefined;
        const workspace = service.sessions.resolveHandle(args.session)?.workspace;
        const result = {
            session: args.session,
            revision: workspace?.revision,
            workspaceId: report.workspaceId,
            source: report.source,
            isValid: report.isValid,
            status: report.status,
            jobId: report.jobId,
            payloadSha256: report.payloadSha256,
            validatedRevision: report.validatedRevision,
            stale: report.stale,
            freshValidationRequired: report.freshValidationRequired,
            validatedScope: report.validatedScope,
            localDiagnostics: report.localDiagnostics,
            localErrorCount: report.localErrorCount,
            localWarningCount: report.localWarningCount,
            localInfoCount: report.localInfoCount,
            errorCount: report.errorCount,
            warningCount: report.warningCount,
            infoCount: report.infoCount,
            messages: report.messages,
            lmc: report.server
                ? { buildEntityNumber: report.server.buildEntityNumber, uuid: report.server.uuid, lmcURL: report.server.lmcURL }
                : undefined,
            rackDataOmitted: report.rackDataOmitted,
            ...(report.warning !== undefined ? { warning: report.warning } : {}),
            headroom: report.headroom,
            ...(mandatory ? { mandatorySoftware: { ok: mandatory.status, message: mandatory.message,
                    tabs: mandatory.tabs.map(tab => tab.description) } } : {}),
            next: report.isValid
                ? 'dcsc_export for deliverables.'
                : report.freshValidationRequired
                    ? 'Run dcsc_validate again for a fresh validation job.'
                    : 'Inspect the server and local diagnostics, correct the configuration, then validate again.',
        };
        return projectValidationToolResult(result, { session: args.session, jobId: report.jobId });
    }, 'dcsc_validate failed'));
}
//# sourceMappingURL=validationTools.js.map