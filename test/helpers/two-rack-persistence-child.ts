import { ConfigSchema } from '../../src/config/schema.js';
import { reduceConfiguration } from '../../src/domain/reduce.js';
import type { RawConfiguration } from '../../src/model/types.js';
import { DcscService } from '../../src/mcp/service.js';

const mode = process.argv[2];
const sessionFile = process.argv[3];
if ((mode !== 'mutate' && mode !== 'verify') || !sessionFile) {
  throw new Error('Usage: two-rack-persistence-child.ts mutate|verify <session-file>');
}

const config = ConfigSchema.parse({
  logLevel: 'error',
  files: { persistSessions: true, sessionFile },
});
const service = new DcscService(config);

if (mode === 'mutate') {
  const rackA1 = service.sessions.create(input('rack-a1', '7D6DCTO1WW', 'rack', 11497.01));
  service.sessions.create(input('rack-a2', '7D6DCTO1WW', 'rack', 12706.51, rackA1.workspaceId));
  const server = service.sessions.create(input('server-1', '7D73CTO1WW', 'server', 16174.51, rackA1.workspaceId));
  const workspace = service.sessions.getWorkspace(rackA1.workspaceId)!;
  workspace.rackArea = [rack('rack-a1', [server.configurationId]), rack('rack-a2', [])];
  service.persist();

  await service.sessions.transact(workspace.id, { expectedRevision: workspace.revision }, (draft) => {
    const item = (draft.rackArea[0]!['rackItems'] as Record<string, unknown>[]).shift();
    assert(item, 'A1 server is missing');
    (draft.rackArea[1]!['rackItems'] as Record<string, unknown>[]).push(item);
  });
  let current = service.sessions.getWorkspace(workspace.id)!;
  assert(placement(current) === 'A2:1', `move result was ${placement(current)}`);
  assert(await service.sessions.undoWorkspace(current.id, current.revision), 'undo failed');
  current = service.sessions.getWorkspace(workspace.id)!;
  assert(placement(current) === 'A1:1', `undo result was ${placement(current)}`);
  assert(await service.sessions.redoWorkspace(current.id, current.revision), 'redo failed');
  current = service.sessions.getWorkspace(workspace.id)!;
  assert(placement(current) === 'A2:1', `redo result was ${placement(current)}`);

  process.stdout.write(`${JSON.stringify({ status: 'ack', workspace: workspace.id })}\n`);
  setInterval(() => undefined, 60_000);
} else {
  let workspace = service.sessions.listWorkspaces()[0];
  assert(workspace, 'workspace was not restored');
  assert(workspace.configurations.size === 3, 'configuration identities were not restored');
  assert(workspace.rackArea.length === 2, 'two racks were not restored');
  assert(placement(workspace) === 'A2:1', `restored placement was ${placement(workspace)}`);
  assert(total(workspace) === 40378.03, `restored price total was ${String(total(workspace))}`);
  assert(await service.sessions.undoWorkspace(workspace.id, workspace.revision), 'restored undo failed');
  workspace = service.sessions.getWorkspace(workspace.id)!;
  assert(placement(workspace) === 'A1:1', `restored undo result was ${placement(workspace)}`);
  assert(await service.sessions.redoWorkspace(workspace.id, workspace.revision), 'restored redo failed');
  workspace = service.sessions.getWorkspace(workspace.id)!;
  assert(placement(workspace) === 'A2:1', `restored redo result was ${placement(workspace)}`);
  await service.close();
  process.stdout.write(`${JSON.stringify({ status: 'verified', workspace: workspace.id })}\n`);
}

function input(
  configurationId: string,
  code: string,
  type: 'rack' | 'server',
  price: number,
  workspaceId?: string,
) {
  const raw: RawConfiguration = {
    id: configurationId,
    sliceCtoCode: code,
    description: `${code} persistence fixture`,
    type,
    quantity: 1,
    unitPrice: price,
    totalPrice: price,
    totalPrices: [{ priceTypeId: 1, price, priceNotAvailable: false }],
    hipoDerivedItems: [],
    hipoServiceCtoServices: [],
    tabs: [],
  };
  return {
    locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' } as const,
    solution: {
      solutionMode: 'General Purpose',
      masterSlices: ['GP', 'HPCGPALL', 'HPCGPRYO'],
      sbSlices: [],
    },
    mode: 'cto' as const,
    raw,
    configurationId,
    reduced: reduceConfiguration(raw, configurationId),
    primed: true,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

function rack(id: string, itemIds: string[]): Record<string, unknown> {
  return {
    id,
    code: '7D6DCTO1WW',
    description: 'ThinkSystem 42U rack',
    type: 'rack',
    size: 42,
    rackItems: itemIds.map((itemId) => ({
      id: itemId,
      code: '7D73CTO1WW',
      type: 'server',
      size: 1,
      position: 1,
      endPosition: 1,
    })),
  };
}

function placement(workspace: ReturnType<DcscService['sessions']['getWorkspace']>): string {
  if (!workspace) return 'missing';
  for (let index = 0; index < workspace.rackArea.length; index += 1) {
    const item = (workspace.rackArea[index]!['rackItems'] as Record<string, unknown>[] | undefined)?.[0];
    if (item?.['id'] === 'server-1') return `A${index + 1}:${String(item['position'])}`;
  }
  return 'nonrack';
}

function total(workspace: NonNullable<ReturnType<DcscService['sessions']['getWorkspace']>>): number {
  return [...workspace.configurations.values()].reduce(
    (sum, configuration) => sum + Number(configuration.raw.totalPrice ?? 0),
    0,
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
