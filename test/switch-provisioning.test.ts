import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  buildGeneratedSwitch,
  buildSwitchCalculationRequest,
  parseSwitchCalculationResponse,
  SWITCH_PROVISIONING_SEQUENCE,
} from '../src/domain/switchProvisioning.js';

type Obj = Record<string, unknown>;

const fixture = JSON.parse(readFileSync('test/fixtures/parity/switch-provisioning.json', 'utf8')) as {
  workspace: Obj;
  calculationResponse: unknown;
  launch: Obj;
  expectedGenerated: {
    id: string;
    name: string;
    rackId: string;
    requestedPosition: number;
    wireSectionNames: string[];
    rackItem: Obj;
    switchMapEntry: Obj;
    cloneDependency: Obj;
  };
  sequence: Array<{ phase: string; method: string; path: string }>;
};

describe('automatic switch calculation wire contract', () => {
  it('projects exactly the fields posted by the browser', () => {
    const request = buildSwitchCalculationRequest(fixture.workspace);
    expect(Object.keys(request)).toEqual([
      'rackArea', 'nonRackArea', 'configurations', 'clusterPreference', 'floorPreference',
      'powerPreference', 'floorItems', 'cloneRackMapping', 'storageConnectionNetworks',
      'switchMap', 'cloneDependency',
    ]);
    expect(request.rackArea).toEqual(fixture.workspace['rackArea']);
    expect(request.clusterPreference).toEqual(fixture.workspace['clusterPreference']);
    expect(request).not.toHaveProperty('autoConnectSettings');
    expect(request).not.toHaveProperty('connections');
    expect(request).not.toHaveProperty('futureWorkspaceField');
  });

  it('validates target rack and fresh generated-switch identity semantics', () => {
    const request = buildSwitchCalculationRequest(fixture.workspace);
    const [requirement] = parseSwitchCalculationResponse(fixture.calculationResponse, request);
    expect(requirement).toMatchObject({
      rackId: 'rack-1', rackCode: '7D6DCTO1WW', rackSize: 42,
      option: '7D5FCTOFWW', rawCode: '7D5FCTOFWW', type: 'switch',
      network: 'Management', usage: 'main', quantity: 1, position: 22, size: 1,
    });

    expect(() => parseSwitchCalculationResponse([{
      id: 'foreign-rack', option: 'RACK', size: 42, items: [],
    }], request)).toThrow(/unknown rack id foreign-rack/);
    expect(() => parseSwitchCalculationResponse([{
      id: 'rack-1', option: '7D6DCTO1WW', size: 42,
      items: [{
        id: 'manual-switch-1', option: '7D5FCTOFWW', rawCode: '7D5FCTOFWW', size: 1,
        type: 'switch', network: 'Management', usage: 'main', quantity: 1, position: 22,
      }],
    }], request)).toThrow(/unexpectedly has an id/);
  });
});

describe('generated switch descriptor', () => {
  it('uses one fresh id for configuration, rack item, switch map and clone dependency', () => {
    const request = buildSwitchCalculationRequest(fixture.workspace);
    const requirement = parseSwitchCalculationResponse(fixture.calculationResponse, request)[0]!;
    const generated = buildGeneratedSwitch(requirement, fixture.launch, {
      id: fixture.expectedGenerated.id,
    });

    expect(generated).toMatchObject({
      id: fixture.expectedGenerated.id,
      name: fixture.expectedGenerated.name,
      rackId: fixture.expectedGenerated.rackId,
      requestedPosition: fixture.expectedGenerated.requestedPosition,
      rackItem: fixture.expectedGenerated.rackItem,
      switchMapEntry: fixture.expectedGenerated.switchMapEntry,
      cloneDependency: fixture.expectedGenerated.cloneDependency,
    });
    expect(generated.configuration['id']).toBe(fixture.expectedGenerated.id);
    expect(generated.configuration['name']).toBe(fixture.expectedGenerated.name);
    expect(generated.wireConfiguration.id).toBe(fixture.expectedGenerated.id);
    expect(generated.wireConfiguration.sections.map((section) => section.name))
      .toEqual(fixture.expectedGenerated.wireSectionNames);
    expect((generated.rackItem['features'] as Array<{ name: string }>).map((section) => section.name))
      .toEqual(fixture.expectedGenerated.wireSectionNames);
  });

  it('rejects a launch for a different product or hardware type', () => {
    const requirement = parseSwitchCalculationResponse(fixture.calculationResponse)[0]!;
    expect(() => buildGeneratedSwitch(requirement, { ...fixture.launch, code: 'OTHER', sliceCtoCode: 'OTHER' }, {
      id: 'generated-switch-1',
    })).toThrow(/does not match calculated option/);
    expect(() => buildGeneratedSwitch(requirement, { ...fixture.launch, type: 'server' }, {
      id: 'generated-switch-1',
    })).toThrow(/not switch/);
  });
});

it('records the browser-authoritative automatic-switch and P2P sequence', () => {
  expect(SWITCH_PROVISIONING_SEQUENCE.map(({ phase, method, path }) => ({ phase, method, path })))
    .toEqual(fixture.sequence);
  expect(SWITCH_PROVISIONING_SEQUENCE[1]?.query).toEqual({
    serviceCto: true, serviceType: 'servicecto', controlExpressModal: false,
  });
  expect(SWITCH_PROVISIONING_SEQUENCE[2]?.query).toEqual({
    autoArrange: true, autoConnect: true, cogValidation: true,
  });
  expect(SWITCH_PROVISIONING_SEQUENCE[3]?.query).toEqual({ guideMode: true });
});
