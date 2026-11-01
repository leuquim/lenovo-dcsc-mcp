import type { RawConfiguration } from '../model/types.js';
import type { WorkspaceSession } from '../model/session.js';
import { usesCtoWire } from './modeFamily.js';
import { buildAutoDeriveRequest } from './reduce.js';
import { readStorageConnectionNetworks } from './storagePreferences.js';
import { autoDerivePath, type AutoDerivePath } from './endpoints.js';

export interface StorageAssignmentRequest {
  endpoint: 'storage_assignment';
  method: 'POST';
  path: AutoDerivePath;
  query: {
    configurationId: string;
    guideMode: boolean;
  };
  body: Record<string, unknown>;
}

export interface StorageAssignmentResult {
  configuration: RawConfiguration;
  responseState: Record<string, unknown>;
}

function selectedName(name: string | null): string {
  if (name === null) return '';
  const selected = name.trim();
  if (!selected) throw new Error('Storage network name must be nonempty, or null to select No storage networking.');
  return selected;
}

/**
 * Builds the exact derive used by Configuration > Network > Manage storage networks.
 *
 * Every workspace configuration remains rule context, but only the target raw
 * configuration receives the selected name and only its ID is customized. The
 * live request does not carry a workspace selected-storage map.
 */
export function buildStorageAssignmentRequest(
  workspace: WorkspaceSession,
  targetConfigurationId: string,
  networkName: string | null,
): StorageAssignmentRequest {
  const matches = [...workspace.configurations.values()]
    .filter((session) => session.configurationId === targetConfigurationId);
  if (matches.length !== 1) {
    throw new Error(`Storage assignment target ${targetConfigurationId} is ${matches.length ? 'ambiguous' : 'unknown'}.`);
  }
  const target = matches[0]!;
  if (target.raw.type !== 'server') {
    throw new Error(`Storage assignment target ${targetConfigurationId} is ${String(target.raw.type)}; the captured website control is available on server configurations.`);
  }
  if ([...workspace.configurations.values()].some((session) => !usesCtoWire(session.mode))) {
    throw new Error('The captured storage assignment contract currently supports CTO-only workspaces.');
  }

  const selectedStorageNetwork = selectedName(networkName);
  if (selectedStorageNetwork) {
    const available = readStorageConnectionNetworks(workspace.serverState).map((network) => network.name);
    if (!available.includes(selectedStorageNetwork)) {
      throw new Error(`Unknown storage network "${selectedStorageNetwork}". Available: ${available.join(', ') || 'none'}.`);
    }
  }

  const configurations = new Map([...workspace.configurations.entries()].map(([key, session]) => [
    key,
    session.configurationId === targetConfigurationId
      ? { ...session, raw: { ...structuredClone(session.raw), selectedStorageNetwork } }
      : session,
  ]));
  const requestWorkspace: WorkspaceSession = { ...workspace, configurations };
  const body = buildAutoDeriveRequest(requestWorkspace, {
    validationMode: workspace.validationMode,
    autoCorrect: [...workspace.configurations.values()].every((session) => session.autoCorrect),
  });
  body['customizingIds'] = [targetConfigurationId];

  return {
    endpoint: 'storage_assignment',
    method: 'POST',
    path: autoDerivePath('ctos'),
    query: {
      configurationId: targetConfigurationId,
      guideMode: workspace.validationMode === 'guided',
    },
    body,
  };
}

/** Validates one full assignment target while retaining workspace-wide derived patches. */
export function parseStorageAssignmentResponse(
  raw: unknown,
  targetConfigurationId: string,
  networkName: string | null,
): StorageAssignmentResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('DCSC storage assignment returned a non-object response. No local state was changed.');
  }
  const response = raw as Record<string, unknown>;
  if (!Array.isArray(response['configurations']) || response['configurations'].length === 0) {
    throw new Error('DCSC storage assignment did not return exactly one configuration matching the target. No local state was changed.');
  }
  if (response['configurations'].some(candidate => candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))) {
    throw new Error('DCSC storage assignment returned an invalid configuration. No local state was changed.');
  }
  const matches = (response['configurations'] as RawConfiguration[]).filter(candidate => candidate.id === targetConfigurationId);
  if (matches.length !== 1) {
    throw new Error(`DCSC storage assignment returned ${matches.length} matching configurations instead of ${targetConfigurationId}. No local state was changed.`);
  }
  const configuration = matches[0]!;
  const expected = selectedName(networkName);
  if (configuration.selectedStorageNetwork !== expected) {
    throw new Error(`DCSC storage assignment returned selectedStorageNetwork ${JSON.stringify(configuration.selectedStorageNetwork)} instead of ${JSON.stringify(expected)}. No local state was changed.`);
  }
  if (!Array.isArray(configuration.tabs) || !Array.isArray(configuration.connectors)) {
    throw new Error('DCSC storage assignment returned an incomplete configuration without tabs and connectors. No local state was changed.');
  }
  const responseState = structuredClone(response);
  delete responseState['configurations'];
  return { configuration: structuredClone(configuration), responseState };
}
