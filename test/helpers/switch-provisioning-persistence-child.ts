import { readFileSync } from 'node:fs';

import { ConfigSchema } from '../../src/config/schema.js';
import { readAutoConnectSettings } from '../../src/domain/cabling.js';
import { buildExportData, reduceConfiguration } from '../../src/domain/reduce.js';
import type { SendInput } from '../../src/http/request.js';
import type { RawConfiguration } from '../../src/model/types.js';
import { DcscService } from '../../src/mcp/service.js';
import { saveSessions } from '../../src/session/persist.js';

type Obj = Record<string, unknown>;

const mode = process.argv[2];
const sessionFile = process.argv[3];
if ((mode !== 'mutate' && mode !== 'verify') || !sessionFile) {
  throw new Error('Usage: switch-provisioning-persistence-child.ts mutate|verify <session-file>');
}

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/parity/switch-provisioning.json', import.meta.url),
  'utf8',
)) as {
  workspace: Obj & { configurations: Obj[]; rackArea: Obj[] };
  calculationResponse: unknown;
  launch: RawConfiguration;
};
const graphFixture = JSON.parse(readFileSync(
  new URL('../fixtures/parity/browser-auto-switch-cabling.json', import.meta.url),
  'utf8',
)) as {
  connection: Obj;
  export: { cables: Array<{ code: string; description: string; quantity: number }> };
};

const config = ConfigSchema.parse({
  logLevel: 'error',
  files: { persistSessions: true, sessionFile },
});
const service = new DcscService(config);

if (mode === 'mutate') {
  const workspace = seedWorkspace();
  installFixtureHttp();
  const result = await service.runAutoConnect(workspace.id, service.newCtx(), workspace.revision);
  const generatedId = result.connections[0]?.toId;
  assert(generatedId, 'auto-connect did not return a generated switch destination');
  assertPersistedGraph(workspace.id, generatedId);
  process.stdout.write(`${JSON.stringify({ status: 'ack', workspace: workspace.id, generatedId })}\n`);
  // The parent deliberately terminates us without a graceful service close.
  setInterval(() => undefined, 60_000);
} else {
  let workspace = service.sessions.listWorkspaces()[0];
  assert(workspace, 'generated-switch workspace was not restored');
  const switchMap = readSwitchMap(workspace.serverState);
  const generatedId = String(switchMap[0]?.['id'] ?? '');
  assert(generatedId, 'generated switch map identity was not restored');
  assertPersistedGraph(workspace.id, generatedId);

  const revision = workspace.revision;
  assert(await service.sessions.undoWorkspace(workspace.id, revision), 'restored generated-switch undo failed');
  workspace = service.sessions.getWorkspace(workspace.id)!;
  assert(workspace.configurations.size === 3, 'undo did not remove the generated configuration');
  assert(![...workspace.configurations.values()].some((session) => session.configurationId === generatedId),
    'undo retained the generated configuration identity');
  assert(readSwitchMap(workspace.serverState).length === 0, 'undo retained generated switchMap state');

  assert(await service.sessions.redoWorkspace(workspace.id, workspace.revision), 'restored generated-switch redo failed');
  workspace = service.sessions.getWorkspace(workspace.id)!;
  assertPersistedGraph(workspace.id, generatedId);
  await service.close();
  process.stdout.write(`${JSON.stringify({ status: 'verified', workspace: workspace.id, generatedId })}\n`);
}

function seedWorkspace() {
  const solution = {
    solutionMode: 'HPC and AI - Systems',
    masterSlices: ['HPCGP', 'HPCRYO', 'HPCGPALL', 'HPCGPRYO'],
    sbSlices: [],
  };
  let workspaceId: string | undefined;
  for (const base of fixture.workspace.configurations) {
    const raw = {
      ...base,
      tabs: [],
      type: base['id'] === 'rack-1' ? 'rack' : base['id'] === 'server-1' ? 'server' : 'switch',
      quantity: 1,
      totalPrice: base['id'] === 'rack-1' ? 11497.01 : base['id'] === 'server-1' ? 19693.51 : 6221.51,
    } as RawConfiguration;
    const session = service.sessions.create({
      locale: service.locale,
      solution,
      mode: 'cto',
      raw,
      configurationId: String(raw.id),
      reduced: reduceConfiguration(raw, String(raw.id)),
      primed: true,
      ...(workspaceId ? { workspaceId } : {}),
    });
    workspaceId = session.workspaceId;
  }
  const workspace = service.sessions.getWorkspace(workspaceId!)!;
  workspace.rackArea = structuredClone(fixture.workspace.rackArea);
  workspace.rackArea[0]!['size'] = 42;
  workspace.serverState = { ...structuredClone(fixture.workspace), connections: [] };
  saveSessions(service.sessions, service.config);
  return workspace;
}

