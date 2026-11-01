import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { parseStandaloneImportResponse } from '../src/domain/importStandalone.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { registerStandaloneTools } from '../src/mcp/standaloneTools.js';
import { registerImportExportTools } from '../src/mcp/importExportTools.js';
import { DcscService } from '../src/mcp/service.js';

type ToolReply = { content: Array<{ type: 'text'; text: string }>; isError?: boolean | undefined };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolReply>;

const solutionModes = [{ mode: 'General Purpose', masterSlices: ['GP', 'HPCGPALL', 'HPCGPRYO'] }];
const zip = Buffer.from(
  'UEsDBBQAAAAIAJBsT10RXudMCQAAAAcAAAAKAAAAZXhwb3J0LnhtbLMpys8v0bcDAFBLAQIUAxQAAAAIAJBsT10RXudMCQAAAAcAAAAKAAAAAAAAAAAAAACAAQAAAABleHBvcnQueG1sUEsFBgAAAAABAAEAOAAAADEAAAAAAA==',
  'base64',
);

/** /findpart row captured from the website's Part Search (2026-10-29, US/USD). */
const transceiverRow = {
  code: '4TC7B10008', featureCode: 'CCVE', ctoCode: null, invalidCto: false, slice: null,
  description: 'Lenovo NVIDIA 800G XDR OSFP Single Mode Solo-Transceiver RHS (Generic)',
  priceNotAvailable: false, priceNotCredible: false, price: 3569.5, priceTypeId: null, type: 'HARDWARE',
  quantity: 0, recommendPriority: 0, marketingTag: [], showPrice: true, category: null,
  prices: [{ priceTypeId: 1, price: 3569.5, priceNotAvailable: false }],
  shippingStatus: ['30', '30', '30', '30', '30', '30'], shipDate: '', iaDate: null, announceDate: null,
  eosDate: null, withdrawnDate: '2999-12-31', hardwareType: 'server', rackless: false, marketValue: [],
  inventory: null, prodClass: null, shipStatus: 0, expressShipStatus: 0, lvrInventories: null,
  eccnRestricted: false, facetValues: null, lfoAsCto: false, recommendedFeature: false, iad: false,
};
const cableRow = {
  ...transceiverRow, code: '4X97B05748', featureCode: 'C98T',
  description: 'Lenovo 10M NVIDIA XDR SM MPO12 APC Optical Cable (Generic)', price: 379.5,
  prices: [{ priceTypeId: 1, price: 379.5, priceNotAvailable: false }],
  shippingStatus: ['10', '10', '10', '10', '10', '10'],
};

const services: DcscService[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => service.close()));
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const artifacts = await mkdtemp(join(tmpdir(), 'dcsc-standalone-hardware-'));
  tempDirs.push(artifacts);
  const service = new DcscService(ConfigSchema.parse({ logLevel: 'silent', files: { persistSessions: false, artifactDir: artifacts } }));
  services.push(service);
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: ToolHandler) {
      handlers.set(name, handler);
      return { remove() {}, update() {} };
    },
  };
  registerStandaloneTools(server as unknown as McpServer, service);
  registerImportExportTools(server as unknown as McpServer, service);
  const requests: Array<Record<string, unknown>> = [];
  vi.spyOn(service.http, 'send').mockImplementation(async (request) => {
    requests.push(request as unknown as Record<string, unknown>);
    if (request.path === '/solution_modes') return { raw: solutionModes } as never;
    if (request.path === '/findpart') {
      const keyword = String((request.query as Record<string, unknown>)['keyword']);
      return { raw: [transceiverRow, cableRow].filter((row) => row.code === keyword) } as never;
    }
    if (request.path === '/lfos/export_zip' || request.path === '/ctos/export_zip') {
      return { stream: Readable.from(zip), contentDisposition: 'attachment; filename="parts.zip"' } as never;
    }
    throw new Error(`Unexpected ${request.path}`);
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const fn = handlers.get(name);
    if (!fn) throw new Error(`${name} not registered`);
    return fn(args);
  };
  return { service, call, requests };
}

const parse = (reply: ToolReply) => JSON.parse(reply.content[0]?.text ?? '{}') as Record<string, unknown>;

function exportFields(requests: Array<Record<string, unknown>>, path: string) {
  const request = requests.find((candidate) => candidate['path'] === path);
  const fields = (request?.['body'] as { fields: Record<string, string> } | undefined)?.fields ?? {};
  return {
    data: JSON.parse(fields['data'] ?? '{}') as Record<string, unknown>,
    groups: JSON.parse(fields['groups'] ?? '[]') as Array<{ products: Array<Record<string, unknown>> }>,
  };
}

