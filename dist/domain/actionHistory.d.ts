import type { WorkspaceSession } from '../model/session.js';
export declare const ACTION_HISTORY_SESSION_TIMESTAMP_KEY = "actionHistorySessionTimestamp";
export type NativeHistoryCommand = 'ADD' | 'UPDATE' | 'MOVE' | 'REMOVE' | 'CHANGE' | 'COPY' | 'CLONE' | 'UNCLONE' | 'IMPORT' | 'LOCK';
/** Semantic fields accepted by the website's Message History command builder. */
export interface NativeHistoryInput {
    command: NativeHistoryCommand;
    quantity?: number | undefined;
    asVLH?: boolean | undefined;
    type?: string | undefined;
    code?: string | undefined;
    description?: string | undefined;
    location?: string | undefined;
    tooltip?: string | undefined;
    /** Original file basename for the native import description. */
    fileName?: string | undefined;
}
export interface NativeHistoryRow {
    timestamp: string;
    key: string;
    command: NativeHistoryCommand;
    description: string;
    sessionTimestamp: string;
    tooltip: string;
}
export type ActionHistoryFactory = (before: WorkspaceSession, after: WorkspaceSession) => NativeHistoryInput | NativeHistoryInput[] | undefined;
interface ActionHistoryDependencies {
    now?: (() => Date) | undefined;
    key?: (() => string) | undefined;
}
/** Reproduces the native builder's spacing and capitalization. */
export declare function buildNativeHistoryDescription(input: NativeHistoryInput): string;
/**
 * Appends native-shaped action rows to a detached accepted workspace candidate.
 * Publication and rollback remain the SessionStore transaction's responsibility.
 */
export declare function appendActionHistory(before: WorkspaceSession, after: WorkspaceSession, events: NativeHistoryInput | NativeHistoryInput[] | undefined, dependencies?: ActionHistoryDependencies): void;
export {};
