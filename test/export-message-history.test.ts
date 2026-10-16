import { describe, expect, it } from 'vitest';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import { SessionStore } from '../src/session/SessionStore.js';

const locale = { country: 'US', geo: 'NA', language: 'en', currency: 'USD' };
const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };

describe('export message history', () => {
  it('retains captured actions but rebuilds validation messages from current workspace configurations', () => {
    const sessions = new SessionStore();
    const rackRaw = {
      id: 'rack-1', sliceCtoCode: 'RACK', type: 'rack', description: 'Rack', quantity: 1,
      warnings: ['Reserve one U for installation.'], tabs: [],
    };
    const rack = sessions.create({ locale, solution, mode: 'cto', raw: rackRaw,
      configurationId: rackRaw.id, reduced: reduceConfiguration(rackRaw, rackRaw.id), primed: true });
    const serverRaw = {
      id: 'server-1', sliceCtoCode: 'SERVER', type: 'server', description: 'Server', quantity: 1,
      tabs: [{ subTabs: [{ info: ['RAID is available.'], sections: [
        { name: 'Storage', errors: ['Select a boot device.'] },
      ] }] }],
    };
    const server = sessions.create({ locale, solution, mode: 'cto', raw: serverRaw,
      configurationId: serverRaw.id, reduced: reduceConfiguration(serverRaw, serverRaw.id), primed: true,
      workspaceId: rack.workspaceId });
    const detachedRaw = {
      id: 'node-removed', sliceCtoCode: 'NODE', type: 'node', description: 'Detached node', quantity: 1,
      tabs: [{ subTabs: [{ sections: [{ name: 'Node', errors: ['Detached diagnostic must not be current.'] }] }] }],
    };
    sessions.create({ locale, solution, mode: 'cto', raw: detachedRaw,
      configurationId: detachedRaw.id, reduced: reduceConfiguration(detachedRaw, detachedRaw.id), primed: true,
      workspaceId: rack.workspaceId });
    const linkedRaw = {
      id: 'server-linked', sliceCtoCode: 'SERVER', type: 'server', description: 'Linked server', quantity: 1,
      tabs: [{ subTabs: [{ warn: ['Linked clone diagnostic must not be a root report.'], sections: [] }] }],
    };
    sessions.create({ locale, solution, mode: 'cto', raw: linkedRaw,
      configurationId: linkedRaw.id, reduced: reduceConfiguration(linkedRaw, linkedRaw.id), primed: true,
      workspaceId: rack.workspaceId });
    const workspace = sessions.getWorkspace(rack.workspaceId)!;
    workspace.rackArea = [{ id: 'rack-1', code: 'RACK', type: 'rack', size: 42, rackItems: [],
      errors: [{ code: '102', message: 'Connect the rack power source.' }] }];
    workspace.serverState = {
      detachedNestedNodeIds: ['node-removed'],
      cloneDependency: { 'rack-1': ['rack-1'], 'server-1': ['server-1', 'server-linked'],
        'node-removed': ['node-removed'] },
      cloneDependencyColor: { 'rack-1': '#1', 'server-1': '#2', 'node-removed': '#3' },
      historyInformation: [{ command: 'Import', description: 'Imported the native workspace.' }, 'malformed'],
      messageHistory: {
      history: [{ command: 'Old fallback', description: 'Must not override import history.' }],
      validationReport: { warn: { stale: { key: 'Old', data: ['Stale warning.'] } } },
    } };

    const exported = buildExportData({ workspace, solution, fileTypes: ['MESSAGE_HISTORY'], validationMode: 'guided' });
    expect(exported.messageHistory).toEqual({
      history: [{ command: 'Import', description: 'Imported the native workspace.' }],
      validationReport: {
        err: { 'server-1': { key: 'Server', data: ['Select a boot device.'] } },
        info: { 'server-1': { key: 'Server', data: ['RAID is available.'] } },
        warn: { 'rack-1': { key: 'Rack', data: ['Connect the rack power source.'], unselectableWarnings: [{
          description: null, warnings: ['Reserve one U for installation.'], unSelectable: true,
        }] } },
        configurations: [],
      },
    });
    expect(JSON.stringify(exported.messageHistory)).not.toContain('Stale warning.');
    expect(JSON.stringify(exported.messageHistory)).not.toContain('Detached diagnostic');
    expect(JSON.stringify(exported.messageHistory)).not.toContain('Linked clone diagnostic');

    const configOnly = buildExportData({ raw: server.raw, config: server.reduced, solution,
      fileTypes: ['MESSAGE_HISTORY'], validationMode: 'guided' });
    expect(configOnly.messageHistory).toEqual({
      history: [],
      validationReport: {
        err: { 'server-1': { key: 'Server', data: ['Select a boot device.'] } },
        info: { 'server-1': { key: 'Server', data: ['RAID is available.'] } },
        warn: {},
        configurations: [],
      },
    });
  });
});
