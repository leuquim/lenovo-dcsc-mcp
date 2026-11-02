import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export type ToolResult = {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
};
export declare function ok(value: unknown): ToolResult;
export declare function fail(err: unknown, context?: string): ToolResult;
/** Wraps a handler so no raw upstream detail can escape through a tool result. */
export declare function guard(fn: () => unknown | Promise<unknown>, context?: string): Promise<ToolResult>;
export declare const VERIFIED_CAPABILITIES_DOC: string;
export declare function registerCapabilitiesResource(server: McpServer): void;
