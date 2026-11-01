import { describe, expect, it } from 'vitest';

import { PAGE_BYTE_BUDGET } from '../src/config/constants.js';
import { jsonBytes } from '../src/util/jsonBytes.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import {
  projectWorkspaceLayout,
  projectWorkspaceIntegrity,
  projectWorkspacePage,
  projectWorkspaceSummary,
  workspaceDetailSource,
  workspaceProjectionTotals,
} from '../src/model/workspaceProjection.js';
import { buildIndex } from '../src/model/index.js';
import type { RawConfiguration } from '../src/model/types.js';
import type { ConfigSession, WorkspaceSession } from '../src/model/session.js';

function configuration(index: number): ConfigSession {
  const raw: RawConfiguration = {
    id: `configuration-${index}`,
    code: `NODE-${index}`,
    sliceCtoCode: `NODE-${index}`,
    quantity: (index % 4) + 1,
    totalPrice: 100 + index,
    tabs: [],
  };
  return {
    id: `session-${index}`,
    workspaceId: 'workspace-large',
    locale: { geo: 'NA', country: 'US', language: 'en', currency: 'USD' },
    solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
    product: { code: `NODE-${index}`, description: `Node ${index}`, type: 'server' },
    mode: 'cto', validationMode: 'guided', autoCorrect: true,
    raw, configurationId: `configuration-${index}`,
    reduced: reduceConfiguration(raw, `configuration-${index}`),
    primed: true, configurable: true, index: buildIndex(raw), revision: 1,
    intents: [], snapshots: [], createdAt: 1, lastAccessAt: 1, pricedAt: 1,
  };
}

function workspace(options: { configurations?: number; racks?: number; cables?: number } = {}): WorkspaceSession {
  const configurationCount = options.configurations ?? 120;
  const rackCount = options.racks ?? 70;
  const cableCount = options.cables ?? 240;
  const configurations = new Map(
    Array.from({ length: configurationCount }, (_, index) => {
      const session = configuration(index);
      return [session.id, session] as const;
    }),
  );
  return {
    id: 'workspace-large', locale: { geo: 'NA', country: 'US', language: 'en', currency: 'USD' },
    solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
    validationMode: 'guided', configurations, rackArea: [], nonRackArea: [], serverState: {},
    rackSummaries: Array.from({ length: rackCount }, (_, index) => ({
      id: `rack-${index}`, code: `RACK-${index}`, description: `Rack ${index}`,
      sizeU: 42, usedU: 2, freeU: 40, totalWeightKg: 120 + index,
      stableStatus: index % 11 === 0 ? 'WARNING' : 'PASSED',
      items: [
        { id: `configuration-${index % configurationCount}`, code: `NODE-${index}`, position: 1, endPosition: 1, sizeU: 1 },
        { id: `item-${index}`, code: `SWITCH-${index}`, position: 2, endPosition: 2, sizeU: 1 },
      ],
      errors: index % 13 === 0 ? [{ code: 'PLACEMENT', message: `Rack ${index} warning` }] : [],
    })),
    cables: Array.from({ length: cableCount }, (_, index) => ({
      id: `cable-${index}`, fromConfigId: `configuration-${index % configurationCount}`, fromPort: `p${index}`,
      toConfigId: `configuration-${(index + 1) % configurationCount}`, toPort: `p${index + 1}`,
      cableCode: `CABLE-${index}`, description: `Cable ${index}`,
    })),
    floorItems: Array.from({ length: rackCount }, (_, index) => ({ id: `floor-${index}`, rackId: `rack-${index}`, x: index, y: 0 })),
    powerSelections: Array.from({ length: rackCount }, (_, index) => ({ rackId: `rack-${index}`, pduCode: `PDU-${index}` })),
    integrity: 'verified', integrityWarnings: Array.from({ length: 40 }, (_, index) => `Warning ${index}`),
    revision: 9, createdAt: 1, lastAccessAt: 1, pricedAt: 1,
  };
}

const projectionOptions = {
  tool: 'dcsc_workspace_layout',
  arguments: { session: 'workspace-large' },
};

