import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DcscService } from './service.js';
export { positiveQuantity } from '../app/compare.js';
export declare function requireSession(service: DcscService, id: string): import("../model/session.js").ConfigSession;
/** The `{ session, revision }` header every write returns; revision is the workspace revision. */
export declare function writeHeader(service: DcscService, handle: string): {
    session: string;
    workspace?: string;
    revision: number;
};
export declare function registerSessionTools(server: McpServer, service: DcscService): void;
