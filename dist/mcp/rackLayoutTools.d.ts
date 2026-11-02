import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LayoutResult } from '../domain/rack.js';
import type { WorkspaceSession } from '../model/session.js';
import type { DcscService } from './service.js';
/**
 * Presents a rack layout the way an architect reads one.
 *
 * Everything here is DCSC's verdict, not ours — in particular `unplaced` and
 * `errors`, which are how the server says a placement was refused.
 */
export declare function projectLayout(layout: LayoutResult, workspace: WorkspaceSession): Record<string, unknown>;
export declare function registerRackLayoutTools(server: McpServer, service: DcscService): void;
