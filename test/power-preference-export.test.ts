import { afterEach, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import { mergeImportedState } from '../src/domain/importLayout.js';
import { removeWorkspaceReferences } from '../src/domain/workspaceReferences.js';
import { DcscService } from '../src/mcp/service.js';

const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });

function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };
  const raw = { id: 'rack-1', code: 'RACK', type: 'rack', quantity: 1, tabs: [] };
  const session = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw,
    configurationId: raw.id, reduced: reduceConfiguration(raw, raw.id), primed: true });
  const workspace = service.sessions.getWorkspace(session.id)!;
  workspace.rackArea = [{ id: raw.id, code: raw.code, type: 'rack', size: 42, rackItems: [] }];
  workspace.powerSelections = [{ rackId: raw.id, pduCode: 'CE6L', cordCode: '6275' }];
  const exported = () => buildExportData({ workspace, solution, fileTypes: ['XML'], validationMode: 'guided' })
    .networkingInformation as Record<string, unknown>;
  return { service, workspace, exported };
}

it('keeps rack BOM summaries separate from the browser power-source preference envelope', () => {
  const { workspace, exported } = setup();
  expect(exported().powerSelection).toEqual([]);
  // Synthetic values exercise the SPA's {rack, selection, preferredPDU} shape;
  // they do not claim a captured, supported source/voltage combination.
  const preference = { rack: 'rack-1', selection: { sourceA: 'source-1' },
    preferredPDU: { sourceA: { code: 'CE6L', retained: { extension: true } } } };
  mergeImportedState(workspace, { networkingInformation: { powerSelection: [preference] } });
  expect(exported().powerSelection).toEqual([preference]);
  expect(workspace.powerSelections).toEqual([{ rackId: 'rack-1', pduCode: 'CE6L', cordCode: '6275' }]);
  (exported().powerSelection as unknown[]).length = 0;
  expect(exported().powerSelection).toEqual([preference]);
  const before = structuredClone(workspace.serverState);
  expect(() => mergeImportedState(workspace, { networkingInformation: { powerSelection: [
    { ...preference, selection: { sourceA: 'different-source' } },
  ] } })).toThrow(/conflicts/);
  expect(workspace.serverState).toEqual(before);
});

it('removes a deleted rack preference and restores it with transactional history', async () => {
  const { service, workspace, exported } = setup();
  const preference = { rack: 'rack-1', selection: {}, preferredPDU: {} };
  workspace.serverState.networkingInformation = { powerSelection: [preference] };
  await service.sessions.transact(workspace.id, {}, draft => {
    removeWorkspaceReferences(draft, new Set(['rack-1']));
  });
  expect(exported().powerSelection).toEqual([]);
  expect(workspace.powerSelections).toEqual([]);
  await service.sessions.undoWorkspace(workspace.id);
  expect(exported().powerSelection).toEqual([preference]);
  expect(workspace.powerSelections).toHaveLength(1);
});
