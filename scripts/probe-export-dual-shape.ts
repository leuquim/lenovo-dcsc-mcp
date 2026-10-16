import { loadConfig } from '../src/config/load.js';
import { configureLogger } from '../src/http/trace.js';
import { DcscService } from '../src/mcp/service.js';
import { buildExportData, buildExportForm, buildGroups } from '../src/domain/reduce.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RackObject } from '../src/domain/rack.js';
import { isolateRuntime } from './lib/isolated-runtime.js';

const OUT = resolve(process.argv.find(arg => arg.startsWith('--out='))?.slice('--out='.length)
  ?? 'artifacts/probe-export-dual-shape');
mkdirSync(OUT, { recursive: true });

/** Convert customize-shape rack (rackItems, 1-based) to SPA local shape (servers, 0-based). */
function toLocalRack(rack: RackObject): RackObject {
  const items = ((rack['rackItems'] as RackObject[] | undefined) ?? []).map((it) => {
    const pos = typeof it['position'] === 'number' ? it['position'] : Number(it['position']) || 1;
    const copy = { ...it };
    delete copy['rackItems'];
    return { ...copy, position: Math.max(0, pos - 1) };
  });
  const featureItems = ((rack['featureItems'] as RackObject[] | undefined) ?? []).map((fi) => {
    const pos = typeof fi['position'] === 'number' ? fi['position'] : undefined;
    if (pos === undefined) return fi;
    return { ...fi, position: Math.max(0, pos - 1) };
  });
  const lockedSpace = Array.isArray(rack['lockedSpace'])
    ? (rack['lockedSpace'] as number[]).map((n) => n - 1)
    : rack['lockedSpace'];
  const { rackItems: _ri, ...base } = rack;
  return {
    ...base,
    servers: items,
    featureItems,
    lockedSpace,
    quantity: rack['quantity'] ?? 1,
  };
}

/** Convert local shape back to export rackData shape (rackItems, 1-based). */
function toExportRackData(local: RackObject): RackObject {
  const servers = ((local['servers'] as RackObject[] | undefined) ?? []).map((it) => {
    const pos = typeof it['position'] === 'number' ? it['position'] : 0;
    return { ...it, position: pos + 1 };
  });
  const featureItems = ((local['featureItems'] as RackObject[] | undefined) ?? []).map((fi) => {
    const pos = typeof fi['position'] === 'number' ? fi['position'] : undefined;
    if (pos === undefined) return fi;
    return { ...fi, position: pos + 1 };
  });
  const lockedSpace = Array.isArray(local['lockedSpace'])
    ? (local['lockedSpace'] as number[]).map((n) => n + 1)
    : local['lockedSpace'];
  const { servers: _s, ...base } = local;
  return {
    ...base,
    rackItems: servers,
    featureItems,
    lockedSpace,
  };
}

