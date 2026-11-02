import { type ServiceSavingsResult, type FlagSummaryResult } from '../domain/summaryInsights.js';
import type { ConfigMode } from '../config/constants.js';
import { type ReferenceQuery } from '../domain/referenceSolutions.js';
import { type ExportFileType } from '../domain/reduce.js';
import { type LogicalGroup } from '../domain/exportGroups.js';
import { type RequestCtx } from '../http/request.js';
import { type ImportResult } from './serviceHelpers.js';
import type { Runtime } from './runtime.js';
export declare function downloadReferenceSolutionArtifact(rt: Runtime, crnId: string, ctx: RequestCtx, solutionMode?: string): Promise<Omit<import("../files/artifactStore.js").RecoveryArtifact, "format"> & {
    format: "lenovo-cfxml";
}>;
export declare function referenceSolutions(rt: Runtime, query: ReferenceQuery, ctx: RequestCtx, solutionMode?: string): Promise<{
    raw: unknown;
    solution: {
        solutionMode: string;
        masterSlices: string[];
    };
}>;
export declare function launchReferenceSolution(rt: Runtime, crnId: string, ctx: RequestCtx, solutionMode?: string): Promise<ImportResult>;
/**
 * Customizes a preconfigured Solution ID (SID) template into a workspace session.
 */
export declare function customizeSid(rt: Runtime, sidNumber: string, opts?: {
    ctx?: RequestCtx | undefined;
    solutionMode?: string | undefined;
    workspaceId?: string | undefined;
    expectedRevision?: number | undefined;
    mode?: ConfigMode | undefined;
}): Promise<ImportResult>;
/**
 * Imports CFXML or an exported Excel workbook through DCSC's own importer.
 *
 * This deliberately posts the file to /multiple/cfxml_import rather than
 * parsing it locally and re-launching each product code. Launch does not
 * enforce slice membership, so a local replay happily "imports" a CFXML that
 * the real DCSC rejects — a config whose declared solution mode does not
 * contain the model comes back from launch fully priced, while the genuine
 * import drops it as a missing part. Only the server can tell us that, so we
 * ask it, and surface whatever it reports.
 *
 * Whether a model imports at all is decided by the solution mode of *this
 * request*, not by the file: DCSC resolves each product against the mode's
 * catalog. The same CFXML for a General-Purpose-only model (SR685a V3, say)
 * imports cleanly under "General Purpose" and is rejected outright under
 * "HPC and AI - Systems". Callers who know better can override the mode.
 */
export declare function importConfig(rt: Runtime, opts: {
    content: string | Uint8Array;
    ctx: RequestCtx;
    mode?: ConfigMode;
    workspaceId?: string;
    fileName?: string;
    solutionMode?: string;
    expectedRevision?: number | undefined;
}): Promise<ImportResult>;
/**
 * Streams the export ZIP to disk and returns where it landed.
 *
 * Scope follows the handle: a configuration id exports that configuration,
 * a workspace id exports the workspace. That distinction is load-bearing —
 * resolving a configuration id to its parent used to export every product in
 * the workspace, which both surprised the caller and walked into the rack
 * payload rejection below.
 *
 * Rack export uses the website's slim hierarchy plus independent physical
 * rackData. A failed full-workspace handoff is surfaced without dropping layout.
 */
export declare function exportZip(rt: Runtime, sessionHandle: string, opts: {
    fileTypes: ExportFileType[];
    fileName: string;
    ctx: RequestCtx;
    scope?: 'auto' | 'configuration' | 'workspace' | undefined;
    logicalGroups?: LogicalGroup[] | undefined;
    /** Retained for compatibility; rack data is always included for workspace export. */
    attemptRackPayload?: boolean | undefined;
}): Promise<{
    stream: NodeJS.ReadableStream;
    contentDisposition: string | undefined;
    rackDataOmitted: boolean;
    scope: 'configuration' | 'workspace';
    configurationsExported: number;
    manualPlanningLinksOmitted: number;
    breakoutBranchesAtRisk: number;
}>;
export declare function summaryInsights(rt: Runtime, input: {
    session?: string | undefined;
    type?: 'serviceSaving' | 'flagSummary' | string | undefined;
    workspaceSnapshot?: Record<string, unknown> | undefined;
}, ctx?: RequestCtx): Promise<ServiceSavingsResult | FlagSummaryResult>;
export declare function shareUrlFields(rt: Runtime, ctx: RequestCtx, include: boolean | undefined, configId: string): Promise<{
    shareUrl?: string;
    shareUrlError?: string;
}>;
export declare function exportPowerReport(rt: Runtime, sessionHandle: string, opts?: {
    fileTypes?: ExportFileType[] | undefined;
    fileName?: string | undefined;
    scope?: 'auto' | 'configuration' | 'workspace' | undefined;
    includeShareUrl?: boolean | undefined;
    ctx?: RequestCtx | undefined;
}): Promise<Record<string, unknown>>;
export declare const EXPORT_KINDS: readonly ['reports', 'power', 'configurationTree', 'reference', 'servicesCatalog'];
export type ExportKind = (typeof EXPORT_KINDS)[number];
export interface ExportArgs {
    kind: ExportKind;
    session?: string | undefined;
    scope?: 'auto' | 'configuration' | 'workspace' | undefined;
    fileName?: string | undefined;
    fileTypes?: ExportFileType[] | undefined;
    includeShareUrl?: boolean | undefined;
    groups?: LogicalGroup[] | undefined;
    name?: string | undefined;
    dataList?: Array<{
        typeName: string;
        contents: string[];
    }> | undefined;
    crnId?: string | undefined;
    productCode?: string | undefined;
    solutionMode?: string | undefined;
}
export declare function exportArtifact(rt: Runtime, args: ExportArgs): Promise<Record<string, unknown>>;
export interface ImportArgs {
    content?: string | undefined;
    filePath?: string | undefined;
    mode?: ConfigMode | undefined;
    session?: string | undefined;
    expectedRevision?: number | undefined;
    solutionMode?: string | undefined;
}
export declare function importArtifact(rt: Runtime, args: ImportArgs): Promise<Record<string, unknown>>;
