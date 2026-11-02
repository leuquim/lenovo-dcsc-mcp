import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DcscService } from './service.js';
import { type Obj } from '../util/coerce.js';
/** Keeps ordinary validation results intact and makes oversized reports losslessly navigable. */
export declare function projectValidationToolResult(full: Obj, options: {
    session: string;
    jobId: string;
    maxBytes?: number | undefined;
}): Obj;
export declare function registerValidationTools(server: McpServer, service: DcscService): void;
