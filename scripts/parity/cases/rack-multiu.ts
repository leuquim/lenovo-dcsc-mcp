/** A 2U server at the bottom rack boundary: accepted at U41, refused at U42, state untouched by the refusal. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Json, ParityCase } from '../harness.js';

const CONTRACT = path.resolve('test/fixtures/parity/browser-multi-u-catalog.json');
const RACK_CODE = '7D6DCTO1WW';
const RACK_SIZE_U = 42;
const SERVER_SIZE_U = 2;
const LAST_ACCEPTED_U = RACK_SIZE_U - SERVER_SIZE_U + 1;

const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];

export default {
  id: 'rack-multiu',
  tags: ['rack', 'layout'],
  async run(h) {
    const { mcp, step, compare } = h;
    const contract = object(JSON.parse(await readFile(CONTRACT, 'utf8')));
    const productCode = String(object(contract['product'])['code']);

    const { workspace, server, rackId } = await step('launch-and-add-rack', async () => {
      const launched = await mcp.call('dcsc_launch', { productCode, solutionMode: String(contract['solutionMode']) });
      const added = await mcp.call('dcsc_rack_add', { session: String(launched['workspace']), rackCode: RACK_CODE });
      const rack = rows(added['racks'])[0];
      assert(rack, 'Rack creation returned no rack.');
      compare('rack-size', { sizeU: RACK_SIZE_U }, { sizeU: rack['sizeU'] });
      return { workspace: String(launched['workspace']), server: String(launched['session']), rackId: String(rack['rackId']) };
    });

    const placedRevision = await step('place-at-boundary', async () => {
      const placed = await mcp.call('dcsc_rack_edit', { session: workspace, action: 'place', configuration: server,
        rackId, uPosition: LAST_ACCEPTED_U });
      const item = rows(rows(placed['racks'])[0]?.['items'])[0];
      compare('accepted-boundary', { sizeU: SERVER_SIZE_U, position: LAST_ACCEPTED_U, endPosition: RACK_SIZE_U },
        { sizeU: item?.['sizeU'], position: item?.['position'], endPosition: item?.['endPosition'] });
      return Number(placed['revision']);
    });

    await step('refused-past-boundary', async () => {
      await mcp.call('dcsc_rack_edit', { session: workspace, action: 'place', configuration: server, rackId,
        uPosition: LAST_ACCEPTED_U + 1, expectedRevision: placedRevision }, { expectError: true });
      const saved = mcp.persistedWorkspaces().find(entry => entry['id'] === workspace);
      const item = rows(rows(saved?.['rackArea'])[0]?.['rackItems'])[0];
      compare('refusal-leaves-state', { revision: placedRevision, position: LAST_ACCEPTED_U },
        { revision: saved?.['revision'], position: item?.['position'] });
    });
  },
} satisfies ParityCase;