async function tryExport(
  label: string,
  service: DcscService,
  sessionHandle: string,
  buildData: () => Record<string, unknown>,
) {
  const ws = service.sessions.getWorkspace(sessionHandle)!;
  try {
    const data = buildData();
    writeFileSync(`${OUT}/export-payload-${label}.json`, JSON.stringify(data, null, 2));
    const form = buildExportForm({
      data,
      groups: buildGroups(ws),
    });
    const res = await service.http.send({
      endpoint: `export_${label}`,
      method: 'POST',
      path: '/ctos/export_zip',
      query: { fileName: `probe-${label}` },
      requiresSolution: false,
      body: { kind: 'form', fields: form },
      responseKind: 'stream',
      timeoutClass: 'export',
      ctx: { ...service.newCtx(), solution: ws.solution },
    });
    // drain stream
    const chunks: Buffer[] = [];
    for await (const c of res.stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    const buf = Buffer.concat(chunks);
    writeFileSync(`${OUT}/export-${label}.zip`, buf);
    console.log(`[${label}] OK ${buf.length} bytes`);
    return buf.length;
  } catch (e) {
    console.log(`[${label}] FAIL ${(e as Error).message.slice(0, 200)}`);
    return 0;
  }
}

async function main() {
  const config = isolateRuntime(loadConfig({ logLevel: 'warn' }));
  configureLogger('warn');
  const service = new DcscService(config);
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'HPC and AI - Systems');
  const node = await service.launch({ productCode: '7DM9CTO1WW', mode: 'cto', solution, ctx });
  const added = await service.addRack(node.id, '7D6DCTO1WW', service.newCtx());
  const rackId = added.racks[0]!.id;
  await service.placeInRack(node.id, {
    rackId,
    sessionId: node.id,
    position: 3,
    ctx: service.newCtx(),
  });
  const ws = service.sessions.getWorkspace(node.id)!;
  console.log('rackArea keys', Object.keys(ws.rackArea[0] || {}).slice(0, 25));
  console.log('has rackItems', Array.isArray(ws.rackArea[0]?.['rackItems']), 'len', (ws.rackArea[0]?.['rackItems'] as unknown[])?.length);

  // A: current shape (raw customize in both places)
  await tryExport('raw-both', service, node.id, () =>
    buildExportData({ workspace: ws, solution, fileTypes: ['XML', 'RACK_DIAGRAM', 'RACK_REPORT'], validationMode: 'guided' }),
  );

  // B: dual shape - workspace local servers, rackData rackItems
  await tryExport('dual-shape', service, node.id, () => {
    const data = buildExportData({
      workspace: ws,
      solution,
      fileTypes: ['XML', 'RACK_DIAGRAM', 'RACK_REPORT', 'FLOOR', 'P2P_REPORT'],
      validationMode: 'guided',
    });
    const localRacks = ws.rackArea.map(toLocalRack);
    const exportRacks = localRacks.map(toExportRackData);
    const mutable = mutableExportData(data);
    mutable.workspace.rackArea = localRacks;
    mutable.workspaceInformation.rackData = exportRacks;
    delete mutable.workspaceInformation.configurations;
    return data;
  });

  // C: only rackData dual, workspace rackArea empty
  await tryExport('rackdata-only', service, node.id, () => {
    const data = buildExportData({
      workspace: ws,
      solution,
      fileTypes: ['XML', 'RACK_DIAGRAM', 'RACK_REPORT'],
      validationMode: 'guided',
    });
    const mutable = mutableExportData(data);
    mutable.workspace.rackArea = [];
    mutable.workspaceInformation.rackData = ws.rackArea.map((r) =>
      toExportRackData(toLocalRack(r)),
    );
    delete mutable.workspaceInformation.configurations;
    return data;
  });

  // D: workspace local only, rackData empty
  await tryExport('local-workspace-only', service, node.id, () => {
    const data = buildExportData({
      workspace: ws,
      solution,
      fileTypes: ['XML', 'RACK_DIAGRAM', 'RACK_REPORT'],
      validationMode: 'guided',
    });
    const mutable = mutableExportData(data);
    mutable.workspace.rackArea = ws.rackArea.map(toLocalRack);
    mutable.workspaceInformation.rackData = [];
    delete mutable.workspaceInformation.configurations;
    return data;
  });

  // E: dual + strip heavy fields from racks
  await tryExport('dual-minimal-fields', service, node.id, () => {
    const data = buildExportData({
      workspace: ws,
      solution,
      fileTypes: ['XML', 'RACK_DIAGRAM', 'RACK_REPORT'],
      validationMode: 'guided',
    });
    const slim = (r: RackObject, itemsKey: 'servers' | 'rackItems') => {
      const items = (r[itemsKey] as RackObject[]) ?? [];
      return {
        id: r['id'],
        code: r['code'],
        type: r['type'] ?? 'rack',
        size: r['size'],
        description: r['description'],
        name: r['name'] ?? 'Rack1',
        machineType: r['machineType'],
        quantity: 1,
        [itemsKey]: items.map((it) => ({
          id: it['id'],
          code: it['code'],
          type: it['type'] ?? 'server',
          size: it['size'],
          position: it['position'],
          quantity: it['quantity'] ?? 1,
        })),
        featureItems: [],
        lockedSpace: [],
        errors: [],
      };
    };
    const local = ws.rackArea.map((r) => slim(toLocalRack(r), 'servers'));
    const exp = ws.rackArea.map((r) => slim(toExportRackData(toLocalRack(r)), 'rackItems'));
    const mutable = mutableExportData(data);
    mutable.workspace.rackArea = local;
    mutable.workspaceInformation.rackData = exp;
    delete mutable.workspaceInformation.configurations;
    return data;
  });

  await service.close();
}

interface MutableExportData extends Record<string, unknown> {
  workspace: Record<string, unknown> & { rackArea: RackObject[] };
  workspaceInformation: Record<string, unknown> & {
    rackData: RackObject[];
    configurations?: unknown;
  };
}

function mutableExportData(data: Record<string, unknown>): MutableExportData {
  return data as MutableExportData;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
