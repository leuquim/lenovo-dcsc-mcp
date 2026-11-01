import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { hydrateImportedLayout, mergeImportedState } from '../src/domain/importLayout.js';
import { buildFloorState } from '../src/domain/floorWire.js';
import type { DcscHttpClient, RequestCtx, SendInput } from '../src/http/request.js';
import type { WorkspaceSession } from '../src/model/session.js';

type Obj = Record<string, unknown>;
const fixture = JSON.parse(readFileSync('test/fixtures/parity/import-layout.json', 'utf8')) as Obj;
const nestedFixture = JSON.parse(readFileSync('test/fixtures/parity/nested-import-layout.json', 'utf8')) as Obj;
const looseNestedFixture = JSON.parse(
  readFileSync('test/fixtures/parity/nested-loose-import-layout.json', 'utf8'),
) as Obj;
const nativeRackedImportShape = (JSON.parse(
  readFileSync('test/fixtures/parity/nested-removal-contracts.json', 'utf8'),
) as Obj)['nativeRackedImportShape'] as Obj;
const ctx = { corrId: 'import-layout-test', locale: {
  country: 'US', geo: 'NA', language: 'en', currency: 'USD',
}, solution: { solutionMode: 'General Purpose', masterSlices: ['GP', 'HPCGPALL', 'HPCGPRYO'] } } as RequestCtx;

function workspace(payload = fixture): WorkspaceSession {
  const configurations = new Map<string, never>();
  for (const raw of payload['configuration'] as Obj[]) {
    const id = String(raw['id']);
    configurations.set(id, { configurationId: id, raw } as never);
  }
  return {
    id: 'ws-import', locale: ctx.locale, solution: ctx.solution!, validationMode: 'guided',
    configurations, racks: new Map(), rackArea: [], nonRackArea: [], serverState: {},
    rackSummaries: [], cables: [], floorItems: [], powerSelections: [], integrity: 'verified',
    integrityWarnings: [], revision: 1, createdAt: 1, lastAccessAt: 1, pricedAt: 1,
  } as WorkspaceSession;
}

function fakeHttp(calls: SendInput[], omitCode?: string): DcscHttpClient {
  return { send: async (input: SendInput) => {
    calls.push(input);
    const requested = input.body?.kind === 'json' ? input.body.value as Array<Obj> : [];
    const raw = requested.filter((entry) => entry['code'] !== omitCode).map((entry) => ({
      code: entry['code'], type: entry['type'], size: entry['type'] === 'rack' ? 42 : entry['type'] === 'chassis' ? 2 : 1,
      weight: entry['type'] === 'rack' ? 120 : 18, depth: 1000,
      description: `Envelope ${String(entry['code'])}`, serverEnvelopeField: true,
    }));
    return { status: 200, headers: {}, requestId: undefined, traceId: undefined, durationMs: 1, raw };
  } } as unknown as DcscHttpClient;
}

