import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { canonicalWorkspaceHash } from '../src/domain/reconciliation.js';
import { DcscService } from '../src/mcp/service.js';
import type { RawConfiguration } from '../src/model/types.js';
import { serializeWorkspaces } from '../src/session/persist.js';

type Obj = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/sr630-launch.json', import.meta.url), 'utf8')) as RawConfiguration;
const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });

function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'error' }));
  services.push(service);
  const raw = structuredClone(fixture);
  raw.id = 'US__integrity_test';
  const session = service.sessions.create({
    locale: service.locale,
    solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
    mode: 'cto', raw, configurationId: raw.id, reduced: reduceConfiguration(raw, raw.id), primed: true,
  });
  const workspace = service.sessions.getWorkspace(session.id)!;
  const saved = JSON.parse(serializeWorkspaces([workspace])) as { workspaces: Obj[] };
  const restored = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'error' }));
  services.push(restored);
  return { service: restored, raw, saved: saved.workspaces[0]!, id: workspace.id };
}

const damageCases: Array<[string, (saved: Obj) => void]> = [
  ['missing configuration', saved => { (saved.configurations as unknown[]).push(null); }],
  ['missing cable endpoint', saved => { saved.cables = [{ id: 'cable1', fromConfigId: 'US__integrity_test', toConfigId: 'missing' }]; }],
  ['missing floor rack', saved => { saved.floorItems = [{ id: 'floor1', rackId: 'missing', x: 1, y: 1 }]; }],
  ['missing PDU rack', saved => { saved.powerSelections = [{ rackId: 'missing', selections: [] }]; }],
];

describe('reconciliation preserves recovery trust boundaries', () => {
  it.each(damageCases)('does not certify legacy %s after quarantining it', async (_name, corrupt) => {
    const { service, saved, id } = setup();
    corrupt(saved);
    service.sessions.restore([saved], { provenance: 'legacy-unverified' });
    const workspace = service.sessions.getWorkspace(id)!;
    expect(workspace.integrity).toBe('damaged');
    expect(workspace.recoveryData?.length).toBeGreaterThan(0);
    const original = canonicalWorkspaceHash(workspace);
    const send = vi.spyOn(service.http, 'send');
    await expect(service.proposeReconciliation(id, service.newCtx())).rejects.toThrow(/repair|re-import/i);
    await expect(service.validate(id, service.newCtx())).rejects.toThrow(/damaged|quarantined/i);
    await expect(service.exportZip(id, { fileTypes: ['XML'], fileName: 'damaged', ctx: service.newCtx() }))
      .rejects.toThrow(/damaged|quarantined/i);
    expect(() => service.assertTrustedWorkspace(id)).toThrow(/damaged|quarantined/i);
    expect(send).not.toHaveBeenCalled();
    expect(canonicalWorkspaceHash(workspace)).toBe(original);
  });

  it('blocks older snapshots whose verified flag coexists with unscoped quarantine', async () => {
    const { service, saved, id } = setup();
    saved.integrity = 'verified';
    saved.recoveryData = [{ lostConfiguration: { id: 'old' } }];
    service.sessions.restore([saved]);
    expect(service.sessions.getWorkspace(id)!.integrity).toBe('damaged');
    const send = vi.spyOn(service.http, 'send');
    expect(() => service.assertTrustedWorkspace(id)).toThrow(/quarantined/i);
    await expect(service.proposeReconciliation(id, service.newCtx())).rejects.toThrow(/quarantined/i);
    expect(send).not.toHaveBeenCalled();
  });

  it('reconciles current configurations without certifying a legacy physical layout', async () => {
    const { service, saved, id, raw } = setup();
    saved.rackArea = [{ id: 'rack1', type: 'rack', code: 'RACK', size: 42, rackItems: [] }];
    saved.floorItems = [{ id: 'floor1', rackId: 'rack1', x: 1, y: 1 }];
    service.sessions.restore([saved], { provenance: 'legacy-unverified' });
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [raw] } } as never);
    const proposal = await service.proposeReconciliation(id, service.newCtx());
    const accepted = await service.acceptReconciliation(id, proposal.id);
    expect(accepted.integrity).toBe('legacy-unverified');
    expect(service.sessions.getWorkspace(id)!.integrityWarnings.join(' ')).toMatch(/physical layout.*unverified/i);
    expect(service.sessions.getWorkspace(id)!.floorItems).toEqual(saved.floorItems);
    const roundtrip = JSON.parse(serializeWorkspaces([service.sessions.getWorkspace(id)!])) as { workspaces: unknown[] };
    const restarted = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'error' }));
    services.push(restarted);
    restarted.sessions.restore(roundtrip.workspaces);
    expect(() => restarted.assertTrustedWorkspace(id)).toThrow(/legacy-unverified/i);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('allows configuration reconciliation after discarding only invalid historical snapshots', async () => {
    const { service, saved, id, raw } = setup();
    (saved.configurations as Obj[])[0]!.snapshots = [null];
    service.sessions.restore([saved], { provenance: 'legacy-unverified' });
    const workspace = service.sessions.getWorkspace(id)!;
    expect(workspace.recoveryData).toEqual([expect.objectContaining({ kind: 'discarded-history', record: null })]);
    vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [raw] } } as never);
    const proposal = await service.proposeReconciliation(id, service.newCtx());
    expect((await service.acceptReconciliation(id, proposal.id)).integrity).toBe('verified');
    expect(() => service.assertTrustedWorkspace(id)).not.toThrow();
    expect(service.sessions.getWorkspace(id)!.recoveryData).toEqual(workspace.recoveryData);
  });
});
