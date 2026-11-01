import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import type { FabricOptions } from '../src/domain/fabric.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { SessionPersistenceError } from '../src/http/persistenceError.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';
import type { RawConfiguration } from '../src/model/types.js';

type Reply = { isError?: boolean; content: Array<{ text?: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Reply>;

const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });

function configuration(quantity = 1): RawConfiguration {
  return {
    id: 'US__durable_tool', code: 'TESTCTO', sliceCtoCode: 'TESTCTO',
    description: 'Persistence boundary fixture', type: 'SERVER', quantity: 1, totalPrice: 100,
    tabs: [{ title: 'Memory', type: 'hardware', subTabs: [{ title: 'Memory', sections: [{
      name: 'MEMORY', singleEntry: true,
      features: [{ code: 'DIMM', max: 16, description: 'DIMM' }],
      results: [{ code: 'DIMM', quantity }],
    }] }] }],
  };
}

function setup() {
  const service = new DcscService(ConfigSchema.parse({
    files: { persistSessions: false }, logLevel: 'silent',
  }));
  services.push(service);
  const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };
  const raw = configuration();
  const session = service.sessions.create({
    locale: service.locale, solution, mode: 'cto', raw,
    configurationId: raw.id!, reduced: reduceConfiguration(raw, raw.id!), primed: true,
  });
  const workspace = service.sessions.getWorkspace(session.id)!;
  const handlers = new Map<string, Handler>();
  registerTools({
    registerTool(name: string, _config: unknown, handler: Handler) { handlers.set(name, handler); },
  } as unknown as McpServer, service);
  return { service, session, workspace, handlers, ctx: service.newCtx({ solution }) };
}

function parsed(reply: Reply): Record<string, unknown> {
  return JSON.parse(reply.content[0]?.text ?? '{}') as Record<string, unknown>;
}

function committedState(session: ReturnType<typeof setup>['session'], workspace: ReturnType<typeof setup>['workspace']) {
  return structuredClone({
    raw: session.raw,
    sessionRevision: session.revision,
    workspaceRevision: workspace.revision,
    snapshots: session.snapshots,
    history: workspace.history,
    serverState: workspace.serverState,
  });
}

const remoteFailure = {
  error: 'Durable session commit failed after the remote operation succeeded; local state was not committed.',
  kind: 'persistence',
  code: 'DCSC_LOCAL_NOT_COMMITTED',
  remoteApplied: true,
  localNotCommitted: true,
  retryable: false,
  recoveryHint: 'The upstream operation may have succeeded. Inspect or refresh upstream state before retrying.',
};

const localFailure = {
  error: 'Durable session commit failed; local state was not committed.',
  kind: 'persistence',
  code: 'DCSC_LOCAL_NOT_COMMITTED',
  remoteApplied: false,
  localNotCommitted: true,
  retryable: false,
  recoveryHint: 'The local candidate was not published. Correct persistence and retry the operation.',
};

describe('service persistence failure provenance', () => {
  it('does not publish or retry a configuration after derive succeeds and its durable write fails', async () => {
    const { service, session, workspace, ctx } = setup();
    const before = committedState(session, workspace);
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: { configurations: [configuration(8)] },
    } as never);
    const writer = vi.fn(() => { throw new Error('SECRET_DEVICE_PATH: ENOSPC'); });
    service.sessions.setPersistenceWriter(writer);

    let failure: unknown;
    try {
      await service.configure(
        session,
        [{ section: 'MEMORY', code: 'DIMM', quantity: 8 }],
        ctx,
        session.revision,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SessionPersistenceError);
    expect(failure).toMatchObject({ remoteApplied: true, localNotCommitted: true });
    expect((failure as Error).message).not.toContain('SECRET_DEVICE_PATH');
    expect((failure as Error & { cause?: unknown }).cause).toMatchObject({
      message: 'SECRET_DEVICE_PATH: ENOSPC',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(committedState(session, workspace)).toEqual(before);
  });
});

describe('registered tool persistence diagnostics', () => {
  it('returns an exact safe structured error after a successful configure request', async () => {
    const { service, session, workspace, handlers } = setup();
    const before = committedState(session, workspace);
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: { configurations: [configuration(8)] },
    } as never);
    const writer = vi.fn(() => { throw new Error('SECRET_DEVICE_PATH: ENOSPC'); });
    service.sessions.setPersistenceWriter(writer);

    const reply = await handlers.get('dcsc_configure')!({
      session: session.id,
      expectedRevision: session.revision,
      changes: [{ section: 'MEMORY', code: 'DIMM', quantity: 8 }],
    });

    expect(reply.isError).toBe(true);
    expect(parsed(reply)).toEqual(remoteFailure);
    expect(JSON.stringify(reply)).not.toContain('SECRET_DEVICE_PATH');
    expect(send).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(committedState(session, workspace)).toEqual(before);
  });

  it('marks a failed local-only quantity commit remoteApplied false', async () => {
    const { service, session, workspace, handlers } = setup();
    const before = committedState(session, workspace);
    const send = vi.spyOn(service.http, 'send');
    const writer = vi.fn(() => { throw new Error('SECRET_QUANTITY_PATH: read only'); });
    service.sessions.setPersistenceWriter(writer);

    const reply = await handlers.get('dcsc_set_quantity')!({
      session: session.id, expectedRevision: session.revision, quantity: 8,
    });

    expect(reply.isError).toBe(true);
    expect(parsed(reply)).toEqual(localFailure);
    expect(JSON.stringify(reply)).not.toContain('SECRET_QUANTITY_PATH');
    expect(send).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(committedState(session, workspace)).toEqual(before);
  });

  it('keeps network preference persistence local when autoConnect is false', async () => {
    const { service, session, workspace, handlers } = setup();
    const before = committedState(session, workspace);
    const send = vi.spyOn(service.http, 'send');
    const fabric: FabricOptions = {
      topologies: [{ id: 'topology:ethernet', shortName: 'Ethernet', description: 'Ethernet' }],
      networkDevices: [],
      networkTypes: [{
        id: 'network-type:management', name: 'Management',
        defaultNetworkTechnology: 'Ethernet', defaultLayout: 'Centralized',
        defaultMainSwitch: '', defaultMainSwitchOption: '', mainSwitchTrunks: 0,
      }],
      cables: [], selectedServices: [], nodeRoles: [], storageSwitches: [], storageControllers: [],
    };
    vi.spyOn(service, 'fabricOptions').mockResolvedValue(fabric);
    const writer = vi.fn(() => { throw new Error('SECRET_NETWORK_PATH: read only'); });
    service.sessions.setPersistenceWriter(writer);

    const reply = await handlers.get('dcsc_set_network_preferences')!({
      session: workspace.id,
      expectedRevision: workspace.revision,
      autoConnect: false,
      selections: [{ networkTypeId: 'network-type:management' }],
    });

    expect(reply.isError).toBe(true);
    expect(parsed(reply)).toEqual(localFailure);
    expect(JSON.stringify(reply)).not.toContain('SECRET_NETWORK_PATH');
    expect(send).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(committedState(session, workspace)).toEqual(before);
  });
});
