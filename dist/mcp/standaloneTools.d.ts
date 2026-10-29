import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ExportFileType } from '../domain/reduce.js';
import { type ExportBundle } from '../files/artifactStore.js';
import type { WorkspaceSession } from '../session/SessionStore.js';
import type { DcscService } from './service.js';
/** Captured default choices in the standalone software export dialog. */
export declare const SOFTWARE_EXPORT_TYPES: ExportFileType[];
export declare function registerStandaloneTools(server: McpServer, service: DcscService): void;
export declare function exportStandaloneSoftwareArtifact(service: DcscService, workspace: WorkspaceSession, fileName: string, options?: {
    fileTypes?: ExportFileType[] | undefined;
    image?: string | undefined;
}): Promise<ExportBundle & {
    contentDisposition: string | undefined;
}>;
export declare function exportProductServiceArtifact(service: DcscService, workspace: WorkspaceSession, fileName: string): Promise<ExportBundle & {
    contentDisposition: string | undefined;
}>;
