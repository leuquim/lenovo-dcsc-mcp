import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';

const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
const capture = JSON.parse(readFileSync(new URL('./fixtures/parity/network-settings-export.json', import.meta.url), 'utf8'));

it('retains browser export flags in requests and puts edited toggles back in the captured export location', async () => {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const raw = { id: 'rack', code: 'RACK', type: 'rack', quantity: 1, tabs: [] };
  const solution = { solutionMode: 'HPC and AI - Systems', masterSlices: ['HPC'] };
  const session = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw,
    configurationId: raw.id, reduced: reduceConfiguration(raw, raw.id), primed: true });
  const workspace = service.sessions.getWorkspace(session.id)!;
  workspace.rackArea = [{ id: raw.id, code: raw.code, type: 'rack', size: 42, rackItems: [] }];
  workspace.serverState = { customizingFlags: capture.customizingFlags,
    networkingInformation: { storageNetworks: capture.storageNetworks, retainedField: { data: true } } };
  const send = vi.spyOn(service.http, 'send').mockImplementation(async request => ({ raw:
    request.endpoint === 'switch_calculation' ? [] : { connections: [], errors: [] } }) as never);
  await service.runAutoConnect(workspace.id, service.newCtx(), workspace.revision);
  expect(send.mock.calls.find(([request]) => request.endpoint === 'auto_connect')![0].body).toMatchObject({ kind: 'json', value: {
    autoConnectSettings: { autoAddPDU: false, autoAddSwitch: true, p2pCabling: true },
    storageConnectionNetworks: capture.storageNetworks,
  } });
  const build = () => buildExportData({ workspace, solution, fileTypes: ['XML'], validationMode: 'guided' });
  expect(build().customizingFlags).toEqual(capture.customizingFlags);
  // A subsequent explicit edit wins over imported flags, including false values.
  await service.runAutoConnect(workspace.id, service.newCtx(), workspace.revision,
    { autoAddSwitch: false, p2pCabling: false });
  const exported = build();
  expect(exported.customizingFlags).toEqual({ ...capture.customizingFlags, autoAddSwitch: false, p2pCabling: false });
  expect(exported.networkingInformation).not.toHaveProperty('autoConnectSettings');
  expect(exported.networkingInformation).toMatchObject({ storageNetworks: capture.storageNetworks,
    retainedField: { data: true } });
  await service.sessions.undoWorkspace(workspace.id);
  expect(build().customizingFlags).toEqual(capture.customizingFlags);
});
