/** Persistence recovery over real stdio: a corrupt workspace document stays inspectable and exportable as exact bytes and survives a restart. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Harness, ParityCase } from '../harness.js';
import { rows } from '../rackUi.js';
import { object } from '../softwareSummaryUi.js';

const CORRUPT_WORKSPACE = 'ws_corrupt_recovery';
const CORRUPT_SOURCE = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0a]);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Places the bytes as a workspace document next to the session file and restarts the server from them. */
async function restartFrom(h: Harness, source: Buffer): Promise<void> {
  const directory = path.join(path.dirname(h.mcp.sessionFile), 'workspaces', CORRUPT_WORKSPACE);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'doc.json'), source);
  await h.mcp.killAndRestart();
}

const corruptSourceCase: ParityCase = {
  id: 'recovery-corrupt-source',
  tags: ['recovery'],
  async run(h) {
    const { mcp, step, compare } = h;
    const archive = await step('recover', async () => {
      await restartFrom(h, CORRUPT_SOURCE);
      await mcp.call('dcsc_session_list', { limit: 1 });
      const health = await mcp.call('dcsc_session_list', { view: 'health' });
      const inspected = await mcp.call('dcsc_session_list', { view: 'recovery', path: ['recoveryArchives'], offset: 0, limit: 1 });
      const entry = object(object(rows(inspected['items'])[0])['value']);
      const exported = await mcp.call('dcsc_recovery_export', { archiveId: entry['id'] });
      compare('archive-inspectable', { archiveCount: 1, inspectTool: 'dcsc_session_list', idShape: true, bytes: CORRUPT_SOURCE.length },
        { archiveCount: object(health['recovery'])['archiveCount'], inspectTool: object(object(health['recovery'])['inspect'])['tool'],
          idShape: /^recovery_[0-9a-f]{64}$/.test(String(entry['id'])), bytes: entry['bytes'] });
      compare('exact-bytes-exported', { bytes: CORRUPT_SOURCE.toString('hex'), sha256: sha256(CORRUPT_SOURCE), format: 'lenovo-dcsc-session-source-bytes' },
        { bytes: readFileSync(String(exported['path'])).toString('hex'), sha256: exported['sha256'], format: exported['format'] });
      return String(entry['id']);
    });
    await step('restart', async () => {
      await mcp.killAndRestart();
      const listed = await mcp.call('dcsc_session_list', { view: 'recovery', path: ['recoveryArchives'], offset: 0, limit: 10 });
      compare('archive-retained-after-restart', true, rows(listed['items']).some(item => object(item['value'])['id'] === archive));
    });
  },
};

export default corruptSourceCase;
