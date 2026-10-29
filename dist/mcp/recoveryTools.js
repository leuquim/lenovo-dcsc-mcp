import { z } from 'zod';
import { writeRecoveryArtifact, writeRecoverySourceArtifact } from '../files/artifactStore.js';
import { toToolError } from '../http/errors.js';
import { listSessionRecoveryArchives, readSessionRecoveryArchive, serializeWorkspaces } from '../session/persist.js';
import { projectJsonPage } from '../model/pagedJson.js';
export function registerRecoveryTools(server, service) {
    server.registerTool('dcsc_recovery_inspect', {
        title: 'Inspect session restore diagnostics and recovery archives',
        description: 'Inspect startup restore warnings, quarantined records and immutable original-file archives, including when no workspace could be loaded. Follow returned continuations for large reports. Export an archive with dcsc_recovery_export(archiveId). Recovery data does not establish a valid DCSC design.',
        inputSchema: {
            path: z.array(z.string()).optional().default([]),
            offset: z.number().int().min(0).optional().default(0),
            limit: z.number().int().min(1).max(1000).optional().default(20),
        },
    }, async (args) => {
        try {
            const report = { ...service.sessions.lastRestoreReport, recoveryArchives: listSessionRecoveryArchives(service.config) };
            const result = projectJsonPage(report, { tool: 'dcsc_recovery_inspect', arguments: {},
                path: args.path, offset: args.offset, limit: args.limit });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        catch (error) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(toToolError(error), null, 2) }] };
        }
    });
    server.registerTool('dcsc_recovery_export', {
        title: 'Export a workspace snapshot or original recovery archive',
        description: 'Writes one requested workspace, including legacy or damaged recovery records and integrity warnings, ' +
            'to a bounded local JSON artifact. Alternatively supply archiveId from dcsc_recovery_inspect to export the original source bytes, even if corrupt JSON. Supply exactly one of session or archiveId. These diagnostic artifacts are not CFXML and make no quote or validation claim.',
        inputSchema: {
            session: z.string().min(1).optional(),
            archiveId: z.string().regex(/^recovery_[0-9a-f]{64}$/).optional(),
        },
    }, async (args) => {
        try {
            if (Boolean(args.session) === Boolean(args.archiveId))
                throw new Error('Supply exactly one of session or archiveId. Use dcsc_recovery_inspect to list source archives.');
            if (args.archiveId) {
                const bytes = readSessionRecoveryArchive(service.config, args.archiveId);
                const artifact = await writeRecoverySourceArtifact(bytes, args.archiveId, service.config);
                return { content: [{ type: 'text', text: JSON.stringify({
                                archiveId: args.archiveId, ...artifact,
                                warning: 'Byte-for-byte original session source; it may contain invalid JSON or incomplete data. This is not CFXML, a quote or a validation result.',
                            }, null, 2) }] };
            }
            const resolved = service.sessions.resolveHandle(args.session);
            const workspace = resolved?.workspace;
            if (!workspace)
                throw new Error(`Session or workspace ${args.session} not found.`);
            const artifact = await writeRecoveryArtifact(serializeWorkspaces([workspace]), `recovery-${workspace.id}`, service.config);
            const result = {
                workspace: workspace.id,
                integrity: workspace.integrity,
                integrityWarningCount: workspace.integrityWarnings.length,
                integrityWarnings: workspace.integrityWarnings.slice(0, 5).map(warning => warning.slice(0, 500)),
                recoveryRecords: workspace.recoveryData?.length ?? 0,
                path: artifact.path,
                bytes: artifact.bytes,
                sha256: artifact.sha256,
                format: artifact.format,
                artifactWarningCount: artifact.warnings.length,
                artifactWarnings: artifact.warnings.slice(0, 5).map(warning => warning.slice(0, 500)),
                warning: 'This is a Lenovo DCSC MCP JSON recovery snapshot, not CFXML. It is for inspection and recovery only and is not a quote or validation result.',
            };
            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: 'text', text: JSON.stringify(toToolError(error), null, 2) },
                ],
            };
        }
    });
}
//# sourceMappingURL=recoveryTools.js.map