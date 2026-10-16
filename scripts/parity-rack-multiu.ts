/** Verifies a current General Purpose 2U server at the bottom rack boundary. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';

type JsonObject = Record<string, unknown>;

const ROOT = process.cwd();
const CONTRACT = path.join(ROOT, 'test/fixtures/parity/browser-multi-u-catalog.json');
const RACK_CODE = '7D6DCTO1WW';

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

async function main(): Promise<void> {
  const arg = process.argv.find((value) => value.startsWith('--out='));
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const outDir = path.resolve(arg?.slice('--out='.length) ?? `artifacts/parity-rack-multiu/${stamp}`);
  await mkdir(outDir, { recursive: true });
  const contract = JSON.parse(await readFile(CONTRACT, 'utf8')) as JsonObject;
  const product = object(contract['product']);
  const productCode = String(product['code']);

  const config = ConfigSchema.parse({
    files: { persistSessions: false, artifactDir: path.join(outDir, 'artifacts') },
    logLevel: 'error',
    pacing: { perToolRequestBudget: 40 },
  });
  const service = new DcscService(config);
  try {
    const ctx = service.newCtx();
    const modes = await service.solutionModes(ctx);
    const mode = modes.find((entry) => entry.mode === 'General Purpose');
    assert(mode, 'General Purpose mode is unavailable.');
    const solution = {
      solutionMode: mode.mode,
      masterSlices: mode.masterSlices,
    };
    const catalog = await service.catalog(ctx, solution);
    const current = catalog.entries.find((entry) => entry.code === productCode);
    assert(current, `${productCode} disappeared from the General Purpose catalog.`);
    assert.equal(current.hardwareType, product['hardwareType']);
    assert.equal(current.withdrawn, false);

    const server = await service.launch({ productCode, mode: 'cto', solution, ctx });
    let workspace = service.sessions.getWorkspace(server.workspaceId)!;
    await service.addRack(workspace.id, RACK_CODE, ctx, workspace.revision);
    workspace = service.sessions.getWorkspace(server.workspaceId)!;
    const rack = workspace.rackArea[0];
    assert(rack, 'Rack creation returned no rack.');
    assert.equal(Number(rack['size']), 42);

    const acceptedLayout = await service.placeInRack(workspace.id, {
      rackId: String(rack['id']), sessionId: server.id, position: 41,
      expectedRevision: workspace.revision, ctx,
    });
    workspace = service.sessions.getWorkspace(server.workspaceId)!;
    const accepted = (rackItems(workspace)[0]);
    assert(accepted, 'DCSC omitted the accepted server placement.');
    assert.equal(Number(accepted['size']), 2, 'DCSC physical envelope is no longer 2U.');
    assert.equal(Number(accepted['position']), 41);
    // DCSC's stored rack envelope uses an exclusive end position. The MCP
    // layout projection normalizes this to the inclusive public U range.
    assert.equal(Number(accepted['endPosition']), 43);
    assert.equal(acceptedLayout.racks[0]?.items[0]?.endPosition, 42);

    const beforeRejectedRevision = workspace.revision;
    await assert.rejects(
      service.placeInRack(workspace.id, {
        rackId: String(rack['id']), sessionId: server.id, position: 42,
        expectedRevision: workspace.revision, ctx,
      }),
      /extends beyond the rack capacity/,
    );
    workspace = service.sessions.getWorkspace(server.workspaceId)!;
    assert.equal(workspace.revision, beforeRejectedRevision, 'Rejected boundary changed revision.');
    assert.equal(Number(rackItems(workspace)[0]?.['position']), 41, 'Rejected boundary changed placement.');

    const result = {
      capturedAt: new Date().toISOString(),
      status: 'pass',
      browserCatalogOracle: path.relative(ROOT, CONTRACT),
      solutionMode: solution.solutionMode,
      rack: { code: RACK_CODE, sizeU: 42 },
      product: { code: productCode, sizeU: 2 },
      acceptedBoundary: { position: 41, endPosition: 42 },
      rejectedBoundary: { position: 42, endPosition: 43, revisionUnchanged: true },
    };
    await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await service.close();
  }
}

function rackItems(workspace: NonNullable<ReturnType<DcscService['sessions']['getWorkspace']>>): JsonObject[] {
  const items = workspace.rackArea[0]?.['rackItems'];
  return Array.isArray(items) ? items.map(object) : [];
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
