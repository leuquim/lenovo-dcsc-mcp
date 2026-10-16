import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  buildStorageAssignmentRequest,
  parseStorageAssignmentResponse,
} from '../src/domain/storageAssignment.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { buildIndex } from '../src/model/index.js';
import type { RawConfiguration } from '../src/model/types.js';
import type { ConfigSession, WorkspaceSession } from '../src/session/SessionStore.js';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/parity/storage-controller-customization.json', import.meta.url),
  'utf8',
)) as Record<string, unknown>;
const SERVER_ID = 'server-id';
const RACK_ID = 'rack-id';
const CONTROLLER_ID = 'storage-controller-id';

function session(id: string, code: string, type: string): ConfigSession {
  const raw: RawConfiguration = {
    id,
    workspaceId: id,
    sliceCtoCode: code,
    code,
    description: code,
    type,
    quantity: 1,
    totalPrice: 100,
    selectedStorageNetwork: null,
    connectors: type === 'server' ? [{ sourceFeature: 'ATZV', portNumber: '1' }] : [],
    tabs: [{ title: 'Base', subTabs: [{ title: 'Base', sections: [] }] }],
  };
  return {
    id: `session-${id}`,
    workspaceId: 'workspace-storage',
    locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
    solution: { solutionMode: 'HPC and AI - Systems', masterSlices: ['HPCGP', 'HPCGPALL', 'HPCGPRYO'] },
    product: { code, description: code, type },
    mode: 'cto',
    validationMode: 'guided',
    autoCorrect: true,
    raw,
    configurationId: id,
    reduced: reduceConfiguration(raw, id, 'cto', 'HPC and AI - Systems'),
    primed: true,
    configurable: true,
    index: buildIndex(raw),
    revision: 1,
    intents: [],
    snapshots: [],
    createdAt: 1,
    lastAccessAt: 1,
    pricedAt: 1,
  };
}

function workspace(): WorkspaceSession {
  const server = session(SERVER_ID, '7D73CTOHWW', 'server');
  const rack = session(RACK_ID, '7D6DCTO1WW', 'rack');
  const controller = session(CONTROLLER_ID, '7DJ0CTO1WW', 'storage');
  return {
    id: 'workspace-storage',
    locale: server.locale,
    solution: server.solution,
    validationMode: 'guided',
    configurations: new Map([[server.id, server], [rack.id, rack], [controller.id, controller]]),
    racks: new Map(),
    rackArea: [{ id: RACK_ID, code: '7D6DCTO1WW', type: 'rack', size: 42, rackItems: [] }],
    nonRackArea: [{ id: SERVER_ID, code: '7D73CTOHWW', type: 'server' }],
    serverState: {
      storageConnectionNetworks: [{
        name: 'Parity Storage Assigned', maximumExpansions: 0,
        type: 'General Storage', layout: 'Fully Redundant',
        controller: { option: '7DJ0CTO1WW', featureCode: '', id: CONTROLLER_ID, hardwareType: 'storage' },
        expansion: {}, mainSwitch: { hardwareType: 'switch' },
      }],
    },
    rackSummaries: [],
    cables: [],
    floorItems: [],
    powerSelections: [],
    integrity: 'verified',
    integrityWarnings: [],
    revision: 1,
    createdAt: 1,
    lastAccessAt: 1,
    pricedAt: 1,
  };
}