describe('bounded workspace projections', () => {
  it('keeps huge summary and layout responses small while reporting exact totals', () => {
    const ws = workspace();
    const summary = projectWorkspaceSummary(ws, { ...projectionOptions, tool: 'dcsc_session_info' });
    const layout = projectWorkspaceLayout(ws, projectionOptions);

    expect(jsonBytes(summary)).toBeLessThanOrEqual(PAGE_BYTE_BUDGET);
    expect(jsonBytes(layout)).toBeLessThanOrEqual(PAGE_BYTE_BUDGET);
    expect(summary['totals']).toEqual({
      configurations: 120, racks: 70, rackItems: 140, rackErrors: 6,
      unracked: 50, cables: 240, floorItems: 70, powerSelections: 70, storageNetworks: 0,
      cloneDependency: 0, cloneDependencyColor: 0,
      rawRackArea: 0, rawNonRackArea: 0, layoutErrors: 0,
      rawConnections: 0, autoConnectMessageGroups: 0, autoConnectMessages: 0,
      standaloneSoftware: 0, integrityWarnings: 40,
    });
    expect(layout['totals']).toEqual(summary['totals']);
    expect((summary['configurations'] as unknown[]).length).toBeGreaterThan(0);
    expect((layout['racks'] as unknown[]).length).toBeGreaterThan(0);
    expect((layout['racks'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      itemCount: 2,
    });
    expect((layout['stabilityWarning'] as string)).toContain('and 4 more');
    expect((summary['pages'] as Record<string, { inspect: { arguments: Record<string, unknown> } }>).cables!.inspect.arguments)
      .toEqual({ session: 'workspace-large', path: ['cables'], offset: 0, limit: 20 });
  });

  it('preserves complete small layouts and prices an independent software basket', () => {
    const ws = workspace({ configurations: 2, racks: 1, cables: 1 });
    ws.rackSummaries[0]!.errors = [{ code: 'WARN', message: 'Small warning' }];
    ws.serverState['standaloneSoftwareState'] = {
      kind: 'standalone-software',
      selections: [
        { id: 'sw-1', code: 'SW-A', quantity: 2, unitPrice: 30, totalPrice: 60, feature: { raw: { opaque: true } } },
        { id: 'sw-2', code: 'SW-B', quantity: 1 },
      ],
    };
    const layout = projectWorkspaceLayout(ws, projectionOptions);
    const rack = (layout['racks'] as Array<Record<string, unknown>>)[0]!;
    expect(rack).toMatchObject({
      itemCount: 2, itemsReturned: 2, itemsComplete: true,
      errorCount: 1, errorsReturned: 1, errorsComplete: true,
    });
    expect(rack['items']).toHaveLength(2);
    expect(rack['errors']).toEqual([
      expect.objectContaining({ code: 'WARN', message: 'Small warning' }),
    ]);

    const summary = projectWorkspaceSummary(ws, { ...projectionOptions, tool: 'dcsc_session_info' });
    const configurationSubtotal = [...ws.configurations.values()]
      .reduce((sum, session) => sum + session.raw.totalPrice! * session.raw.quantity!, 0);
    expect(summary).toMatchObject({
      totalPrice: null,
      knownPriceSubtotal: configurationSubtotal + 60,
      priceIncomplete: true,
      subtotals: { configurations: configurationSubtotal, standaloneSoftware: 60 },
      totals: { standaloneSoftware: 2 },
    });
    expect(summary['standaloneSoftware']).toHaveLength(2);
    const standalonePage = projectWorkspacePage(ws, {
      ...projectionOptions, path: ['standaloneSoftware'], offset: 0, limit: 20,
    });
    expect(standalonePage).toMatchObject({ total: 2, returned: 2 });
  });

  it('does not treat null, unavailable or non-finite prices as known zero', () => {
    const ws = workspace({ configurations: 3, racks: 0, cables: 0 });
    const sessions = [...ws.configurations.values()];
    (sessions[0]!.raw as unknown as Record<string, unknown>)['totalPrice'] = null;
    (sessions[1]!.raw as unknown as Record<string, unknown>)['priceNotAvailable'] = true;
    (sessions[2]!.raw as unknown as Record<string, unknown>)['totalPrice'] = Number.NaN;
    ws.serverState['standaloneSoftwareState'] = {
      selections: [
        { id: 'unavailable', code: 'SW-1', totalPrice: 90, priceNotAvailable: true },
        { id: 'feature-unavailable', code: 'SW-2', totalPrice: 80, feature: { priceNotAvailable: true } },
        { id: 'non-finite', code: 'SW-3', totalPrice: Number.POSITIVE_INFINITY },
      ],
    };
    const summary = projectWorkspaceSummary(ws, { ...projectionOptions, tool: 'dcsc_session_info' });
    expect(summary).toMatchObject({
      totalPrice: null,
      knownPriceSubtotal: 0,
      priceIncomplete: true,
      subtotals: { configurations: 0, standaloneSoftware: 0 },
    });
  });

  it('fails safely when scalar workspace context alone cannot fit', () => {
    const ws = workspace({ configurations: 2, racks: 0, cables: 0 });
    ws.id = 'workspace-'.repeat(1_000);
    expect(() => projectWorkspaceSummary(ws, {
      tool: 'dcsc_session_info',
      arguments: { session: ws.id, expectedRevision: ws.revision },
    })).toThrow('dcsc_recovery_export');
  });

  it('enumerates every collection page without gaps or duplicates', () => {
    const ws = workspace({ configurations: 67, racks: 29, cables: 113 });
    ws.serverState.cloneDependency = Object.fromEntries(Array.from({ length: 60 }, (_, index) =>
      [`root-${index}`, [`root-${index}`, `child-${index}`]]));
    ws.serverState.cloneDependencyColor = Object.fromEntries(Array.from({ length: 60 }, (_, index) =>
      [`root-${index}`, { dependBy: [`root-${index}`, `child-${index}`], colorRGB: { r: index, g: 10, b: 20 } }]));
    const source = workspaceDetailSource(ws);
    const layout = projectWorkspaceLayout(ws, projectionOptions);
    for (const field of ['cloneDependency', 'cloneDependencyColor']) {
      expect(layout).toHaveProperty(`pages.${field}.inspect.arguments.path`, [field]);
    }

    for (const path of ['configurations', 'racks', 'unracked', 'cables', 'floorItems', 'powerSelections', 'integrityWarnings',
      'cloneDependency', 'cloneDependencyColor']) {
      const expected = source[path] as Record<string, unknown>;
      const keys: string[] = [];
      const values: Record<string, unknown> = {};
      let offset = 0;
      for (;;) {
        const page = projectWorkspacePage(ws, {
          ...projectionOptions, path: [path], offset, limit: 17,
        }) as { items: Array<{ key: string; value?: unknown }>; next?: { arguments: { offset: number } } };
        expect(jsonBytes(page)).toBeLessThanOrEqual(PAGE_BYTE_BUDGET);
        keys.push(...page.items.map(item => item.key));
        for (const item of page.items) values[item.key] = item.value;
        if (!page.next) break;
        offset = page.next.arguments.offset;
      }
      expect(keys).toEqual(Object.keys(expected));
      expect(new Set(keys).size).toBe(Object.keys(expected).length);
      if (path.startsWith('cloneDependency')) expect(values).toEqual(expected);
    }

    expect(workspaceProjectionTotals(source)).toMatchObject({
      configurations: 67, racks: 29, cables: 113,
    });
  });

  it('exposes an oversized individual cable and reconstructs its long field exactly', () => {
    const ws = workspace({ configurations: 2, racks: 1, cables: 1 });
    const description = '🔌'.repeat(8_000);
    ws.cables[0]!.description = description;
    (ws.cables[0] as unknown as Record<string, unknown>)['futureServerDetail'] = {
      trace: 'x'.repeat(50_000),
    };
    const rawConnectionDetail = 'transceiver-detail-'.repeat(4_000);
    ws.serverState['connections'] = [{
      source: { id: 'source-1', port: 'A1' }, destination: { id: 'target-1', port: 'B1' },
      transceivers: [{ code: 'OPTIC-A', metadata: rawConnectionDetail }],
    }];
    const longId = 'rack-id-'.repeat(2_000);
    ws.rackSummaries[0]!.id = longId;
    ws.rackSummaries[0]!.code = 'rack-code-'.repeat(2_000);
    ws.rackSummaries[0]!.errors = [{ code: 'LONG', message: 'placement-error-'.repeat(2_000) }];
    ws.floorItems[0] = { id: 'floor-id-'.repeat(2_000), rackId: longId, x: 0, y: 0 };
    (ws.floorItems[0] as unknown as Record<string, unknown>)['rawFloor'] = 'floor-raw-'.repeat(10_000);
    ws.powerSelections[0] = { rackId: longId, pduCode: 'pdu-code-'.repeat(2_000) };
    (ws.powerSelections[0] as unknown as Record<string, unknown>)['rawPower'] = 'power-raw-'.repeat(10_000);

    const collection = projectWorkspacePage(ws, {
      ...projectionOptions, path: ['cables'], offset: 0, limit: 20,
    }) as { items: Array<{ key: string; value?: unknown; next?: { arguments: { path: string[] } } }> };
    expect(collection.items[0]).toMatchObject({ key: '0', type: 'object' });
    expect(collection.items[0]!.value).toBeUndefined();
    expect(collection.items[0]!.next!.arguments.path).toEqual(['cables', '0']);

    const cable = projectWorkspacePage(ws, {
      ...projectionOptions, path: ['cables', '0'], offset: 0, limit: 20,
    }) as { items: Array<{ key: string; next?: { arguments: { path: string[] } } }> };
    const descriptionEntry = cable.items.find(item => item.key === 'description')!;
    expect(descriptionEntry.next!.arguments.path).toEqual(['cables', '0', 'description']);

    let restored = '';
    let offset = 0;
    for (;;) {
      const page = projectWorkspacePage(ws, {
        ...projectionOptions, path: ['cables', '0', 'description'], offset, limit: 1_000,
      }) as { text: string; next?: { arguments: { offset: number } } };
      expect(jsonBytes(page)).toBeLessThanOrEqual(PAGE_BYTE_BUDGET);
      restored += page.text;
      if (!page.next) break;
      offset = page.next.arguments.offset;
    }
    expect(restored).toBe(description);

    const summary = projectWorkspaceSummary(ws, { ...projectionOptions, tool: 'dcsc_session_info' });
    const layout = projectWorkspaceLayout(ws, projectionOptions);
    expect(jsonBytes(summary)).toBeLessThanOrEqual(PAGE_BYTE_BUDGET);
    expect(jsonBytes(layout)).toBeLessThanOrEqual(PAGE_BYTE_BUDGET);
    expect(JSON.stringify(layout)).not.toContain('futureServerDetail');
    expect((layout['totals'] as Record<string, number>)['rawConnections']).toBe(1);
    const cablePreview = (summary['cables'] as Array<Record<string, unknown>>)[0]!;
    expect(cablePreview['descriptionTruncated']).toBe(true);
    expect((cablePreview['description'] as string).length).toBe(160);
    expect((cablePreview['detail'] as ContinuationForTest).arguments.path).toEqual(['cables', '0']);

    const rawConnection = projectWorkspacePage(ws, {
      ...projectionOptions, path: ['rawConnections', '0'], offset: 0, limit: 20,
    });
    expect(JSON.stringify(rawConnection)).toContain('transceivers');
    expect((workspaceDetailSource(ws)['rawConnections'] as Array<Record<string, unknown>>)[0])
      .toEqual((ws.serverState['connections'] as unknown[])[0]);

    ws.integrityWarnings = Array.from({ length: 100 }, (_, index) =>
      `warning-${index}-` + 'w'.repeat(4_000));
    const integrity = projectWorkspaceIntegrity(ws, {
      ...projectionOptions, tool: 'dcsc_session_info',
    });
    expect(jsonBytes(integrity)).toBeLessThanOrEqual(PAGE_BYTE_BUDGET);
    expect(integrity).toMatchObject({ integrityWarningCount: 100 });
    expect((integrity['integrityWarningsPage'] as { inspect: ContinuationForTest }).inspect.arguments.path)
      .toEqual(['integrityWarnings']);
  });
});

interface ContinuationForTest {
  arguments: { path: string[] };
}