describe('import physical layout hydration', () => {
  it('initializes absent floor metadata using the native hierarchy position codes', async () => {
    const native = JSON.parse(readFileSync('test/fixtures/parity/xconfig-import-layout.json', 'utf8')) as Obj;
    const draft = workspace(native);
    const http = { send: async () => ({ raw: native['envelopes'] }) } as unknown as DcscHttpClient;
    await hydrateImportedLayout(http, ctx, draft, native);
    expect(draft.floorItems).toEqual(native['expectedFloor']);
    const items = draft.rackArea.flatMap(r => r['rackItems'] as Obj[]);
    expect(items.map(i => Object.fromEntries(['id', 'code', 'type', 'size', 'position'].map(k => [k, i[k]]))))
      .toEqual(native['expectedItems']);
    expect(items[0]!['endPosition']).toBe(10);
    const invalid = structuredClone(native);
    const child = (((invalid['workspace'] as Obj)['rackArea'] as Obj[])[0]!['children'] as Obj[])[0]!;
    child['derivedResults'] = [];
    const rejected = workspace(invalid);
    await expect(hydrateImportedLayout(http, ctx, rejected, invalid)).rejects.toThrow('unambiguous native U-position');
    expect(rejected.rackArea).toEqual([]);
    expect(rejected.floorItems).toEqual([]);
    const partial = structuredClone(native); partial['floorInformation'] = { floorGrid: [] };
    await expect(hydrateImportedLayout(http, ctx, workspace(partial), partial)).rejects.toThrow('placement metadata');
  });
  it('restores captured rack/child identities, quantities and exact positions from the floor report', async () => {
    const draft = workspace();
    const calls: SendInput[] = [];
    await hydrateImportedLayout(fakeHttp(calls), ctx, draft, structuredClone(fixture));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/ctos/racks/customize/non_rack');
    expect(draft.floorItems).toEqual([{ id: 'US__rack-1', rackId: 'US__rack-1', x: 0, y: 0 }]);
    expect(draft.rackArea[0]).toMatchObject({
      id: 'US__rack-1', configurationId: 'US__rack-1', code: '7D6DCTO1WW',
      quantity: 1, serverEnvelopeField: true,
    });
    expect((draft.rackArea[0]?.['rackItems'] as Obj[])[0]).toMatchObject({
      id: 'US__server-1', configurationId: 'US__server-1', code: '7D73CTO1WW',
      quantity: 2, position: 3, endPosition: 3, serverEnvelopeField: true,
      derivedResults: [{ featureCode: '3201', quantity: '1' }],
    });
  });

  it('hydrates non-rack items without inventing a rack U position', async () => {
    const payload = structuredClone(fixture);
    const importedWorkspace = payload['workspace'] as Obj;
    const rack = (importedWorkspace['rackArea'] as Obj[])[0]!;
    const server = (rack['children'] as Obj[])[0]!;
    importedWorkspace['rackArea'] = [];
    importedWorkspace['floorItems'] = [];
    importedWorkspace['nonRackArea'] = [server];
    (payload['floorInformation'] as Obj)['floorGrid'] = [];
    const draft = workspace(payload);

    await hydrateImportedLayout(fakeHttp([]), ctx, draft, payload);

    expect(draft.rackArea).toEqual([]);
    expect(draft.floorItems).toEqual([]);
    expect(draft.nonRackArea[0]).toMatchObject({
      id: 'US__server-1', configurationId: 'US__server-1', quantity: 2,
    });
    expect(draft.nonRackArea[0]).not.toHaveProperty('position');
    expect(draft.nonRackArea[0]).not.toHaveProperty('endPosition');
  });

  it('converts SPA floor locks to canonical positions and projects them back without drift', async () => {
    const payload = structuredClone(fixture);
    const floor = (payload['floorInformation'] as Obj)['floorGrid'] as Obj[];
    floor[0]!['lockedSpace'] = [41];
    const hierarchyRack = ((payload['workspace'] as Obj)['rackArea'] as Obj[])[0]!;
    hierarchyRack['lockedSpace'] = [42];
    const draft = workspace(payload);

    await hydrateImportedLayout(fakeHttp([]), ctx, draft, payload);

    expect(draft.rackArea[0]!['lockedSpace']).toEqual([42]);
    const projected = buildFloorState(draft).information['floorGrid'] as Obj[];
    expect(projected.find(cell => cell['id'] === 'US__rack-1')!['lockedSpace']).toEqual([41]);
  });

  it('keeps canonical hierarchy locks when the floor cell does not carry a lock projection', async () => {
    const payload = structuredClone(fixture);
    const floor = (payload['floorInformation'] as Obj)['floorGrid'] as Obj[];
    delete floor[0]!['lockedSpace'];
    const hierarchyRack = ((payload['workspace'] as Obj)['rackArea'] as Obj[])[0]!;
    hierarchyRack['lockedSpace'] = [42];
    const draft = workspace(payload);

    await hydrateImportedLayout(fakeHttp([]), ctx, draft, payload);

    expect(draft.rackArea[0]!['lockedSpace']).toEqual([42]);
  });

  it('leaves the detached draft unchanged when a late envelope or position is missing', async () => {
    const missingEnvelopeDraft = workspace();
    const beforeEnvelope = structuredClone({
      rackArea: missingEnvelopeDraft.rackArea, nonRackArea: missingEnvelopeDraft.nonRackArea,
      floorItems: missingEnvelopeDraft.floorItems,
    });
    await expect(hydrateImportedLayout(
      fakeHttp([], '7D73CTO1WW'), ctx, missingEnvelopeDraft, structuredClone(fixture),
    )).rejects.toThrow(/no physical envelope/);
    expect({ rackArea: missingEnvelopeDraft.rackArea, nonRackArea: missingEnvelopeDraft.nonRackArea,
      floorItems: missingEnvelopeDraft.floorItems }).toEqual(beforeEnvelope);

    const missingPosition = structuredClone(fixture);
    const floor = (missingPosition['floorInformation'] as Obj)['floorGrid'] as Obj[];
    delete ((floor[0]?.['items'] as Obj[])[0]!)['position'];
    const missingPositionDraft = workspace(missingPosition);
    await expect(hydrateImportedLayout(
      fakeHttp([]), ctx, missingPositionDraft, missingPosition,
    )).rejects.toThrow(/no usable physical position/);
    expect(missingPositionDraft.rackArea).toEqual([]);
    expect(missingPositionDraft.floorItems).toEqual([]);
  });

  it('hydrates the captured rack -> chassis -> copied-node hierarchy and preserves the loose source', async () => {
    const draft = workspace(nestedFixture);
    await hydrateImportedLayout(fakeHttp([]), ctx, draft, structuredClone(nestedFixture));

    const chassis = (draft.rackArea[0]?.['rackItems'] as Obj[])[0]!;
    const node = (chassis['nodes'] as Obj[])[0]!;
    expect(chassis).toMatchObject({
      id: 'US__e24502d5-2f5d-4b89-8073-620bd4dd38720', code: '7DD0CTOLWW',
      type: 'chassis', position: 1, endPosition: 2, serverEnvelopeField: true,
    });
    expect(node).toMatchObject({
      id: '8ee40827-b01d-4208-99bc-55c8cc5464cf', configurationId: '8ee40827-b01d-4208-99bc-55c8cc5464cf',
      code: '7DD1CTOLWW', type: 'node', position: 1, occupiedBay: 1, quantity: 1,
      serverEnvelopeField: true,
    });
    expect(node['children']).toBeUndefined();
    expect(draft.nonRackArea).toEqual([expect.objectContaining({
      id: 'US__97b6a1b5-5c0a-4562-afa1-4fa5401227101', code: '7DD1CTOLWW', type: 'node',
    })]);

    // Floor position is retained as a display/ordering coordinate. The copied
    // node's chassis bay comes from the slim nested hierarchy, not that floor field.
    const moved = structuredClone(nestedFixture);
    const movedCell = ((moved['floorInformation'] as Obj)['floorGrid'] as Obj[])[0]!;
    ((((movedCell['items'] as Obj[])[0]!['nodes']) as Obj[])[0]!)['position'] = 2;
    const movedDraft = workspace(moved);
    await hydrateImportedLayout(fakeHttp([]), ctx, movedDraft, moved);
    const movedChassis = (movedDraft.rackArea[0]?.['rackItems'] as Obj[])[0]!;
    expect((movedChassis['nodes'] as Obj[])[0]).toMatchObject({ position: 2, occupiedBay: 1 });
  });

  it('hydrates a native racked child when CFXML import omits the chassis node-location collection', async () => {
    expect(nativeRackedImportShape['floorChassisNodesPresent']).toBe(false);
    const nativeShape = structuredClone(nestedFixture);
    const cell = ((nativeShape['floorInformation'] as Obj)['floorGrid'] as Obj[])[0]!;
    const chassisLocation = ((cell['items'] as Obj[])[0]!);
    delete chassisLocation['nodes'];
    const hierarchyRack = ((nativeShape['workspace'] as Obj)['rackArea'] as Obj[])[0]!;
    const hierarchyChassis = ((hierarchyRack['children'] as Obj[])[0]!);
    expect(((hierarchyChassis['children'] as Obj[])[0]!)['size'])
      .toBe(nativeRackedImportShape['hierarchyNodeSize']);
    const draft = workspace(nativeShape);

    await hydrateImportedLayout(fakeHttp([]), ctx, draft, nativeShape);

    const chassis = (draft.rackArea[0]?.['rackItems'] as Obj[])[0]!;
    expect((chassis['nodes'] as Obj[])[0]).toMatchObject({
      id: '8ee40827-b01d-4208-99bc-55c8cc5464cf',
      type: 'node', occupiedBay: nativeRackedImportShape['customizeAcceptedOccupiedBay'], quantity: 1,
    });
  });

  it('hydrates the captured loose chassis -> copied-node hierarchy without inventing a rack position', async () => {
    const draft = workspace(looseNestedFixture);
    await hydrateImportedLayout(fakeHttp([]), ctx, draft, structuredClone(looseNestedFixture));

    expect(draft.rackArea).toEqual([expect.objectContaining({
      id: 'US__3009f65b-3ed0-4224-a585-09693b898adc2', rackItems: [],
    })]);
    const chassis = draft.nonRackArea.find(item => item['type'] === 'chassis')!;
    const node = (chassis['nodes'] as Obj[])[0]!;
    expect(chassis).toMatchObject({
      id: 'US__461cd0f2-54f6-43d2-9fcf-22136b0870d10', type: 'chassis',
      configurationId: 'US__461cd0f2-54f6-43d2-9fcf-22136b0870d10', serverEnvelopeField: true,
    });
    expect(chassis['children']).toBeUndefined();
    expect(node).toMatchObject({
      id: 'US__-2257-4792-b07e-bf5c6d814da41000',
      configurationId: 'US__-2257-4792-b07e-bf5c6d814da41000',
      code: '7DD1CTOLWW', type: 'node', occupiedBay: 1, quantity: 1, serverEnvelopeField: true,
    });
    expect(node['children']).toBeUndefined();
    expect(draft.nonRackArea).toContainEqual(expect.objectContaining({
      id: 'US__e6b74296-7cc5-4e2b-9cb7-c3d51224e4141', type: 'node',
    }));
  });

  it('rejects a loose non-chassis container with nested nodes atomically', async () => {
    const malformed = structuredClone(looseNestedFixture);
    const loose = ((malformed['workspace'] as Obj)['nonRackArea'] as Obj[]);
    const chassis = loose.find(item => item['type'] === 'chassis')!;
    chassis['type'] = 'server';
    const draft = workspace(malformed);
    await expect(hydrateImportedLayout(fakeHttp([]), ctx, draft, malformed)).rejects.toThrow(/not a chassis/);
    expect(draft.rackArea).toEqual([]);
    expect(draft.nonRackArea).toEqual([]);
    expect(draft.floorItems).toEqual([]);
  });

  it('rejects a loose chassis child without captured bay metadata atomically', async () => {
    const malformed = structuredClone(looseNestedFixture);
    const loose = ((malformed['workspace'] as Obj)['nonRackArea'] as Obj[]);
    const chassis = loose.find(item => item['type'] === 'chassis')!;
    delete ((chassis['children'] as Obj[])[0]!)['size'];
    const draft = workspace(malformed);
    await expect(hydrateImportedLayout(fakeHttp([]), ctx, draft, malformed))
      .rejects.toThrow(/no usable occupied bay/);
    expect(draft.rackArea).toEqual([]);
    expect(draft.nonRackArea).toEqual([]);
    expect(draft.floorItems).toEqual([]);
  });

  it('rejects missing or unmatched nested-node placement metadata without publishing a partial rack', async () => {
    const missingBay = structuredClone(nestedFixture);
    const cell = ((missingBay['floorInformation'] as Obj)['floorGrid'] as Obj[])[0]!;
    const node = (((cell['items'] as Obj[])[0]!['nodes'] as Obj[])[0]!);
    delete node['position'];
    const hierarchyRack = ((missingBay['workspace'] as Obj)['rackArea'] as Obj[])[0]!;
    delete ((((hierarchyRack['children'] as Obj[])[0]!['children']) as Obj[])[0]!)['size'];
    const missingDraft = workspace(missingBay);
    await expect(hydrateImportedLayout(fakeHttp([]), ctx, missingDraft, missingBay))
      .rejects.toThrow(/no usable occupied bay/);
    expect(missingDraft.rackArea).toEqual([]);

    const unknown = structuredClone(nestedFixture);
    const unknownCell = ((unknown['floorInformation'] as Obj)['floorGrid'] as Obj[])[0]!;
    ((((unknownCell['items'] as Obj[])[0]!['nodes']) as Obj[])[0]!)['id'] = 'unknown-node';
    const unknownDraft = workspace(unknown);
    await expect(hydrateImportedLayout(fakeHttp([]), ctx, unknownDraft, unknown))
      .rejects.toThrow(/has no placement metadata/);
    expect(unknownDraft.rackArea).toEqual([]);

    const wrongParent = structuredClone(nestedFixture);
    const wrongRack = ((wrongParent['workspace'] as Obj)['rackArea'] as Obj[])[0]!;
    ((wrongRack['children'] as Obj[])[0]!)['type'] = 'server';
    const wrongDraft = workspace(wrongParent);
    await expect(hydrateImportedLayout(fakeHttp([]), ctx, wrongDraft, wrongParent))
      .rejects.toThrow(/not a chassis/);
    expect(wrongDraft.rackArea).toEqual([]);
  });

  it('rejects uncaptured VLH and deeper-than-node container contracts instead of inventing layout', async () => {
    const vlh = structuredClone(fixture);
    ((vlh['workspace'] as Obj)['rackArea'] as Obj[])[0]!['asVLH'] = true;
    await expect(hydrateImportedLayout(fakeHttp([]), ctx, workspace(vlh), vlh)).rejects.toThrow(/VLH.*captured/);

    const deeper = structuredClone(nestedFixture);
    const rack = ((deeper['workspace'] as Obj)['rackArea'] as Obj[])[0]!;
    const chassis = (rack['children'] as Obj[])[0]!;
    const node = (chassis['children'] as Obj[])[0]!;
    node['children'] = [{ id: 'grandchild' }];
    await expect(hydrateImportedLayout(fakeHttp([]), ctx, workspace(deeper), deeper)).rejects.toThrow(/captured chassis/);
  });
});

