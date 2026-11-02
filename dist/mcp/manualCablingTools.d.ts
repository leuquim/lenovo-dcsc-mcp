import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CableDistanceQuery, CablingCandidate, CablingChange } from '../app/cabling.js';
import type { ManualConnectionView } from '../domain/manualCabling.js';
import type { RequestCtx } from '../http/request.js';
export interface ManualCablingEditResult {
    pinnedConnectionCount?: number;
    sourceConfigurationIds?: string[];
    destinationConfigurationIds?: string[];
    additionalConnectionCount?: number;
    workspace: string;
    revision: number;
    connection: ManualConnectionView;
    swappedConnections?: ManualConnectionView[] | undefined;
    updatedConnections?: ManualConnectionView[] | undefined;
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
    inspectCabling(session: string, input: {
        expectedRevision?: number | undefined;
        refreshConnectionId?: string | undefined;
        candidate?: Omit<CablingCandidate, 'expectedRevision'> | undefined;
        distance?: CableDistanceQuery | undefined;
        ctx: RequestCtx;
    }): Promise<{
        workspace: string;
        revision: number;
        report: unknown;
    }>;
    applyCablingChanges(session: string, changes: readonly CablingChange[], expectedRevision: number, ctx: RequestCtx): Promise<{
        workspace: string;
        revision: number;
        results: Array<{
            action: CablingChange['action'];
            result: ManualCablingEditResult;
        }>;
    }>;
}
export declare function registerManualCablingTools(server: McpServer, service: ManualCablingService): void;