function installFixtureHttp(): void {
  let generatedId = '';
  let deriveCount = 0;
  const adapter = service.http as unknown as {
    send(input: SendInput): Promise<{ raw: unknown }>;
  };
  adapter.send = async (request: SendInput) => {
    const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
    let raw: unknown;
    if (request.endpoint === 'switch_calculation') {
      raw = Array.isArray(body['switchMap']) && body['switchMap'].length > 0
        ? []
        : fixture.calculationResponse;
    } else if (request.endpoint === 'automatic_switch_launch') {
      raw = fixture.launch;
    } else if (request.endpoint === 'racks_customize') {
      const racks = structuredClone(body['rackArea']) as Obj[];
      const items = racks[0]!['rackItems'] as Obj[];
      const item = items.find((value) => value['id'] !== 'server-1' && value['id'] !== 'manual-switch-1');
      assert(item, 'customize request omitted the generated switch item');
      generatedId = String(item['id']);
      item['position'] = 6;
      raw = {
        rackArea: racks,
        nonRackArea: [],
        connections: [{ ...graphFixture.connection, destinationId: generatedId }],
      };
    } else if (request.endpoint === 'workspace_autoDerive') {
      deriveCount += 1;
      raw = deriveCount === 1
        ? {
            configurations: [{ ...fixture.launch, id: generatedId, totalPrice: 1450, quantity: 1 }],
            autoDerivedResults: [{ id: 'derived-installation', appliedConfigurations: [generatedId] }],
          }
        : { configurations: [] };
    } else if (request.endpoint === 'auto_connect') {
      raw = {
        rackArea: body['rackArea'],
        nonRackArea: [],
        connections: [{ ...graphFixture.connection, destinationId: generatedId }],
      };
    } else {
      throw new Error(`Unexpected fixture endpoint ${request.endpoint}`);
    }
    return { raw };
  };
}

function assertPersistedGraph(workspaceId: string, generatedId: string): void {
  const workspace = service.sessions.getWorkspace(workspaceId);
  assert(workspace, 'generated-switch workspace is missing');
  assert(workspace.configurations.size === 4, 'generated configuration count was not persisted');
  assert(generatedId !== 'manual-switch-1', 'automatic provisioning reused the manual switch identity');
  const generated = [...workspace.configurations.values()]
    .find((session) => session.configurationId === generatedId);
  assert(generated, 'generated switch configuration identity is missing');
  assert(generated.raw.totalPrice === 1450, 'derived generated switch state was not persisted');
  const rackItem = (workspace.rackArea[0]!['rackItems'] as Obj[])
    .find((item) => item['id'] === generatedId);
  assert(rackItem?.['position'] === 6, 'authoritative generated switch U6 placement was not persisted');
  assert(readSwitchMap(workspace.serverState).some((entry) =>
    entry['id'] === generatedId && entry['network'] === 'Management' &&
    entry['type'] === 'main' && entry['code'] === '7D5FCTOFWW'), 'generated switchMap entry was not persisted');

  const connections = readConnections(workspace.serverState);
  assert(connections.length === 1, 'full auto-connect graph was not persisted');
  assert(connections[0]?.['destinationId'] === generatedId, 'connection destination identity was not persisted');
  assert(connections[0]?.['sourcePortName'] === 'RJ45 mgmt', 'full connection DTO fields were dropped');
  assert((connections[0]?.['cableDistance'] as Obj | undefined)?.['totalDistance'] === 0.62225,
    'cable distance detail was not persisted');

  const settings = readAutoConnectSettings(workspace.serverState);
  assert(settings['autoAddPDU'] === false && settings['autoAddSwitch'] === true && settings['p2pCabling'] === true,
    'auto-connect settings were not persisted');
  const exported = buildExportData({
    workspace,
    solution: workspace.solution,
    fileTypes: ['XML'],
    validationMode: workspace.validationMode,
  });
  const networking = exported['networkingInformation'] as Obj;
  assert(JSON.stringify(networking['cables']) === JSON.stringify(graphFixture.export.cables),
    'export cable aggregation changed after persistence');
  assert((exported['autoConnectResults'] as Obj[])[0]?.['destinationId'] === generatedId,
    'export autoConnectResults lost the generated identity');
  const flags = exported['customizingFlags'] as Obj;
  assert(flags['autoAddPDU'] === false && flags['autoAddSwitch'] === true && flags['p2pCabling'] === true,
    'export settings changed after persistence');
}

function readSwitchMap(state: Obj): Obj[] {
  const nested = state['networkingInformation'] as Obj | undefined;
  const value = state['switchMap'] ?? nested?.['switchMap'] ?? [];
  return Array.isArray(value) ? value as Obj[] : [];
}

function readConnections(state: Obj): Obj[] {
  const autoConnect = state['autoConnectState'] as Obj | undefined;
  const value = state['connections'] ?? autoConnect?.['connections'] ?? [];
  return Array.isArray(value) ? value as Obj[] : [];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
