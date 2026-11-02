import type { Config } from '../config/schema.js';
import type { PersistenceWriter, RestoreRecoveryArchive, SessionStore } from './SessionStore.js';
import type { WorkspaceSession } from '../model/session.js';
/** Self-contained envelope of recovery exports and archives. Derived reduced/index data is deliberately absent. */
export declare const SNAPSHOT_VERSION = 2;
/** Envelope of a workspace's doc.json, whose large values are references into blobs/. */
export declare const WORKSPACE_DOC_VERSION = 3;
export declare function stateFile(config: Config): string;
/**
 * Lists immutable source snapshots retained when persisted state could not be
 * restored losslessly. Paths remain private; callers use the opaque id with
 * readSessionRecoveryArchive.
 */
export declare function listSessionRecoveryArchives(config: Config): RestoreRecoveryArchive[];
/** Reads one confined recovery archive and verifies it against its opaque id. */
export declare function readSessionRecoveryArchive(config: Config, id: string): Buffer;
/** Writer suitable for SessionStore.setPersistenceWriter. */
export declare function createPersistenceWriter(config: Config): PersistenceWriter | undefined;
/** Writes every loaded workspace through the same path the store's writer uses. */
export declare function saveSessions(store: SessionStore, config: Config): void;
/** Self-contained JSON of workspaces with every value inline, for recovery export and archives. */
export declare function serializeWorkspaces(workspaces: readonly WorkspaceSession[]): string;
/**
 * Registers the persisted workspaces with the store without reading them; each
 * is parsed and restored when first accessed. The legacy single-file state is
 * set aside once and ignored.
 */
export declare function loadSessions(store: SessionStore, config: Config): number;
export declare function workspacesDirectory(config: Config): string;
export declare function workspaceDirectory(config: Config, id: string): string;
/** The document of one workspace; its large values live next to it under blobs/. */
export declare function workspaceFile(config: Config, id: string): string;
export declare function workspaceBlobsDirectory(config: Config, id: string): string;
