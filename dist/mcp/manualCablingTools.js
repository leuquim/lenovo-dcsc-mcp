import { z } from 'zod';
import { toToolError } from '../http/errors.js';
import { projectJsonPage } from '../model/pagedJson.js';
const endpointSchema = z.object({
    configurationId: z.string().min(1).describe('Physical endpoint ID returned by dcsc_cabling_connections.'),
    portName: z.string().min(1),
    portNumber: z.string().min(1),
}).strict();
export function registerManualCablingTools(server, service) {
    server.registerTool('dcsc_cabling_connections', {
        title: 'Inspect editable DCSC cable connections',
        description: 'Lists the authoritative current connection graph, stable row IDs, physical endpoint/port choices and compatible cable parts. Follow returned continuations unchanged. This is the discovery step for dcsc_edit_cabling_connection; it does not create or delete rows.',
        inputSchema: {
            session: z.string().describe('Workspace or configuration handle.'),
            expectedWorkspaceRevision: z.number().int().min(1).optional()
                .describe('Optional read guard. A mismatch rejects stale navigation.'),
            path: z.array(z.string()).optional().default([]),
            offset: z.number().int().min(0).optional().default(0),
            limit: z.number().int().min(1).max(1000).optional().default(20),
        },
    }, async (args) => {
        try {
            const snapshot = await service.inspectManualCabling(args.session, args.expectedWorkspaceRevision);
            const page = projectJsonPage(snapshot.report, {
                tool: 'dcsc_cabling_connections',
                arguments: { session: args.session, expectedWorkspaceRevision: snapshot.revision },
                path: args.path, offset: args.offset, limit: args.limit,
            });
            return { content: [{ type: 'text', text: JSON.stringify({
                            workspace: snapshot.workspace, workspaceRevision: snapshot.revision,
                            revisionScope: 'workspace', ...page,
                        }, null, 2) }] };
        }
        catch (error) {
            return { isError: true,
                content: [{ type: 'text', text: JSON.stringify(toToolError(error), null, 2) }] };
        }
    });
    server.registerTool('dcsc_edit_cabling_connection', {
        title: 'Edit one existing DCSC cable connection',
        description: 'Edits the source, destination, or compatible cable part of one authoritative existing connection row selected by the stable ID from dcsc_cabling_connections. Endpoint values and cablePart must be exact identifiers from that inspection. Selecting an occupied destination port on the same component swaps the other connection to the original port; both accepted rows are returned. A cable-part replacement runs its coupled hardware-selection derive before the complete accepted graph commits atomically. Edit endpoints and cablePart in separate revision-bound calls. The website exposes Edit for existing rows; this tool does not claim Add/Delete semantics.',
        inputSchema: {
            session: z.string().describe('Workspace or configuration handle.'),
            connectionId: z.string().regex(/^connection_[0-9a-f]{20}$/),
            source: endpointSchema.optional(),
            destination: endpointSchema.optional(),
            cablePart: z.string().min(1).optional()
                .describe('Exact compatibleCables[].part value returned for this row.'),
            expectedRevision: z.number().int().min(1)
                .describe('Required workspace revision returned by dcsc_cabling_connections.'),
        },
    }, async (args) => {
        try {
            if (!args.source && !args.destination && !args.cablePart) {
                throw new Error('Supply a source, destination or cable-part change.');
            }
            const result = await service.editManualCabling(args.session, {
                connectionId: args.connectionId,
                ...(args.source ? { source: args.source } : {}),
                ...(args.destination ? { destination: args.destination } : {}),
                ...(args.cablePart ? { cablePart: args.cablePart } : {}),
                expectedRevision: args.expectedRevision,
                ctx: service.newCtx(),
            });
            // Compatible choices can contain dozens of opaque upstream records.
            // Mutation output carries the accepted row identity/state; callers use
            // the bounded inspection continuation to retrieve choices.
            const { compatibleCables: _compatibleCables, ...connection } = result.connection;
            return { content: [{ type: 'text', text: JSON.stringify({
                            workspace: result.workspace,
                            workspaceRevision: result.revision,
                            revisionScope: 'workspace',
                            connection,
                            ...(result.swappedConnections?.length ? {
                                swappedConnections: result.swappedConnections.map(({ compatibleCables: _choices, ...row }) => row),
                            } : {}),
                            ...(result.configurationChange ? { configurationChange: result.configurationChange } : {}),
                            inspect: { tool: 'dcsc_cabling_connections', arguments: {
                                    session: result.workspace,
                                    expectedWorkspaceRevision: result.revision,
                                    path: ['connections'], offset: 0, limit: 20,
                                } },
                        }, null, 2) }] };
        }
        catch (error) {
            return { isError: true,
                content: [{ type: 'text', text: JSON.stringify(toToolError(error), null, 2) }] };
        }
    });
}
//# sourceMappingURL=manualCablingTools.js.map