describe('storage assignment wire contract', () => {
  it('derives the exact target with the complete workspace as context', () => {
    const ws = workspace();
    const before = structuredClone(ws);
    const request = buildStorageAssignmentRequest(ws, SERVER_ID, 'Parity Storage Assigned');
    const configurations = request.body['configurations'] as Array<Record<string, unknown>>;
    const byId = new Map(configurations.map((configuration) => [configuration['id'], configuration]));
    const expected = fixture['serverAssignment'] as Record<string, unknown>;

    expect(request).toMatchObject({
      endpoint: 'storage_assignment', method: 'POST', path: '/ctos/autoDerive',
      query: { configurationId: SERVER_ID, guideMode: true },
    });
    expect(request.body['customizingIds']).toEqual([SERVER_ID]);
    expect(configurations.map((configuration) => configuration['ctoCode']))
      .toEqual((expected['request'] as Record<string, unknown>)['configurationCodes']);
    expect(byId.get(SERVER_ID)?.['selectedStorageNetwork']).toBe('Parity Storage Assigned');
    expect(byId.get(RACK_ID)?.['selectedStorageNetwork']).toBeNull();
    expect(byId.get(CONTROLLER_ID)?.['selectedStorageNetwork']).toBeNull();
    expect(request.body['workspaceInformation']).not.toHaveProperty('selectedStorageNetwork');
    const physical = (request.body['workspaceInformation'] as Record<string, unknown>)['nonRackData'];
    expect(physical).toMatchObject([{ id: SERVER_ID, code: '7D73CTOHWW' }]);
    expect(JSON.stringify(physical)).not.toContain(CONTROLLER_ID);
    expect(ws).toEqual(before);
  });

  it('encodes No storage networking as an empty target string', () => {
    const request = buildStorageAssignmentRequest(workspace(), SERVER_ID, null);
    const target = (request.body['configurations'] as Array<Record<string, unknown>>)
      .find((configuration) => configuration['id'] === SERVER_ID);
    expect(target?.['selectedStorageNetwork']).toBe('');
  });

  it('parses only the exact complete target and retains response metadata', () => {
    const response = {
      configurations: [{
        ...workspace().configurations.get(`session-${SERVER_ID}`)!.raw,
        selectedStorageNetwork: 'Parity Storage Assigned',
      }],
      placementResults: [{ workspaceId: SERVER_ID }],
    };
    const result = parseStorageAssignmentResponse(response, SERVER_ID, 'Parity Storage Assigned');
    expect(result.configuration).toMatchObject({
      id: SERVER_ID, selectedStorageNetwork: 'Parity Storage Assigned',
    });
    expect(result.responseState).toEqual({ placementResults: [{ workspaceId: SERVER_ID }] });
    response.configurations[0]!.selectedStorageNetwork = 'changed later';
    expect(result.configuration.selectedStorageNetwork).toBe('Parity Storage Assigned');
  });

  it('accepts one target among workspace patches and rejects duplicate target identities', () => {
    const target = { ...workspace().configurations.get(`session-${SERVER_ID}`)!.raw, selectedStorageNetwork: '' };
    const controller = workspace().configurations.get(`session-${CONTROLLER_ID}`)!.raw;
    expect(parseStorageAssignmentResponse({ configurations: [controller, target] }, SERVER_ID, null).configuration)
      .toEqual(target);
    expect(() => parseStorageAssignmentResponse({ configurations: [target, target] }, SERVER_ID, null))
      .toThrow('2 matching configurations');
  });

  it('rejects unknown choices, unsupported targets, and mismatched responses', () => {
    const ws = workspace();
    expect(() => buildStorageAssignmentRequest(ws, 'missing', 'Parity Storage Assigned'))
      .toThrow(/target missing is unknown/i);
    expect(() => buildStorageAssignmentRequest(ws, RACK_ID, 'Parity Storage Assigned'))
      .toThrow(/available on server/i);
    expect(() => buildStorageAssignmentRequest(ws, SERVER_ID, 'Missing SAN'))
      .toThrow(/Unknown storage network.*Parity Storage Assigned/i);
    ws.configurations.get(`session-${CONTROLLER_ID}`)!.mode = 'lfo';
    expect(() => buildStorageAssignmentRequest(ws, SERVER_ID, 'Parity Storage Assigned'))
      .toThrow(/CTO-only/i);

    expect(() => parseStorageAssignmentResponse({}, SERVER_ID, 'Parity Storage Assigned'))
      .toThrow(/exactly one configuration/i);
    expect(() => parseStorageAssignmentResponse({ configurations: [{
      id: 'other', tabs: [], connectors: [], selectedStorageNetwork: 'Parity Storage Assigned',
    }] }, SERVER_ID, 'Parity Storage Assigned')).toThrow(/instead of server-id/i);
    expect(() => parseStorageAssignmentResponse({ configurations: [{
      id: SERVER_ID, tabs: [], connectors: [], selectedStorageNetwork: 'Other',
    }] }, SERVER_ID, 'Parity Storage Assigned')).toThrow(/selectedStorageNetwork/i);
    expect(() => parseStorageAssignmentResponse({ configurations: [{
      id: SERVER_ID, selectedStorageNetwork: 'Parity Storage Assigned',
    }] }, SERVER_ID, 'Parity Storage Assigned')).toThrow(/without tabs and connectors/i);
  });
});
