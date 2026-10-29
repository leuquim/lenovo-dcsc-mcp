import type { Config } from '../config/schema.js';
import type { PersistenceWriter, RestoreRecoveryArchive, SessionStore, WorkspaceSession } from './SessionStore.js';
/** Current on-disk envelope. Derived reduced/index data is deliberately absent. */
export declare const SNAPSHOT_VERSION = 2;
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
/** Compatibility entry point for callers that persist outside a transaction. */
export declare function saveSessions(store: SessionStore, config: Config): void;
export declare function serializeWorkspaces(workspaces: readonly WorkspaceSession[]): string;
/** Writes and synchronizes a complete candidate before replacing the live file. */
export declare function saveWorkspaceSnapshot(workspaces: readonly WorkspaceSession[], config: Config): void;
export declare function loadSessions(store: SessionStore, config: Config): number;
