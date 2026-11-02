import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AutoConnectResult } from '../domain/cabling.js';
import type { WorkspaceSession } from '../model/session.js';
import type { DcscService } from './service.js';
export declare function projectAutoConnectToolResult(workspace: WorkspaceSession, result: AutoConnectResult): Record<string, unknown>;
export declare function registerFabricPowerTools(server: McpServer, service: DcscService): void;
