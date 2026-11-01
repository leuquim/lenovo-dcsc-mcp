import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { writeRecoveryArtifact, writeRecoverySourceArtifact } from '../files/artifactStore.js';
import { listSessionRecoveryArchives, readSessionRecoveryArchive, serializeWorkspaces } from '../session/persist.js';
import { projectJsonPage } from '../model/pagedJson.js';
import type { DcscService } from './service.js';
import { guard } from './toolSupport.js';

export function registerRecoveryTools(server: McpServer, service: DcscService): void {
  server.registerTool('dcsc_recovery_inspect', {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    title: 'Inspect session restore diagnostics and recovery archives',
    description: 'Inspects startup restore warnings, quarantined records and immutable original-file archives. Follow returned continuations for large reports. Export an archive with dcsc_recovery_export(archiveId).',
    inputSchema: {
      path: z.array(z.string()).optional().default([]),
      offset: z.number().int().min(0).optional().default(0),
      limit: z.number().int().min(1).max(1000).optional().default(20),
    },
  }, async args => guard(() => {
    const report = { ...service.sessions.lastRestoreReport, recoveryArchives: listSessionRecoveryArchives(service.config) };
    return projectJsonPage(report, { tool: 'dcsc_recovery_inspect', arguments: {},
      path: args.path, offset: args.offset, limit: args.limit });
  }, 'dcsc_recovery_inspect failed'));

  server.registerTool(
    'dcsc_recovery_export',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Export a workspace snapshot or original recovery archive',
      description:
        'Writes one requested workspace (including legacy or damaged recovery records) to a bounded local JSON artifact, or exports original archive bytes when archiveId is supplied. Supply exactly one of session or archiveId.',
      inputSchema: {
        session: z.string().min(1).optional(),
        archiveId: z.string().regex(/^recovery_[0-9a-f]{64}$/).optional(),
      },
    },
    async (args) => guard(async () => {
      if (Boolean(args.session) === Boolean(args.archiveId)) {
        throw new Error('Supply exactly one of session or archiveId. Use dcsc_recovery_inspect to list source archives.');
      }
      if (args.archiveId) {
        const bytes = readSessionRecoveryArchive(service.config, args.archiveId);
        const artifact = await writeRecoverySourceArtifact(bytes, args.archiveId, service.config);
        return {
          archiveId: args.archiveId, ...artifact,
          warning: 'Byte-for-byte original session source; it may contain invalid JSON or incomplete data. This is not CFXML, a quote or a validation result.',
        };
      }
      const resolved = service.sessions.resolveHandle(args.session!);
      const workspace = resolved?.workspace;
      if (!workspace) throw new Error(`Session or workspace ${args.session} not found.`);

      const artifact = await writeRecoveryArtifact(
        serializeWorkspaces([workspace]),
        `recovery-${workspace.id}`,
        service.config,
      );
      return {
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
        warning:
          'This is a Lenovo DCSC MCP JSON recovery snapshot, not CFXML. It is for inspection and recovery only and is not a quote or validation result.',
      };
    }, 'dcsc_recovery_export failed'),
  );
}