describe('import envelope merge', () => {
  it('preserves opaque response fields and combines disjoint existing state', () => {
    const draft = workspace();
    draft.serverState = { existingOpaque: { kept: true }, networkingInformation: { existing: true } };
    mergeImportedState(draft, structuredClone(fixture));
    expect(draft.serverState).toMatchObject({
      existingOpaque: { kept: true },
      futureImportField: { preserved: true },
      networkingInformation: { existing: true, futureNetworkField: { preserved: true } },
      workspace: { cloneRackMapping: { opaque: 'preserved' } },
    });
  });

  it('rejects locale, solution, product identity, and existing setting conflicts atomically', () => {
    for (const mutate of [
      (payload: Obj) => { payload['currency'] = 'EUR'; },
      (payload: Obj) => { (payload['configurationMode'] as Obj)['mode'] = 'HPC and AI - Systems'; },
      (payload: Obj) => { (payload['configurationMode'] as Obj)['masterSlices'] = ['WRONG']; },
      (payload: Obj) => { ((payload['configuration'] as Obj[])[0]!)['sliceCtoCode'] = 'WRONG'; },
    ]) {
      const payload = structuredClone(fixture);
      mutate(payload);
      const draft = workspace();
      const before = structuredClone(draft.serverState);
      expect(() => mergeImportedState(draft, payload)).toThrow(/conflict/);
      expect(draft.serverState).toEqual(before);
    }

    const draft = workspace();
    draft.serverState = { floorInformation: { floorGridSettings: { colCount: 9 } } };
    expect(() => mergeImportedState(draft, structuredClone(fixture))).toThrow(/floorGridSettings/);
    expect(draft.serverState).toEqual({ floorInformation: { floorGridSettings: { colCount: 9 } } });
  });
});
