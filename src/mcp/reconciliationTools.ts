import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ReconciliationProposal } from '../domain/reconciliation.js';
import { toToolError } from '../http/errors.js';
import type { DcscService } from './service.js';

export function registerReconciliationTools(server: McpServer, service: DcscService): void {
  server.registerTool('dcsc_reconcile_workspace', {
    title: 'Review and accept a saved design reconciliation',
    description: 'propose derives the current configurations and durably stores a reviewable comparison without changing selections or design revision. inspect pages through all proposal differences and warnings; use nextPath to expand a large field. apply explicitly accepts the identified proposal only while its original revision and content still match. Missing legacy intent remains an acknowledged uncertainty. Damaged or quarantined design data requires repair or re-import. Configuration reconciliation does not certify legacy physical layout; export and validation remain gated for that state.',
    inputSchema: {
      session: z.string(),
      action: z.enum(['propose', 'inspect', 'apply']),
      proposalId: z.string().optional(),
      path: z.array(z.string()).optional().default([]),
      offset: z.number().int().min(0).optional().default(0),
      limit: z.number().int().min(1).max(1000).optional().default(20),
    },
  }, async args => {
    try {
      let result: unknown;
      if (args.action === 'propose') {
        const proposal = await service.proposeReconciliation(args.session, service.newCtx());
        result = { workspace: proposal.workspaceId, proposalId: proposal.id, sourceRevision: proposal.sourceRevision,
          sourceHash: proposal.sourceHash, status: proposal.status, configurations: proposal.diffs.length,
          changedConfigurations: proposal.diffs.filter(diff => diff.changed).length,
          warningCount: proposal.warnings.length,
          note: 'Review differences and warnings before explicitly applying. Reconciliation cannot recover omitted legacy intent.',
          next: { tool: 'dcsc_reconcile_workspace', arguments: { session: proposal.workspaceId,
            action: 'inspect', proposalId: proposal.id, path: [], offset: 0, limit: 20 } } };
      } else {
        if (!args.proposalId) throw new Error('proposalId is required for inspect or apply.');
        if (args.action === 'apply') result = await service.acceptReconciliation(args.session, args.proposalId);
        else result = projectProposal(service.reconciliationProposal(args.session, args.proposalId), args.path, args.offset, args.limit);
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error), null, 2) }] };
    }
  });
}

/** Lossless navigation of large comparisons; internal replacement trees are never exposed. */
export function projectProposal(proposal: ReconciliationProposal, path: string[], offset: number, limit: number): Record<string, unknown> {
  const { target: _target, ...review } = proposal;
  let value: unknown = review;
  for (const key of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error(`Unknown review path ${path.join('.')}.`);
    value = (value as Record<string, unknown>)[key];
  }
  const args = { session: proposal.workspaceId, action: 'inspect', proposalId: proposal.id, path, limit };
  if (typeof value === 'string') {
    const text = value.slice(offset, offset + Math.min(limit, 1000));
    return { proposalId: proposal.id, path, total: value.length, offset, text,
      ...(offset + text.length < value.length ? { next: { tool: 'dcsc_reconcile_workspace', arguments: { ...args, offset: offset + text.length } } } : {}) };
  }
  const entries = value && typeof value === 'object' ? Object.entries(value) : [['value', value]];
  const page = entries.slice(offset, offset + Math.min(limit, 50)).map(([key, entry]) => {
    const nextPath = value && typeof value === 'object' ? [...path, key] : path;
    if (JSON.stringify(entry)?.length > 1500) {
      return { key, value: { type: Array.isArray(entry) ? 'array' : typeof entry,
        size: typeof entry === 'string' ? entry.length : Object.keys(entry as object).length }, nextPath };
    }
    return { key, value: entry, ...(entry && typeof entry === 'object' ? { nextPath } : {}) };
  });
  const build = () => ({ proposalId: proposal.id, sourceRevision: proposal.sourceRevision, path, total: entries.length,
    offset, returned: page.length, items: page,
    ...(offset + page.length < entries.length ? { next: { tool: 'dcsc_reconcile_workspace', arguments: { ...args, offset: offset + page.length } } } : {}) });
  let result = build();
  while (Buffer.byteLength(JSON.stringify(result, null, 2)) > 7500 && page.length > 1) { page.pop(); result = build(); }
  if (Buffer.byteLength(JSON.stringify(result, null, 2)) > 7500) throw new Error('Review path exceeds the response budget. Use a shorter path or inspect the parent field.');
  return result;
}
