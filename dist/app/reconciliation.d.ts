import { type ReconciliationProposal } from '../domain/reconciliation.js';
import { type RequestCtx } from '../http/request.js';
import type { Runtime } from './runtime.js';
export declare function assertTrustedWorkspace(rt: Runtime, handle: string): void;
export declare function proposeReconciliation(rt: Runtime, handle: string, ctx: RequestCtx): Promise<ReconciliationProposal>;
export declare function reconciliationProposal(rt: Runtime, handle: string, proposalId: string): ReconciliationProposal;
export declare function acceptReconciliation(rt: Runtime, handle: string, proposalId: string): Promise<{
    workspace: string;
    revision: number;
    integrity: string;
}>;
