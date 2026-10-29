import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReconciliationProposal } from '../domain/reconciliation.js';
import type { DcscService } from './service.js';
export declare function registerReconciliationTools(server: McpServer, service: DcscService): void;
/** Lossless navigation of large comparisons; internal replacement trees are never exposed. */
export declare function projectProposal(proposal: ReconciliationProposal, path: string[], offset: number, limit: number): Record<string, unknown>;
