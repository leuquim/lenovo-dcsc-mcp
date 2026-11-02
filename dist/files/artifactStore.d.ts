import type { Config } from '../config/schema.js';
export interface ExportMember {
    name: string;
    bytes: number;
    path: string;
}
export interface ExportBundle {
    zipPath: string;
    bytes: number;
    sha256: string;
    members: ExportMember[];
    xml?: string;
    workbooks: string[];
    warnings: string[];
}
export interface ArtifactCleanupResult {
    removed: string[];
    warnings: string[];
}
export interface RecoveryArtifact {
    path: string;
    bytes: number;
    sha256: string;
    format: 'lenovo-dcsc-session-snapshot-v2' | 'lenovo-dcsc-session-source-bytes';
    warnings: string[];
}
export declare function artifactDir(config: Config): string;
/**
 * Filenames from `Content-Disposition` are a display label, never a path.
 * Strip separators and traversal, cap the length, and keep it to a safe charset.
 */
export declare function sanitiseFileName(name: string): string;
/**
 * Removes only completed export bundles that this module marked as owned.
 *
 * Unmarked directories, user imports, symlinks and in-progress publications
 * are deliberately ignored. A caller may run this concurrently with an export:
 * staging directories are hidden and a final directory remains in activeArtifacts
 * until writeExportBundle has returned.
 */
export declare function cleanupExpiredArtifacts(config: Config, nowMs?: number): ArtifactCleanupResult;
/**
 * Streams the export into a private staging directory, verifies and extracts it,
 * then publishes the whole bundle with one directory rename.
 *
 * The download limit is enforced before each chunk reaches disk. Hashing and the
 * error preview are gathered during that same pass, so the completed ZIP is never
 * read back into memory.
 */
export declare function writeExportBundle(stream: NodeJS.ReadableStream, fileName: string, config: Config): Promise<ExportBundle>;
/**
 * Publishes a bounded JSON recovery snapshot through the same owned-artifact
 * lifecycle as downloaded exports. The supplied JSON is preserved byte for
 * byte; callers remain responsible for choosing the recovery envelope.
 */
export declare function writeRecoveryArtifact(json: string, fileName: string, config: Config): Promise<RecoveryArtifact>;
/** Corrupt source files must remain recoverable without decoding or JSON normalization. */
export declare function writeRecoverySourceArtifact(bytes: Buffer, fileName: string, config: Config): Promise<RecoveryArtifact>;
export declare function writeCfxmlArtifact(bytes: Buffer, fileName: string, config: Config): Promise<Omit<RecoveryArtifact, "format"> & {
    format: "lenovo-cfxml";
}>;
export interface SpreadsheetArtifact {
    path: string;
    bytes: number;
    sha256: string;
    warnings: string[];
}
/** Streams a DCSC .xlsx download into the artifact store, rejecting bodies that are not a ZIP container. */
export declare function writeSpreadsheetArtifact(stream: NodeJS.ReadableStream, fileName: string, config: Config): Promise<SpreadsheetArtifact>;
/** Streams a DCSC VLH item export (XML) into the artifact store, rejecting bodies that are not a VLHData document. */
export declare function writeVlhArtifact(stream: NodeJS.ReadableStream, fileName: string, config: Config): Promise<SpreadsheetArtifact>;
