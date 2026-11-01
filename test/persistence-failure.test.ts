import { describe, expect, it } from 'vitest';

import { reduceConfiguration } from '../src/domain/reduce.js';
import type { RawConfiguration } from '../src/model/types.js';
import { SessionPersistenceError } from '../src/http/persistenceError.js';
import { SessionStore } from '../src/session/SessionStore.js';

describe('durable transaction failures', () => {
  it('reports a successful remote callback followed by writer failure without publishing or retrying', async () => {
    const store = new SessionStore();
    const configurationId = 'US__durability';
    const raw: RawConfiguration = {
      id: configurationId,
      sliceCtoCode: '7D73CTO1WW',
      description: 'Durability fixture',
      type: 'SERVER',
      quantity: 1,
      totalPrice: 100,
      tabs: [],
    };
    const session = store.create({
      locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
      solution: { solutionMode: 'General Purpose', masterSlices: ['ISG'] },
      mode: 'cto',
      raw,
      configurationId,
      reduced: reduceConfiguration(raw, configurationId),
      primed: true,
    });
    const workspace = store.getWorkspace(session.id);
    if (!workspace) throw new Error('missing workspace');
    const beforeRaw = structuredClone(session.raw);
    const beforeHistory = structuredClone(workspace.history);
    const beforeSessionRevision = session.revision;
    const beforeWorkspaceRevision = workspace.revision;
    let remoteCalls = 0;
    let writerCalls = 0;
    const diskCause = new Error('ENOSPC: fixture disk full');
    store.setPersistenceWriter(() => {
      writerCalls += 1;
      throw diskCause;
    });

    let failure: unknown;
    try {
      await store.transact(
        session.id,
        {
          remoteApplied: true,
          persistenceFailure: {
            operation: 'configure selection',
            recoveryHint: 'Refresh this configuration before retrying.',
          },
        },
        async (_draft, target) => {
          remoteCalls += 1;
          if (!target) throw new Error('missing target');
          target.raw.quantity = 8;
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SessionPersistenceError);
    expect(failure).toMatchObject({
      code: 'DCSC_LOCAL_NOT_COMMITTED',
      localNotCommitted: true,
      remoteApplied: true,
      operation: 'configure selection',
      recoveryHint: 'Refresh this configuration before retrying.',
      cause: diskCause,
    });
    expect((failure as Error).message).toMatch(/remote operation succeeded/i);
    expect(remoteCalls).toBe(1);
    expect(writerCalls).toBe(1);
    expect(session.raw).toEqual(beforeRaw);
    expect(session.revision).toBe(beforeSessionRevision);
    expect(workspace.revision).toBe(beforeWorkspaceRevision);
    expect(workspace.history).toEqual(beforeHistory);
  });

  it('defaults to remoteApplied false while preserving the original writer cause', async () => {
    const store = new SessionStore();
    const configurationId = 'US__local_only';
    const raw: RawConfiguration = {
      id: configurationId, sliceCtoCode: '7D73CTO1WW', type: 'SERVER', quantity: 1, tabs: [],
    };
    const session = store.create({
      locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
      solution: { solutionMode: 'General Purpose', masterSlices: ['ISG'] },
      mode: 'cto', raw, configurationId,
      reduced: reduceConfiguration(raw, configurationId), primed: true,
    });
    const cause = new TypeError('writer fixture failed');
    store.setPersistenceWriter(() => { throw cause; });

    await expect(store.transact(session.id, {}, (_draft, target) => {
      if (target) target.raw.quantity = 2;
    })).rejects.toMatchObject({
      name: 'SessionPersistenceError',
      localNotCommitted: true,
      remoteApplied: false,
      cause,
    });
  });
});
