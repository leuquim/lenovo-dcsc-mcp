import { z } from 'zod';
import { writeRecoveryArtifact, writeRecoverySourceArtifact } from '../files/artifactStore.js';
import { readSessionRecoveryArchive, serializeWorkspaces } from '../session/persist.js';
import { guard } from './toolSupport.js';
export function registerRecoveryTools(server, service) {
    server.registerTool('dcsc_recovery_export', {
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        title: 'Export a workspace snapshot or original recovery archive',
        description: 'Writes one requested workspace (including legacy or damaged recovery records) to a bounded local JSON artifact, or exports original archive bytes when archiveId is supplied. Supply exactly one of session or archiveId.',
        inputSchema: {
            session: z.string().min(1).optional(),
            archiveId: z.string().regex(/^recovery_[0-9a-f]{64}$/).optional(),
        },
    }, async (args) => guard(async () => {
        if (Boolean(args.session) === Boolean(args.archiveId)) {
            throw new Error('Supply exactly one of session or archiveId. Use dcsc_session_list with view recovery to list source archives.');
        }
        if (args.archiveId) {
            const bytes = readSessionRecoveryArchive(service.config, args.archiveId);
            const artifact = await writeRecoverySourceArtifact(bytes, args.archiveId, service.config);
            return {
                archiveId: args.archiveId, ...artifact,
                warning: 'Byte-for-byte original session source; it may contain invalid JSON or incomplete data. This is not CFXML, a quote or a validation result.',
            };
        }
        const resolved = service.sessions.resolveHandle(args.session);
        const workspace = resolved?.workspace;
        if (!workspace)
            throw new Error(`Session or workspace ${args.session} not found.`);
        const artifact = await writeRecoveryArtifact(serializeWorkspaces([workspace]), `recovery-${workspace.id}`, service.config);
        return {
            session: workspace.id,
            revision: workspace.revision,
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
    }, 'dcsc_recovery_export failed'));
}
//# sourceMappingURL=recoveryTools.js.map