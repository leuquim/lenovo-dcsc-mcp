import { randomUUID } from 'node:crypto';

import type { WorkspaceSession } from '../model/session.js';
import { objectOrUndefined } from '../util/coerce.js';

export const ACTION_HISTORY_SESSION_TIMESTAMP_KEY = 'actionHistorySessionTimestamp';

export type NativeHistoryCommand = 'ADD' | 'UPDATE' | 'MOVE' | 'REMOVE' | 'CHANGE' |
  'COPY' | 'CLONE' | 'UNCLONE' | 'IMPORT' | 'LOCK';

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

export type ActionHistoryFactory = (
  before: WorkspaceSession,
  after: WorkspaceSession,
) => NativeHistoryInput | NativeHistoryInput[] | undefined;

interface ActionHistoryDependencies {
  now?: (() => Date) | undefined;
  key?: (() => string) | undefined;
}

/** Reproduces the native builder's spacing and capitalization. */
export function buildNativeHistoryDescription(input: NativeHistoryInput): string {
  assertNativeHistoryInput(input);
  if (input.command === 'IMPORT') return `Import : ${input.fileName}`;
  const command = upperFirst(input.command.toLowerCase());
  const quantity = (input.quantity ?? 0) > 0 ? `x${input.quantity}` : '';
  const vlh = input.asVLH === true ? '[VLH]' : '';
  const type = upperFirst(input.type ?? '');
  const code = (input.code ?? '').toUpperCase();
  const description = input.description ?? '';
  const location = input.location ? ` at ${input.location}` : '';
  return `${command} ${quantity}: ${vlh} ${type} ${code} ${description} ${location}`;
}

/**
 * Appends native-shaped action rows to a detached accepted workspace candidate.
 * Publication and rollback remain the SessionStore transaction's responsibility.
 */
export function appendActionHistory(
  before: WorkspaceSession,
  after: WorkspaceSession,
  events: NativeHistoryInput | NativeHistoryInput[] | undefined,
  dependencies: ActionHistoryDependencies = {},
): void {
  if (after.solution.solutionMode !== 'HPC and AI - Systems') return;
  const inputs = events === undefined ? [] : Array.isArray(events) ? events : [events];
  if (inputs.length === 0) return;
  for (const input of inputs) assertNativeHistoryInput(input);

  // Some accepted DCSC responses replace the whole server-state envelope. Keep
  // prior history unless the replacement explicitly carries a history array.
  const rows = existingHistoryRows(after.serverState) ??
    existingHistoryRows(before.serverState) ?? [];
  const now = (dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error('Action history clock returned an invalid date');
  const timestamp = formatNativeTimestamp(now);
  // Import records belong to the session doing the import. Subsequent actions
  // belong to the new session started by that successful import, not a session
  // timestamp retained inside the imported document.
  let sessionTimestamp = inputs.some(input => input.command === 'IMPORT')
    ? resolveSessionTimestamp(before, before, existingHistoryRows(before.serverState) ?? [], timestamp)
    : resolveSessionTimestamp(before, after, rows, timestamp);
  const nextRows: unknown[] = [...structuredClone(rows)];
  for (const input of inputs) {
    nextRows.push({
      timestamp,
      key: (dependencies.key ?? randomUUID)(),
      command: input.command,
      description: buildNativeHistoryDescription(input),
      sessionTimestamp,
      tooltip: input.tooltip ?? '',
    } satisfies NativeHistoryRow);
    if (input.command === 'IMPORT') sessionTimestamp = timestamp;
  }
  after.serverState.historyInformation = nextRows;
  after.serverState[ACTION_HISTORY_SESSION_TIMESTAMP_KEY] = sessionTimestamp;
}

function existingHistoryRows(serverState: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(serverState.historyInformation)) return serverState.historyInformation;
  const messageHistory = objectOrUndefined(serverState.messageHistory);
  return Array.isArray(messageHistory?.history) ? messageHistory.history : undefined;
}

function resolveSessionTimestamp(
  before: WorkspaceSession,
  after: WorkspaceSession,
  rows: readonly unknown[],
  fallback: string,
): string {
  const afterValue = nonemptyString(after.serverState[ACTION_HISTORY_SESSION_TIMESTAMP_KEY]);
  if (afterValue) return afterValue;
  const beforeValue = nonemptyString(before.serverState[ACTION_HISTORY_SESSION_TIMESTAMP_KEY]);
  if (beforeValue) return beforeValue;

  let latestImport: { timestamp: string; time: number } | undefined;
  for (const value of rows) {
    const row = objectOrUndefined(value);
    if (nonemptyString(row?.command)?.toUpperCase() !== 'IMPORT') continue;
    const timestamp = nonemptyString(row?.timestamp);
    const time = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
    if (timestamp !== undefined && Number.isFinite(time) && (!latestImport || time >= latestImport.time)) {
      latestImport = { timestamp, time };
    }
  }
  if (latestImport) return latestImport.timestamp;

  const createdAt = Number.isFinite(after.createdAt) ? after.createdAt : before.createdAt;
  return Number.isFinite(createdAt) ? formatNativeTimestamp(new Date(createdAt)) : fallback;
}

function assertNativeHistoryInput(input: NativeHistoryInput): void {
  if (!['ADD', 'UPDATE', 'MOVE', 'REMOVE', 'CHANGE', 'COPY', 'CLONE', 'UNCLONE', 'IMPORT', 'LOCK'].includes(input.command)) {
    throw new Error(`Unsupported native history command ${String(input.command)}`);
  }
  if (
    input.quantity !== undefined &&
    (!Number.isInteger(input.quantity) || input.quantity < 0)
  ) {
    throw new Error('Action history quantity must be a non-negative integer');
  }
  for (const key of ['type', 'code', 'description', 'location', 'tooltip', 'fileName'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'string') {
      throw new Error(`Action history ${key} must be a string`);
    }
  }
  if (input.command === 'IMPORT' && !input.fileName?.trim()) {
    throw new Error('An import history record requires the imported filename');
  }
}

function formatNativeTimestamp(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${hours}:${minutes}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function upperFirst(value: string): string {
  return value.length === 0 ? '' : value[0]!.toUpperCase() + value.slice(1);
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

