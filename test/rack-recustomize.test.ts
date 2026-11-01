import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildRackRecustomizePlan,
  parseRackRecustomizeResult,
} from '../src/domain/rackRecustomize.js';
import { buildAutoDeriveRequest, buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import { buildIndex } from '../src/model/index.js';
import type { RawConfiguration } from '../src/model/types.js';
import type { ConfigSession, WorkspaceSession } from '../src/model/session.js';

const fixturePath = fileURLToPath(new URL('./fixtures/parity/rack-recustomize-contract.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
const RACK_ID = 'US__697d3063-73b6-43a2-ad2f-b1a6a78a8c2d0';
const SERVER_ID = 'US__b4c1cddd-19ce-46a5-aaaf-ecbbb62e78600';

function session(configurationId: string, code: string, type: string, mode: 'cto' | 'lfo' = 'cto'): ConfigSession {
  const raw: RawConfiguration = {
    id: configurationId,
    workspaceId: RACK_ID,
    sliceCtoCode: code,
    code,
    description: code,
    type,
    quantity: 1,
    totalPrice: 100,
    tabs: [{ title: 'Base', subTabs: [{ title: 'Base', sections: [] }] }],
  };
  return {
    id: `session-${configurationId}`,
    workspaceId: 'workspace-rack',
    locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
    solution: { solutionMode: 'General Purpose', masterSlices: ['GP', 'HPCGPALL', 'HPCGPRYO'] },
    product: { code, description: code, type },
    mode,
    validationMode: 'guided',
    autoCorrect: true,
    raw,
    configurationId,
    reduced: reduceConfiguration(raw, configurationId, mode, 'General Purpose'),
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
  const rack = session(RACK_ID, '7D6DCTO1WW', 'rack');
  const server = session(SERVER_ID, '7D73CTO1WW', 'server');
  return {
    id: 'workspace-rack',
    locale: rack.locale,
    solution: rack.solution,
    validationMode: 'guided',
    configurations: new Map([[rack.id, rack], [server.id, server]]),
    rackArea: [{ id: RACK_ID, code: '7D6DCTO1WW', type: 'rack', size: 42,
      rackItems: [{ id: SERVER_ID, code: '7D73CTO1WW', type: 'server', size: 1, position: 1 }] }],
    nonRackArea: [],
    serverState: {},
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

describe('rack recustomization contract', () => {
  it('projects browser filler selections before deriving a rack and exports matching physical metadata', () => {
    const ws = workspace();
    const captured = JSON.parse(readFileSync(new URL('./fixtures/parity/rack-filler-contract.json', import.meta.url), 'utf8'));
    const rack = [...ws.configurations.values()][0]!;
    rack.raw = { ...captured.configuration, id: RACK_ID, totalPrice: 100 };
    const before = structuredClone(ws);
    const bodies = [buildRackRecustomizePlan(ws, RACK_ID).body,
      buildAutoDeriveRequest(ws, { validationMode: 'guided' })];
    for (const body of bodies) {
      const target = (body.configurations as Array<Record<string, unknown>>).find(item => item.id === RACK_ID)!;
      expect(target.sections).toEqual(expect.arrayContaining([expect.objectContaining({
        name: 'MECH_DERIVE_FCS', results: captured.expected.results,
      })]));
      expect((body.workspaceInformation as { rackData: unknown[] }).rackData[0]).toMatchObject({
        filler: captured.expected.filler, baseFeatureCode: 'BHC3',
      });
    }
    const exported = buildExportData({ workspace: ws, solution: ws.solution,
      validationMode: 'guided', fileTypes: ['XML'] });
    expect((exported.workspaceInformation as { rackData: unknown[] }).rackData[0]).toMatchObject({
      filler: captured.expected.filler, baseFeatureCode: 'BHC3',
    });
    // Wire projection must never synthesize a price or publish a local selection.
    expect(ws).toEqual(before);
  });

  it('sends the complete workspace context while customizing only the chosen rack', () => {
    const ws = workspace();
    const plan = buildRackRecustomizePlan(ws, RACK_ID);
    const expected = fixture['request'] as Record<string, unknown>;
    const status = plan.body['statusRelatedResult'] as Record<string, unknown>;
    const configurations = plan.body['configurations'] as Array<Record<string, unknown>>;
    const workspaceInformation = plan.body['workspaceInformation'] as Record<string, unknown>;

    expect(plan).toMatchObject({
      endpoint: 'rack_recustomize', method: 'POST', path: '/ctos/autoDerive',
      query: { entranceFlag: 'customize', guideMode: true },
    });
    expect(configurations.map((item) => item['id'])).toEqual(expected['configurationIds']);
    expect(plan.body['customizingIds']).toEqual(expected['customizingIds']);
    expect(status['autoDerivedConfigurationIds']).toEqual(expected['statusAutoDerivedConfigurationIds']);
    expect(workspaceInformation['rackData']).toHaveLength(expected['rackCount'] as number);
    expect(workspaceInformation['nonRackData']).toHaveLength(expected['nonRackCount'] as number);
  });

  it('returns the complete matching replacement and preserves response metadata separately', () => {
    const response = fixture['response'] as Record<string, unknown>;
    const raw = {
      ...(response['metadata'] as Record<string, unknown>),
      configurations: [(response['configuration'] as Record<string, unknown>)],
    };
    const parsed = parseRackRecustomizeResult(raw, RACK_ID);

    expect(parsed.configuration).toMatchObject({
      id: RACK_ID,
      totalPrice: 12_706.51,
      unSelectableCharacters: [{
        name: 'MECH_DERIVE_FCS',
        results: [
          { code: '4275', quantity: 8 },
          { code: '4271', quantity: 1 },
        ],
      }],
    });
    expect(parsed.responseState).toEqual(response['metadata']);
    expect(parsed.responseState).not.toHaveProperty('configurations');

    (raw.configurations[0] as Record<string, unknown>)['totalPrice'] = 1;
    expect(parsed.configuration.totalPrice).toBe(12_706.51);
  });

  it('rejects non-racks, mixed hardware modes and incomplete or mismatched responses', () => {
    const ws = workspace();
    expect(() => buildRackRecustomizePlan(ws, SERVER_ID)).toThrow(/not an active physical rack/);
    [...ws.configurations.values()][1]!.mode = 'lfo';
    expect(() => buildRackRecustomizePlan(ws, RACK_ID)).toThrow(/CTO-only/);

    expect(() => parseRackRecustomizeResult({}, RACK_ID)).toThrow(/exactly one configuration/);
    expect(() => parseRackRecustomizeResult({ configurations: [
      { id: RACK_ID, tabs: [] }, { id: SERVER_ID, tabs: [] },
    ] }, RACK_ID)).toThrow(/exactly one configuration/);
    expect(() => parseRackRecustomizeResult({ configurations: [{ id: SERVER_ID, tabs: [] }] }, RACK_ID))
      .toThrow(/instead of/);
    expect(() => parseRackRecustomizeResult({ configurations: [{ id: RACK_ID }] }, RACK_ID))
      .toThrow(/without tabs/);
  });
});
