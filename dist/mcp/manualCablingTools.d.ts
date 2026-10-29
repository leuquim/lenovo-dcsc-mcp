import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ManualCablingCatalog, ManualConnectionEdit, ManualConnectionView } from '../domain/manualCabling.js';
import type { RequestCtx } from '../http/request.js';
export interface ManualCablingInspection {
    workspace: string;
    revision: number;
    report: ManualCablingCatalog;
}
export interface ManualCablingEditResult {
    workspace: string;
    revision: number;
    connection: ManualConnectionView;
    swappedConnections?: ManualConnectionView[] | undefined;
    configurationChange?: {
        session: string;
        configurationId: string;
        previousTotalPrice?: number | null | undefined;
        totalPrice?: number | null | undefined;
        priceDelta?: number | null | undefined;
        currency?: string | undefined;
        priceScope?: 'editable-configuration' | undefined;
    } | undefined;
}
/** Thin service contract: DcscService owns transaction, HTTP and derive orchestration. */
export interface ManualCablingService {
    newCtx(): RequestCtx;
    inspectManualCabling(session: string, expectedWorkspaceRevision?: number): ManualCablingInspection | Promise<ManualCablingInspection>;
    editManualCabling(session: string, input: ManualConnectionEdit & {
        expectedRevision: number;
        ctx: RequestCtx;
    }): Promise<ManualCablingEditResult>;
}
export declare function registerManualCablingTools(server: McpServer, service: ManualCablingService): void;
