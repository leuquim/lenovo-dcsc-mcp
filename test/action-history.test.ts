import { describe, expect, it } from 'vitest';

import {
  ACTION_HISTORY_SESSION_TIMESTAMP_KEY,
  appendActionHistory,
  buildNativeHistoryDescription,
} from '../src/domain/actionHistory.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { SessionStore } from '../src/session/SessionStore.js';
import type { WorkspaceSession } from '../src/model/session.js';

const locale = { country: 'US', geo: 'NA', language: 'en', currency: 'USD' };

function workspace(solutionMode = 'HPC and AI - Systems'): WorkspaceSession {
  const store = new SessionStore();
  const raw = {
    id: 'config-1', sliceCtoCode: '7DD1CTOLWW', type: 'node', description: 'ThinkSystem SD535 V3',
    quantity: 1, tabs: [],
  };
  const session = store.create({
    locale,
    solution: { solutionMode, masterSlices: ['HPCGP'] },
    mode: 'cto',
    raw,
    configurationId: raw.id,
    reduced: reduceConfiguration(raw, raw.id),
    primed: true,
  });
  return structuredClone(store.getWorkspace(session.workspaceId)!);
}

describe('native action history', () => {
  it('reproduces the website command description grammar exactly', () => {
    expect(buildNativeHistoryDescription({
      command: 'ADD', type: 'node', code: '7dd1ctolww', location: 'Non Rack Area',
    })).toBe('Add :  Node 7DD1CTOLWW   at Non Rack Area');
    expect(buildNativeHistoryDescription({
      command: 'REMOVE', type: 'node', code: '7dd1ctolww',
      description: 'ThinkSystem SD535 V3-3yr Base Warranty- HPC', location: 'Chassis',
    })).toBe('Remove :  Node 7DD1CTOLWW ThinkSystem SD535 V3-3yr Base Warranty- HPC  at Chassis');
    expect(buildNativeHistoryDescription({
      command: 'CHANGE', description: 'Modified Data networks: Management, ',
    })).toBe('Change :    Modified Data networks: Management,  ');
    expect(buildNativeHistoryDescription({
      command: 'MOVE', quantity: 2, asVLH: true, type: 'server', code: 'srv', location: 'Rack A1',
    })).toBe('Move x2: [VLH] Server SRV   at Rack A1');
    expect(buildNativeHistoryDescription({ command: 'LOCK',
      description: 'Locked position 42 ', location: 'Rack A1' }))
      .toBe('Lock :    Locked position 42   at Rack A1');
  });

  it('preserves imported rows and uses the latest IMPORT as the durable session start', () => {
    const before = workspace();
    before.serverState.messageHistory = { history: [
      { command: 'IMPORT', timestamp: '2026-10-16T00:46:20+02:00', key: 'old' },
      { command: 'ADD', description: 'prior' },
      { command: 'IMPORT', timestamp: '2026-10-16T00:46:21+02:00', key: 'latest' },
      'malformed-but-preserved',
    ] };
    const after = structuredClone(before);

    appendActionHistory(before, after, {
      command: 'REMOVE', type: 'node', code: '7DD1CTOLWW', location: 'Chassis',
    }, {
      now: () => new Date(2026, 9, 16, 1, 2, 3),
      key: () => '6ddfab0e-3bcc-4d26-bfcf-3cf58f6eab8b',
    });

    const rows = after.serverState.historyInformation as Array<Record<string, unknown> | string>;
    expect(rows.slice(0, 4)).toEqual((before.serverState.messageHistory as { history: unknown[] }).history);
    expect(rows[4]).toEqual({
      timestamp: expect.stringMatching(/^2026-10-16T01:02:03[+-]\d\d:\d\d$/),
      key: '6ddfab0e-3bcc-4d26-bfcf-3cf58f6eab8b',
      command: 'REMOVE',
      description: 'Remove :  Node 7DD1CTOLWW   at Chassis',
      sessionTimestamp: '2026-10-16T00:46:21+02:00',
      tooltip: '',
    });
    expect(after.serverState[ACTION_HISTORY_SESSION_TIMESTAMP_KEY])
      .toBe('2026-10-16T00:46:21+02:00');

    const restarted = structuredClone(after);
    appendActionHistory(after, restarted, { command: 'MOVE', type: 'node', location: 'Non Rack Area' }, {
      now: () => new Date(2026, 9, 16, 2, 3, 4), key: () => 'second-key',
    });
    expect((restarted.serverState.historyInformation as Array<Record<string, unknown>>).at(-1)?.sessionTimestamp)
      .toBe('2026-10-16T00:46:21+02:00');
  });

  it.each(['COPY', 'CLONE', 'UNCLONE'] as const)('formats the traced %s hardware command', command => {
    expect(buildNativeHistoryDescription({ command, quantity: 2, type: 'node', code: '7dd1ctolww',
      description: 'ThinkSystem SD535 V3', location: 'Chassis ' }))
      .toBe(`${command[0]}${command.slice(1).toLowerCase()} x2:  Node 7DD1CTOLWW ThinkSystem SD535 V3  at Chassis `);
  });

  it('records an import under the prior session and starts the next action under the import timestamp', () => {
    const before = workspace();
    before.serverState[ACTION_HISTORY_SESSION_TIMESTAMP_KEY] = '2026-10-16T00:46:10+02:00';
    const after = structuredClone(before);
    // The document may carry a different historic session. The new IMPORT
    // describes this operation, not the operation that created the document.
    after.serverState = { historyInformation: [
      { command: 'IMPORT', timestamp: '2026-10-15T23:00:00+02:00', key: 'document-import' },
    ] };
    appendActionHistory(before, after, { command: 'IMPORT', fileName: 'nested-racked-browser.xml' }, {
      now: () => new Date(2026, 9, 16, 0, 46, 21), key: () => 'current-import',
    });
    const rows = after.serverState.historyInformation as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      command: 'IMPORT', key: 'current-import', description: 'Import : nested-racked-browser.xml',
      timestamp: expect.stringMatching(/^2026-10-16T00:46:21[+-]\d\d:\d\d$/),
      sessionTimestamp: '2026-10-16T00:46:10+02:00', tooltip: '',
    });
    expect(after.serverState[ACTION_HISTORY_SESSION_TIMESTAMP_KEY]).toBe(rows[1]!.timestamp);
    const next = structuredClone(after);
    appendActionHistory(after, next, { command: 'REMOVE', type: 'node' });
    expect((next.serverState.historyInformation as Array<Record<string, unknown>>).at(-1)?.sessionTimestamp)
      .toBe(rows[1]!.timestamp);
    expect(() => buildNativeHistoryDescription({ command: 'IMPORT' })).toThrow(/filename/);
  });

  it('uses historyInformation in preference to the fallback without deduplicating rows', () => {
    const before = workspace();
    const duplicate = { command: 'IMPORT', timestamp: '2026-10-16T00:46:21+02:00', key: 'same' };
    before.serverState.historyInformation = [duplicate, duplicate];
    before.serverState.messageHistory = { history: [{ command: 'OLD', key: 'fallback' }] };
    const after = structuredClone(before);
    appendActionHistory(before, after, { command: 'ADD', type: 'rack', location: 'Rack Area' }, {
      now: () => new Date(2026, 9, 16, 2, 3, 4), key: () => 'new',
    });
    expect(after.serverState.historyInformation).toHaveLength(3);
    expect((after.serverState.historyInformation as Array<Record<string, unknown>>)
      .filter(row => row.key === 'same')).toHaveLength(2);
    expect(JSON.stringify(after.serverState.historyInformation)).not.toContain('fallback');
  });

  it('retains prior rows when an accepted response replaces the server-state envelope', () => {
    const before = workspace();
    before.serverState.historyInformation = [
      { command: 'ADD', description: 'Add :  Chassis 7DD0CTOLWW   at Non Rack Area' },
    ];
    const after = structuredClone(before);
    after.serverState = { acceptedResponseField: true };

    appendActionHistory(before, after, { command: 'MOVE', type: 'chassis', location: 'Rack A1' }, {
      now: () => new Date(2026, 9, 16, 2, 3, 4), key: () => 'new',
    });

    expect(after.serverState.historyInformation).toEqual([
      { command: 'ADD', description: 'Add :  Chassis 7DD0CTOLWW   at Non Rack Area' },
      expect.objectContaining({ command: 'MOVE', key: 'new' }),
    ]);
    expect(after.serverState.acceptedResponseField).toBe(true);
  });

  it('does not synthesize action rows for General Purpose or empty events', () => {
    const generalBefore = workspace('General Purpose');
    generalBefore.serverState.historyInformation = [{ command: 'IMPORT', description: 'preserve me' }];
    const generalAfter = structuredClone(generalBefore);
    appendActionHistory(generalBefore, generalAfter, { command: 'ADD', type: 'server' });
    expect(generalAfter.serverState).toEqual(generalBefore.serverState);

    const hpcBefore = workspace();
    const hpcAfter = structuredClone(hpcBefore);
    appendActionHistory(hpcBefore, hpcAfter, []);
    expect(hpcAfter.serverState).toEqual(hpcBefore.serverState);
  });

  it('rejects invalid quantities before mutating the candidate', () => {
    const before = workspace();
    const after = structuredClone(before);
    expect(() => appendActionHistory(before, after, {
      command: 'ADD', quantity: -1,
    })).toThrow('Action history quantity must be a non-negative integer');
    expect(after.serverState).toEqual(before.serverState);
  });
});
