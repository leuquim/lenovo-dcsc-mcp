/** Live MCP existing-row cable replacement, crash durability and export gate. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const rows = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out');
  const cableIndex = process.argv.indexOf('--cable-part');
  const shared = process.argv.includes('--shared');
  const collision = process.argv.includes('--collision');
  assert(!(shared && collision), 'Use only one of --shared or --collision.');
  const cablePart = cableIndex >= 0 ? process.argv[cableIndex + 1] : '3802';
  assert(cablePart === '3802' || cablePart === 'AVFU', 'Use --cable-part 3802 or AVFU for the captured native cases.');
  const out = path.resolve(outIndex >= 0 ? process.argv[outIndex + 1]! :
    `artifacts/parity-manual-cabling/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(out, { recursive: true });
  const configFile = path.join(out, 'config.json');
  const sessionFile = path.join(out, 'sessions.json');
  const seed = path.resolve(shared || collision
    ? 'test/fixtures/parity/xml/manual-cabling-shared-network.xml'
    : 'test/fixtures/parity/xml/manual-cabling-network.xml');
  await writeFile(configFile, JSON.stringify({ logLevel: 'error', files: {
    persistSessions: true, sessionFile, artifactDir: path.join(out, 'exports'),
  } }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !entry[0].startsWith('DCSC_')));
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let stage = 'start'; let sequence = 0;
  const calls: Obj[] = [];
  const start = async () => {
    transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp/server.ts'], stderr: 'pipe',
      env: { ...env, DCSC_CONFIG: configFile } });
    client = new Client({ name: 'manual-cabling-parity', version: '1.0.0' });
    await client.connect(transport);
    const listed = await client.listTools();
    for (const name of ['dcsc_cabling_connections', 'dcsc_edit_cabling_connection', 'dcsc_export']) {
      assert(listed.tools.some(tool => tool.name === name), `${name} is not registered.`);
    }
  };
  const call = async (name: string, args: Obj): Promise<Obj> => {
    const response = await client!.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
    const text = (response.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text')?.text ?? '';
    const result = object(JSON.parse(text));
    const entry = { name, arguments: args, isError: response.isError === true,
      bytes: Buffer.byteLength(text), result };
    calls.push(entry);
    await writeFile(path.join(out, `${String(++sequence).padStart(3, '0')}-${name}.json`),
      JSON.stringify(entry, null, 2));
    assert.notEqual(response.isError, true, `${name}: ${text}`);
    assert(Buffer.byteLength(text) <= 8_000, `${name} exceeded the tool response budget.`);
    return result;
  };
  const detail = async (workspace: string, revision: number, index = 0): Promise<Obj> => {
    const page = await call('dcsc_cabling_connections', { session: workspace,
      expectedWorkspaceRevision: revision, path: ['connections', String(index)], offset: 0, limit: 50 });
    return Object.fromEntries(rows(page['items']).filter(item => 'value' in item)
      .map(item => [String(item['key']), item['value']]));
  };
  const snapshot = async (): Promise<Obj> => object(JSON.parse(await readFile(sessionFile, 'utf8')));
  try {
    await start();
    stage = 'import';
    const imported = await call('dcsc_import', { filePath: seed, solutionMode: 'HPC and AI - Systems' });
    const workspace = String(imported['workspace']);
    assert(workspace, 'Import returned no workspace.');
    stage = 'inspect';
    const root = await call('dcsc_cabling_connections', { session: workspace, path: [], offset: 0, limit: 20 });
    const revision = Number(root['workspaceRevision']);
    assert(Number.isInteger(revision) && revision > 0, 'Inspection returned no workspace revision.');
    if (collision) {
      stage = 'collision-first-inspect';
      const capturedCollision = object(JSON.parse(await readFile(
        path.resolve('test/fixtures/parity/manual-cabling-collision-swap.json'), 'utf8')));
      const expectedBefore = rows(capturedCollision['before']);
      const expectedAfter = rows(capturedCollision['after']);
      assert.equal(capturedCollision['calculateDistanceCalls'], 0,
        'Captured native same-component port swap unexpectedly recalculates distance.');
      const initial = [await detail(workspace, revision, 0), await detail(workspace, revision, 1)];
      const destinationId = String(object(initial[0]!['destination'])['configurationId']);
      assert(destinationId && initial.every(row =>
        object(row['destination'])['configurationId'] === destinationId),
      'Collision seed rows do not share one physical destination.');
      const edited = initial.find(row => object(row['destination'])['portNumber'] === '2');
      const conflicting = initial.find(row => object(row['destination'])['portNumber'] === '3');
      assert(edited && conflicting, 'Collision seed must occupy destination ports 2 and 3.');
      assert.deepEqual([object(edited['source'])['location'], object(conflicting['source'])['location']],
        expectedBefore.map(row => row['sourceLocation']));
      const beforeCables = [object(edited['cable'])['part'], object(conflicting['cable'])['part']];
      const beforeDistances = [edited['totalDistance'], conflicting['totalDistance']];

      stage = 'collision-swap';
      const swapped = await call('dcsc_edit_cabling_connection', {
        session: workspace, connectionId: String(edited['id']), expectedRevision: revision,
        destination: { configurationId: destinationId, portName: 'RJ45', portNumber: '3' },
      });
      const acceptedRevision = Number(swapped['workspaceRevision']);
      assert.equal(object(object(swapped['connection'])['destination'])['portNumber'],
        expectedAfter[0]!['destinationPortNumber']);
      const displaced = rows(swapped['swappedConnections']);
      assert.equal(displaced.length, 1, 'Occupied-port edit did not report exactly one displaced connection.');
      assert.equal(object(displaced[0]!['destination'])['portNumber'], expectedAfter[1]!['destinationPortNumber']);
      assert.equal(object(swapped['connection'])['type'], 'MANUAL');
      assert.equal(displaced[0]!['type'], 'MANUAL');
      assert.equal(object(swapped['connection'])['compatibleCables'], undefined,
        'Collision mutation response leaked the full compatible cable catalog.');
      assert.equal(displaced[0]!['compatibleCables'], undefined,
        'Displaced mutation response leaked the full compatible cable catalog.');

      const persistedAfter = await snapshot();
      const workspaceAfter = rows(persistedAfter['workspaces'])[0]!;
      const finalConnections = rows(object(workspaceAfter['serverState'])['connections']);
      const finalEdited = finalConnections.find(row => row['sourceLocation'] === expectedAfter[0]!['sourceLocation']);
      const finalDisplaced = finalConnections.find(row => row['sourceLocation'] === expectedAfter[1]!['sourceLocation']);
      assert(finalEdited && finalDisplaced, 'Collision swap lost one of the native source rows.');
      assert.deepEqual([finalEdited['destinationPortNumber'], finalDisplaced['destinationPortNumber']],
        expectedAfter.map(row => row['destinationPortNumber']));
      assert.deepEqual([finalEdited['cablePart'], finalDisplaced['cablePart']],
        beforeCables);
      assert.deepEqual([finalEdited['totalDistance'], finalDisplaced['totalDistance']],
        beforeDistances);
      assert(finalConnections.every(row => row['type'] === 'MANUAL'),
        'Collision swap did not mark both affected rows MANUAL.');

      stage = 'collision-sigkill-restart';
      assert(transport!.pid, 'MCP transport has no child PID.');
      process.kill(transport!.pid!, 'SIGKILL');
      await client!.close(); client = undefined; transport = undefined;
      await start();
      const restarted = [await detail(workspace, acceptedRevision, 0), await detail(workspace, acceptedRevision, 1)];
      assert.deepEqual(restarted.map(row => object(row['destination'])['portNumber']).sort(), ['2', '3']);
      assert.deepEqual(await snapshot(), persistedAfter,
        'Occupied-port swap changed across immediate SIGKILL/restart.');

      stage = 'collision-export';
      const exported = await call('dcsc_export', { session: workspace, fileName: 'manual-cable-collision',
        fileTypes: ['XML', 'QUOTE'] });
      const xmlPath = String(exported['xml']);
      assert(xmlPath && (await readFile(xmlPath)).length > 0, 'Collision export returned no XML.');
      await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'pass',
        scope: 'live-mcp-occupied-port-swap-crash-export', workspace, destinationId,
        revision: { before: revision, accepted: acceptedRevision },
        ports: { before: expectedBefore.map(row => row['destinationPortNumber']),
          after: expectedAfter.map(row => row['destinationPortNumber']) },
        cables: beforeCables, exportXml: xmlPath, calls: calls.length,
      }, null, 2));
      console.log(`PASS occupied-port swap, SIGKILL/restart and export (${calls.length} MCP calls).`);
      return;
    }
    if (shared) {
      stage = 'shared-first-inspect';
      const initial = [await detail(workspace, revision, 0), await detail(workspace, revision, 1)];
      const sharedRows = initial.filter(row => object(row['cable'])['part'] === 'AVFT');
      assert.equal(sharedRows.length, 2, 'Native shared seed must contain two AVFT graph rows.');
      const first = sharedRows[0]!;
      const retained = sharedRows[1]!;
      const destinationId = String(object(first['destination'])['configurationId']);
      assert.equal(object(retained['destination'])['configurationId'], destinationId,
        'Shared rows do not have the same physical destination.');
      const afterShare = await snapshot();
      const sharedWorkspace = rows(afterShare['workspaces'])[0]!;
      const sharedConnections = rows(object(sharedWorkspace['serverState'])['connections']);
      assert.equal(sharedConnections.filter(row => row['cablePart'] === 'AVFT').length, 2,
        'Quantity-preserving share did not produce two AVFT graph rows.');
      const sharedConfig = rows(sharedWorkspace['configurations'])
        .find(item => item['configurationId'] === destinationId)!;
      const selectedResults = (raw: Obj) => rows(raw['tabs']).flatMap(tab => rows(tab['subTabs']))
        .flatMap(subTab => rows(subTab['sections'])).filter(section => section['name'] === 'ETHERNET_CABLE')
        .flatMap(section => rows(section['results']));
      const sharedSelected = selectedResults(object(sharedConfig['raw']));
      assert.equal(sharedSelected.find(result => result['code'] === 'AVFT')?.['quantity'], 2,
        'Import must reconcile the native graph into canonical AVFT quantity two.');
      const physicalResults = (storedWorkspace: Obj) => {
        const physical = rows(storedWorkspace['rackArea']).flatMap(rack => rows(rack['rackItems']))
          .concat(rows(storedWorkspace['nonRackArea'])).find(item => item['id'] === destinationId);
        assert(physical, 'Shared replacement lost its physical destination.');
        return rows(physical['features']).filter(section => section['name'] === 'ETHERNET_CABLE')
          .flatMap(section => rows(section['results']));
      };
      assert.equal(physicalResults(sharedWorkspace).find(result => result['code'] === 'AVFT')?.['quantity'], 2,
        'Import must reconcile the physical destination to AVFT quantity two.');

      stage = 'shared-split';
      const sharedRevision = revision;
      const current = initial;
      const currentFirst = current.find(row => row['id'] === first['id']);
      assert(currentFirst && object(currentFirst['cable'])['part'] === 'AVFT',
        'First row identity or shared AVFT state was not preserved.');
      const split = await call('dcsc_edit_cabling_connection', { session: workspace,
        connectionId: String(currentFirst['id']), cablePart: 'AVFU', expectedRevision: sharedRevision });
      const acceptedRevision = Number(split['workspaceRevision']);
      const persistedAfter = await snapshot();
      const workspaceAfter = rows(persistedAfter['workspaces'])[0]!;
      const finalConnections = rows(object(workspaceAfter['serverState'])['connections']);
      assert.deepEqual(finalConnections.map(row => row['cablePart']).sort(), ['AVFT', 'AVFU'],
        'Shared split did not preserve one old and one new graph row.');
      const configAfter = rows(workspaceAfter['configurations'])
        .find(item => item['configurationId'] === destinationId)!;
      const finalSelected = selectedResults(object(configAfter['raw']));
      assert.equal(finalSelected.find(result => result['code'] === 'AVFT')?.['quantity'], 1,
        'Canonical configuration lost the untouched shared AVFT row.');
      assert.equal(finalSelected.find(result => result['code'] === 'AVFU')?.['quantity'], 1,
        'Canonical configuration did not accept AVFU quantity one.');
      const finalPhysical = physicalResults(workspaceAfter);
      assert.equal(finalPhysical.find(result => result['code'] === 'AVFT')?.['quantity'], 1);
      assert.equal(finalPhysical.find(result => result['code'] === 'AVFU')?.['quantity'], 1);
      const reportedPrice = object(split['configurationChange']);
      assert.equal(reportedPrice['configurationId'], destinationId);
      assert.equal(reportedPrice['priceScope'], 'editable-configuration');

      stage = 'shared-sigkill-restart';
      assert(transport!.pid, 'MCP transport has no child PID.');
      process.kill(transport!.pid!, 'SIGKILL');
      await client!.close(); client = undefined; transport = undefined;
      await start();
      const restarted = [await detail(workspace, acceptedRevision, 0), await detail(workspace, acceptedRevision, 1)];
      assert.deepEqual(restarted.map(row => object(row['cable'])['part']).sort(), ['AVFT', 'AVFU']);
      assert.deepEqual(await snapshot(), persistedAfter,
        'Shared manual cable state changed across immediate SIGKILL/restart.');
      stage = 'shared-export';
      const exported = await call('dcsc_export', { session: workspace, fileName: 'manual-cable-shared',
        fileTypes: ['XML', 'QUOTE'] });
      const xmlPath = String(exported['xml']);
      const xml = await readFile(xmlPath, 'utf8');
      assert(xml.includes('AVFT') && xml.includes('AVFU'), 'Export XML omitted a shared cable part.');
      await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'pass',
        scope: 'live-mcp-shared-cable-quantity-crash-export', workspace, destinationId,
        revision: { before: revision, shared: sharedRevision, accepted: acceptedRevision },
        parts: { shared: ['AVFT', 'AVFT'], final: ['AVFT', 'AVFU'] },
        price: reportedPrice, exportXml: xmlPath, calls: calls.length,
      }, null, 2));
      console.log(`PASS shared cable quantity, SIGKILL/restart and export (${calls.length} MCP calls).`);
      return;
    }
    const before = await detail(workspace, revision);
    assert.equal(object(before['cable'])['part'], 'AVFT', 'Seed current cable is not captured AVFT.');
    const destinationId = String(object(before['destination'])['configurationId']);
    const connectionId = String(before['id']);
    const choicesPage = await call('dcsc_cabling_connections', { session: workspace,
      expectedWorkspaceRevision: revision, path: ['connections', '0', 'compatibleCables'], offset: 0, limit: 50 });
    const choices = rows(choicesPage['items']).map(item => object(item['value']));
    assert(choices.some(choice => choice['part'] === cablePart), `Captured ${cablePart} compatible cable is unavailable.`);
    const persistedBefore = await snapshot();
    const workspaceBefore = rows(persistedBefore['workspaces'])[0]!;
    const configBefore = rows(workspaceBefore['configurations'])
      .find(item => item['configurationId'] === destinationId)!;
    const priceBefore = Number(object(configBefore['raw'])['totalPrice']);
    stage = 'replace';
    const replaced = await call('dcsc_edit_cabling_connection', { session: workspace, connectionId,
      cablePart, expectedRevision: revision });
    assert.equal(object(replaced['connection'])['compatibleCables'], undefined,
      'Mutation response leaked the full compatible cable catalog.');
    assert.equal(object(object(replaced['connection'])['cable'])['part'], cablePart);
    const reportedPrice = object(replaced['configurationChange']);
    assert.equal(reportedPrice['configurationId'], destinationId);
    assert.equal(reportedPrice['priceScope'], 'editable-configuration');
    assert.equal(reportedPrice['currency'], 'USD');
    const acceptedRevision = Number(replaced['workspaceRevision']);
    const persistedAfter = await snapshot();
    const workspaceAfter = rows(persistedAfter['workspaces'])[0]!;
    const connection = rows(object(workspaceAfter['serverState'])['connections'])[0]!;
    assert.equal(connection['cablePart'], cablePart);
    assert.equal(connection['type'], 'MANUAL');
    const configAfter = rows(workspaceAfter['configurations'])
      .find(item => item['configurationId'] === destinationId)!;
    const rawAfter = object(configAfter['raw']);
    const priceAfter = Number(rawAfter['totalPrice']);
    assert(Number.isFinite(priceBefore) && Number.isFinite(priceAfter), 'Authoritative cable prices are unavailable.');
    if (cablePart === '3802') assert(priceAfter < priceBefore,
      `Expected captured existing-code price decrease; before=${priceBefore} after=${priceAfter}.`);
    assert.equal(reportedPrice['previousTotalPrice'], priceBefore);
    assert.equal(reportedPrice['totalPrice'], priceAfter);
    const selected = rows(rawAfter['tabs']).flatMap(tab => rows(tab['subTabs']))
      .flatMap(subTab => rows(subTab['sections'])).filter(section => section['name'] === 'ETHERNET_CABLE')
      .flatMap(section => rows(section['results']));
    assert.equal(selected.filter(result => result['code'] === cablePart).length, 1);
    assert.equal(selected.filter(result => result['code'] === 'AVFT').length, 0);
    const physical = rows(workspaceAfter['rackArea']).flatMap(rack => rows(rack['rackItems']))
      .concat(rows(workspaceAfter['nonRackArea'])).find(item => item['id'] === destinationId);
    assert(physical, 'Replacement lost its physical destination.');
    const physicalCables = rows(physical['features']).filter(section => section['name'] === 'ETHERNET_CABLE')
      .flatMap(section => rows(section['results']));
    assert.equal(physicalCables.find(result => result['code'] === cablePart)?.['quantity'], 1,
      'Replacement did not reach physical destination features.');
    assert(!physicalCables.some(result => result['code'] === 'AVFT'), 'Physical destination retained the old cable.');
    if (cablePart === 'AVFU') {
      assert.equal(physicalCables.find(result => result['code'] === 'AVFU')?.['forAutoConnect'], true);
      assert.equal(physicalCables.find(result => result['code'] === '3802')?.['quantity'], 1,
        'Absent-new-code replacement removed the independent pre-existing cable.');
    }

    stage = 'sigkill-restart';
    assert(transport!.pid, 'MCP transport has no child PID.');
    process.kill(transport!.pid!, 'SIGKILL');
    await client!.close(); client = undefined; transport = undefined;
    await start();
    const afterRestart = await detail(workspace, acceptedRevision);
    assert.equal(object(afterRestart['cable'])['part'], cablePart);
    assert.deepEqual(await snapshot(), persistedAfter, 'Manual cable state changed across immediate SIGKILL/restart.');
    stage = 'export';
    const exported = await call('dcsc_export', { session: workspace, fileName: 'manual-cable-replacement',
      fileTypes: ['XML', 'QUOTE'] });
    const xmlPath = String(exported['xml']);
    const xml = await readFile(xmlPath, 'utf8');
    assert(xml.includes(cablePart), 'Export XML omitted the accepted cable part.');
    await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'pass',
      scope: 'live-mcp-existing-row-cable-replacement-crash-export', workspace, connectionId,
      destinationId, revision: { before: revision, accepted: acceptedRevision },
      price: { before: priceBefore, after: priceAfter }, cable: { before: 'AVFT', after: cablePart },
      exportXml: xmlPath, calls: calls.length,
    }, null, 2));
    console.log(`PASS manual cable replacement, SIGKILL/restart and export (${calls.length} MCP calls).`);
  } catch (error) {
    await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'fail', stage,
      error: error instanceof Error ? error.message : String(error), calls: calls.length }, null, 2));
    throw error;
  } finally {
    await client?.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