describe('standalone hardware tools', () => {
  it('adds Part Search hardware, edits quantities and exports the captured website form', async () => {
    const { call, requests } = await setup();
    const added = parse(await call('dcsc_basket_set', { basket: 'hardware', action: 'select', code: '4tc7b10008', quantity: 3 }));
    const workspace = String(added['session']);
    expect(added).toMatchObject({
      selections: [{ code: '4TC7B10008', featureCode: 'CCVE', quantity: 3, unitPrice: 3569.5, totalPrice: 10708.5 }],
      totalListPrice: 10708.5,
      hardwareConfigurations: 0,
    });
    expect(requests.find((request) => request['path'] === '/findpart')).toMatchObject({
      query: { keyword: '4TC7B10008', type: 'HARDWARE' },
    });

    await call('dcsc_basket_set', { basket: 'hardware', action: 'select', session: workspace, code: '4X97B05748', quantity: 1 });
    // Re-adding a selected part replaces its quantity; the website keeps one line per part.
    await call('dcsc_basket_set', { basket: 'hardware', action: 'select', session: workspace, code: '4X97B05748', quantity: 2 });
    const edited = parse(await call('dcsc_basket_set', { basket: 'hardware', action: 'setQuantity', session: workspace, code: '4X97B05748', quantity: 5 }));
    expect(edited).toMatchObject({
      selections: [{ code: '4TC7B10008', quantity: 3 }, { code: '4X97B05748', quantity: 5, totalPrice: 1897.5 }],
      totalListPrice: 12606,
    });

    const missing = await call('dcsc_basket_set', { basket: 'hardware', action: 'select', session: workspace, code: 'NOPE123' });
    expect(missing.isError).toBe(true);

    const exported = parse(await call('dcsc_export', { kind: 'reports', session: workspace, fileName: 'parts' }));
    expect(exported).toMatchObject({ bytes: zip.length });
    const { data, groups } = exportFields(requests, '/lfos/export_zip');
    const rows = data['standaloneData'] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    // Captured browser row: the complete /findpart object plus id, quantity, keyWord and isLFO.
    expect(rows[0]).toEqual({ ...transceiverRow, id: expect.any(String), quantity: 3, keyWord: null, isLFO: false });
    expect(groups[0]?.products).toEqual([
      { ...transceiverRow, id: rows[0]?.['id'], quantity: 3, keyWord: null, isLFO: false,
        type: 'standalone', price: 10708.5, unitPrice: 3569.5, groupId: 'Config 1' },
      { ...cableRow, id: rows[1]?.['id'], quantity: 5, keyWord: null, isLFO: false,
        type: 'standalone', price: 1897.5, unitPrice: 379.5, groupId: 'Config 1' },
    ]);

    const removed = parse(await call('dcsc_basket_set', { basket: 'hardware', action: 'remove', session: workspace, code: '4TC7B10008' }));
    expect(removed).toMatchObject({ selections: [{ code: '4X97B05748' }], totalListPrice: 1897.5 });
  });

  it('exports standalone hardware alongside configured systems through the hardware route', async () => {
    const { service, call, requests } = await setup();
    const added = parse(await call('dcsc_basket_set', { basket: 'hardware', action: 'select', code: '4X97B05748', quantity: 7 }));
    const workspace = String(added['session']);
    const configurationId = 'switch-configuration';
    const raw = { id: configurationId, sliceCtoCode: '7D5FCTOFWW', description: 'NVIDIA SN2201', type: 'switch',
      quantity: 1, totalPrice: 6221.51, tabs: [] };
    service.sessions.create({
      locale: service.locale,
      solution: service.sessions.getWorkspace(workspace)!.solution,
      mode: 'cto', raw, configurationId,
      reduced: reduceConfiguration(raw, configurationId),
      primed: true,
      workspaceId: workspace,
    });
    await call('dcsc_export', { kind: 'reports', session: workspace, fileName: 'mixed' });
    const { data, groups } = exportFields(requests, '/ctos/export_zip');
    expect((data['standaloneData'] as unknown[])).toHaveLength(1);
    const products = groups[0]?.products ?? [];
    expect(products.some((product) => product['code'] === '7D5FCTOFWW')).toBe(true);
    expect(products.find((product) => product['type'] === 'standalone')).toMatchObject({ code: '4X97B05748', quantity: 7, price: 2656.5 });
  });

  it('exports an lfo-as-cto configuration through the CTO route', async () => {
    const { service, call, requests } = await setup();
    const added = parse(await call('dcsc_basket_set', { basket: 'hardware', action: 'select', code: '4X97B05748', quantity: 1 }));
    const workspace = String(added['session']);
    const configurationId = 'lfo-as-cto-configuration';
    const raw = { id: configurationId, sliceCtoCode: '7D5FCTOFWW', description: 'NVIDIA SN2201', type: 'switch',
      quantity: 1, totalPrice: 6221.51, tabs: [] };
    service.sessions.create({
      locale: service.locale,
      solution: service.sessions.getWorkspace(workspace)!.solution,
      mode: 'lfo-as-cto', raw, configurationId,
      reduced: reduceConfiguration(raw, configurationId),
      primed: true,
      workspaceId: workspace,
    });
    await call('dcsc_export', { kind: 'reports', session: workspace, fileName: 'lfo-as-cto' });
    expect(requests.filter((request) => String(request['path']).endsWith('/export_zip')).map((request) => request['path']))
      .toEqual(['/ctos/export_zip']);
  });

  it('restores hardware rows from a CFXML import response separately from software', () => {
    const envelope = {
      configuration: [],
      standaloneData: [{ ...cableRow, id: 'line-1', quantity: 4, keyWord: null, isLFO: false }],
      groups: [{ name: 'Config 1', products: [{ ...cableRow, id: 'line-1', quantity: 4, type: 'standalone', price: 1518, unitPrice: 379.5 }] }],
    };
    const parsed = parseStandaloneImportResponse([envelope]);
    expect(parsed?.kind).toBe('hardware');
    expect(parsed?.state).toMatchObject({
      kind: 'standalone-hardware',
      selections: [{ id: 'line-1', code: '4X97B05748', quantity: 4, unitPrice: 379.5, featureCode: 'C98T' }],
    });
    const selection = (parsed?.state as { selections: Array<{ part: Record<string, unknown> }> }).selections[0]!;
    expect(selection.part).not.toHaveProperty('id');
    expect(selection.part).not.toHaveProperty('quantity');
  });
});
