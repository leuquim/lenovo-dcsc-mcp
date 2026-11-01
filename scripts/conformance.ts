/**
 * Conformance test: exercises EVERY registered tool and the paths the happy-path
 * smoke test skips — LFO launch, batched changes, removals, optimistic
 * concurrency, pagination, filters, and the error surface.
 *
 * Fails loudly on the first unmet expectation rather than logging and moving on,
 * so a regression cannot pass quietly.
 *
 * Run with: npx tsx scripts/conformance.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { isolatedChildEnv } from './lib/isolated-runtime.js';

interface Outcome {
  json: unknown;
  bytes: number;
  isError: boolean;
}

interface ToolCoverage {
  calls: number;
  successes: number;
  errors: number;
  maxBytes: number;
}

let client: Client;
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function extract(result: unknown): Outcome {
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = r.content?.find((c) => c.type === 'text')?.text ?? '';
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep as text */
  }
  return { json, bytes: Buffer.byteLength(text, 'utf8'), isError: r.isError === true };
}

async function call(name: string, args: Record<string, unknown>): Promise<Outcome> {
  return extract(await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 }));
}

function check(name: string, condition: boolean, detail: string): void {
  results.push({ name, ok: condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : ` — ${detail}`}`);
}

const MAX_TOOL_BYTES = 8_000;

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/mcp/server.js'],
    env: isolatedChildEnv({ DCSC_LOG_LEVEL: 'error' }),
  });
  client = new Client({ name: 'conformance', version: '1.0.0' });
  await client.connect(transport);

  const registered = (await client.listTools()).tools.map((t) => t.name).sort();
  check(
    'registered tool names are unique',
    new Set(registered).size === registered.length,
    `${registered.length - new Set(registered).size} duplicate registration(s)`,
  );
  const coverage = new Map<string, ToolCoverage>();
  const origCall = call;
  const track = async (name: string, args: Record<string, unknown>): Promise<Outcome> => {
    const out = await origCall(name, args);
    const previous = coverage.get(name) ?? { calls: 0, successes: 0, errors: 0, maxBytes: 0 };
    coverage.set(name, {
      calls: previous.calls + 1,
      successes: previous.successes + (out.isError ? 0 : 1),
      errors: previous.errors + (out.isError ? 1 : 0),
      maxBytes: Math.max(previous.maxBytes, out.bytes),
    });
    if (!out.isError && out.bytes > MAX_TOOL_BYTES) {
      check(`${name} byte budget`, false, `${out.bytes}B exceeds ${MAX_TOOL_BYTES}B`);
    }
    return out;
  };
  const followContinuation = async (
    sourceTool: string,
    outcome: Outcome,
    key: 'next' | 'inspect' = 'next',
  ): Promise<Outcome | undefined> => {
    const next = (outcome.json as Record<string, unknown>)[key];
    const valid =
      typeof next === 'object' &&
      next !== null &&
      typeof (next as { tool?: unknown }).tool === 'string' &&
      typeof (next as { arguments?: unknown }).arguments === 'object' &&
      (next as { arguments?: unknown }).arguments !== null;
    check(
      `${sourceTool} returns an executable continuation`,
      valid,
      JSON.stringify(next).slice(0, 180),
    );
    if (!valid) return undefined;
    const typed = next as { tool: string; arguments: Record<string, unknown> };
    check(
      `${sourceTool} continuation targets a registered tool`,
      registered.includes(typed.tool),
      typed.tool,
    );
    return track(typed.tool, typed.arguments);
  };


  const checkManagedStorageSwitch = async (
    workspace: string,
    controllerId?: string,
  ): Promise<void> => {
    let resolvedControllerId = controllerId;
    if (!resolvedControllerId) {
      const controllerCatalog = await track('dcsc_network_get', { session: workspace,
        collection: 'storageControllers', limit: 100, fields: ['option', 'featureCode'] });
      resolvedControllerId = (controllerCatalog.json as {
        items?: Array<{ id: string; option: string; featureCode?: string }>;
      }).items?.find(item => item.option === '7DJ0CTO1WW' && !item.featureCode)?.id;
      check('storage switch lifecycle discovers its controller', !!resolvedControllerId,
        JSON.stringify(controllerCatalog.json).slice(0, 180));
    }

    const switchCatalog = await track('dcsc_network_get', { session: workspace,
      collection: 'storageSwitches', limit: 100, fields: ['option', 'featureCode'] });
    const storageSwitch = (switchCatalog.json as {
      items?: Array<{ id: string; option: string; featureCode?: string }>;
    }).items?.find(item => item.option === '7DHNCTO1WW' && item.featureCode === 'C1FM');
    check('storage switch lifecycle discovers DB710S C1FM', !!storageSwitch,
      JSON.stringify(switchCatalog.json).slice(0, 180));
    if (!resolvedControllerId || !storageSwitch) return;

    const name = 'Managed SAN Switch';
    const definition = await track('dcsc_storage_set', { session: workspace, change: {
      action: 'add', name, controllerId: resolvedControllerId, switchId: storageSwitch.id, expansionQuantity: 0 } });
    check('managed SAN definition created', !definition.isError,
      JSON.stringify(definition.json).slice(0, 180));
    if (definition.isError) return;

    const customizeSwitch = { action: 'customize', name, component: 'switch' } as const;
    const opened = await track('dcsc_storage_set', { session: workspace, change: customizeSwitch });
    const switchResult = opened.json as {
      configuration?: string; switchId?: string; revision?: number; created?: boolean;
    };
    check('dcsc_storage_set customize returns a managed configuration handle', !opened.isError &&
      switchResult.created === true && !!switchResult.configuration && !!switchResult.switchId,
    JSON.stringify(opened.json).slice(0, 180));
    if (opened.isError || !switchResult.configuration || !switchResult.switchId) return;

    await followContinuation('dcsc_storage_set', opened, 'inspect');
    const reopened = await track('dcsc_storage_set', { session: workspace, change: customizeSwitch,
      expectedRevision: switchResult.revision });
    check('storage switch reopen preserves identity and revision', !reopened.isError &&
      (reopened.json as typeof switchResult).configuration === switchResult.configuration &&
      (reopened.json as typeof switchResult).switchId === switchResult.switchId &&
      (reopened.json as typeof switchResult).revision === switchResult.revision &&
      (reopened.json as typeof switchResult).created === false,
    JSON.stringify(reopened.json).slice(0, 180));

    const summaryResult = await track('dcsc_workspace_get', { session: workspace });
    const summaryJson = summaryResult.json as {
      configurations?: Array<{ id?: string; productCode?: string; quantity?: number;
        configurationQuantity?: number; managedStorageTemplate?: boolean }>;
    };
    const projectedSwitch = summaryJson.configurations?.find(item =>
      item.id === switchResult.configuration || item.productCode === '7DHNCTO1WW');
    check('managed SAN switch has zero commercial quantity while unplaced', !summaryResult.isError &&
      projectedSwitch?.managedStorageTemplate === true && projectedSwitch.quantity === 0 &&
      projectedSwitch.configurationQuantity === 1,
    JSON.stringify(projectedSwitch ?? summaryResult.json).slice(0, 220));

    const layoutResult = await track('dcsc_workspace_get', { session: workspace, view: { kind: 'layout' } });
    const layoutJson = layoutResult.json as {
      unracked?: Array<{ session?: string; code?: string }>;
      totals?: { rawNonRackArea?: number; configurations?: number };
    };
    check('managed SAN switch is absent from physical layout rows', !layoutResult.isError &&
      !(layoutJson.unracked ?? []).some(item => item.session === switchResult.configuration || item.code === '7DHNCTO1WW'),
    JSON.stringify({ unracked: layoutJson.unracked, totals: layoutJson.totals }).slice(0, 220));

    const recovery = await track('dcsc_recovery_export', { session: workspace });
    const recoveryPath = (recovery.json as { path?: string }).path;
    let snapshot: Record<string, unknown> | undefined;
    if (!recovery.isError && recoveryPath) {
      const envelope = JSON.parse(readFileSync(recoveryPath, 'utf8')) as { workspaces?: Record<string, unknown>[] };
      snapshot = envelope.workspaces?.find(candidate => candidate['id'] === workspace);
    }
    const snapshotState = snapshot?.['serverState'] as Record<string, unknown> | undefined;
    const savedNetworks = snapshotState?.['storageConnectionNetworks'];
    const physical = JSON.stringify([snapshot?.['rackArea'] ?? [], snapshot?.['nonRackArea'] ?? []]);
    const switchMap = JSON.stringify(snapshotState?.['switchMap'] ?? []);
    check('managed SAN switch identity is owned only by its storage definition', !!snapshot &&
      JSON.stringify(savedNetworks).includes(switchResult.switchId) &&
      !physical.includes(switchResult.switchId) && !switchMap.includes(switchResult.switchId),
    JSON.stringify({ physicalContainsSwitch: physical.includes(switchResult.switchId),
      switchMapContainsSwitch: switchMap.includes(switchResult.switchId) }));

    const exported = await track('dcsc_export', { kind: 'reports', session: workspace,
      fileName: 'conformance-managed-san-switch', fileTypes: ['XML'] });
    const xmlPath = (exported.json as { xml?: string }).xml;
    const xml = !exported.isError && xmlPath ? readFileSync(xmlPath, 'utf8') : '';
    check('managed unplaced SAN switch does not create a sellable XML row', !exported.isError && !!xmlPath &&
      !/7DHN-?CTO1WW/i.test(xml),
    JSON.stringify({ export: exported.json, containsSwitchCode: /7DHN-?CTO1WW/i.test(xml) }).slice(0, 220));

    const removed = await track('dcsc_storage_set', { session: workspace, change: { action: 'remove', name } });
    check('removing the SAN definition closes its managed switch configuration', !removed.isError &&
      (removed.json as { removedConfigurations?: number }).removedConfigurations === 1,
    JSON.stringify(removed.json).slice(0, 180));
    const afterRemoval = await track('dcsc_workspace_get', { session: switchResult.configuration });
    check('removed managed SAN switch handle is no longer usable', afterRemoval.isError,
      JSON.stringify(afterRemoval.json).slice(0, 180));
  };

  if (process.argv.includes('--storage-only')) {
    const launched = await track('dcsc_launch', { productCode: '7D73CTOHWW', mode: 'cto',
      solutionMode: 'HPC and AI - Systems', label: 'conformance-storage-switch' });
    const target = launched.json as { session?: string; workspace?: string };
    check('storage-only lifecycle launches its supported context', !launched.isError && !!target.workspace,
      JSON.stringify(launched.json).slice(0, 180));
    if (target.workspace) {
      const rack = await track('dcsc_rack_add', { session: target.workspace, rackCode: '7D6DCTO1WW' });
      check('storage-only lifecycle rack setup', !rack.isError, JSON.stringify(rack.json).slice(0, 180));
      await checkManagedStorageSwitch(target.workspace);
      await track('dcsc_session_close', { session: target.workspace });
    }
    await client.close();
    const failed = results.filter(result => !result.ok);
    console.log(`${results.length - failed.length}/${results.length} storage checks passed`);
    process.exitCode = failed.length > 0 ? 1 : 0;
    return;
  }

  // --- discovery -----------------------------------------------------------
  const settings = await track('dcsc_settings_get', {});
  const modeList = (settings.json as { solutionModes?: Array<{ mode: string; masterSlices: string[] }> }).solutionModes;
  check(
    'dcsc_settings_get returns solution modes with slices',
    Array.isArray(modeList) && modeList.length > 0 && (modeList[0]?.masterSlices?.length ?? 0) > 0,
    JSON.stringify(settings.json).slice(0, 120),
  );

  const browse = await track('dcsc_search', { search: { kind: 'tree' } });
  const browseTop = browse.json as { categories?: Array<{ name: string }> };
  check(
    'dcsc_search tree lists root categories',
    (browseTop.categories?.length ?? 0) > 0,
    JSON.stringify(browse.json).slice(0, 120),
  );

  const browseDeep = await track('dcsc_search', { search: { kind: 'tree', categoryPath: ['Servers'] } });
  const deep = browseDeep.json as { path?: string[]; categories?: unknown[] };
  check(
    'dcsc_search tree descends a level',
    deep.path?.[0] === 'Servers' && (deep.categories?.length ?? 0) > 0,
    JSON.stringify(deep).slice(0, 150),
  );

  const broadCto = await track('dcsc_search', { search: { kind: 'products', query: 'ThinkSystem', type: 'CTO', limit: 1 } });
  const broadCtoHits = (broadCto.json as { products: Array<{ code: string }> }).products;
  check('dcsc_search products finds CTO', broadCtoHits.length > 0, 'no hits');
  const ctoNext = await followContinuation('dcsc_search', broadCto);
  if (ctoNext) {
    const nextHits = (ctoNext.json as { products?: Array<{ code: string }> }).products ?? [];
    check(
      'dcsc_search products continuation advances without duplicates',
      nextHits.length > 0 && !broadCtoHits.some((a) => nextHits.some((b) => a.code === b.code)),
      `first=${broadCtoHits.map((p) => p.code).join(',')} next=${nextHits.map((p) => p.code).join(',')}`,
    );
  }
  const cto = await track('dcsc_search', { search: { kind: 'products', query: 'SR630 V3', type: 'CTO', limit: 3 } });
  const ctoHits = (cto.json as { products: Array<{ code: string }> }).products;
  check('dcsc_search products finds the rack-server fixture', ctoHits.length > 0, 'no SR630 V3 hit');

  // LFO is an entirely separate endpoint family and had never been exercised.
  const lfo = await track('dcsc_search', { search: { kind: 'products', query: 'ThinkSystem', type: 'LFO', limit: 5 } });
  const lfoHits = (lfo.json as { products: Array<{ code: string; description: string }> }).products;
  check('dcsc_search products finds LFO', lfoHits.length > 0, 'no LFO products in catalog');

  // --- CTO session ---------------------------------------------------------
  const ctoCode = ctoHits[0]?.code as string;
  const launched = await track('dcsc_launch', { productCode: ctoCode, label: 'conformance-cto' });
  const summary = launched.json as {
    session: string;
    workspace: string;
    revision: number;
    totalPrice: number;
    constraints: unknown[];
    priceType: string;
  };
  const session = summary.session;
  check('dcsc_launch returns a session', typeof session === 'string' && session.length > 0, '');
  check('dcsc_launch stamps priceType LIST', summary.priceType === 'LIST', String(summary.priceType));
  check('dcsc_launch reports constraints', summary.constraints.length > 0, 'no constraints');

  const info = await track('dcsc_workspace_get', { session });
  check(
    'dcsc_workspace_get matches launch',
    (info.json as { totalPrice: number }).totalPrice === summary.totalPrice,
    'price mismatch',
  );
  const controls = await track('dcsc_configure', {
    session,
    validationMode: 'expert',
    autoCorrect: false,
  });
  check(
    'dcsc_configure applies expert mode without auto-correct',
    !controls.isError &&
      (controls.json as { validationMode?: string }).validationMode === 'expert' &&
      (controls.json as { autoCorrect?: boolean }).autoCorrect === false,
    JSON.stringify(controls.json).slice(0, 160),
  );
  // The controls write moved the workspace revision; later stale-write checks use this one.
  const launchRevision = (controls.json as { revision?: number }).revision ?? summary.revision;

  const list = await track('dcsc_session_list', {});
  const listJson = list.json as {
    total: number;
    returned: number;
    sessions: Array<{ session: string; configurationId?: string; label?: string }>;
  };
  check(
    'dcsc_session_list includes the session with its label',
    listJson.sessions.some((s) => s.session === session && s.label === 'conformance-cto'),
    JSON.stringify(listJson.sessions).slice(0, 150),
  );
  // Unbounded, this exceeded the 8 KB tool budget on a warm server.
  check(
    'dcsc_session_list is paginated',
    listJson.returned <= 15 && typeof listJson.total === "number",
    `returned=${listJson.returned} of total=${listJson.total}`,
  );

  // --- options: pagination and filters -------------------------------------
  const page1 = await track('dcsc_configuration_get', {
    session,
    view: 'options',
    section: 'processors.processor',
    limit: 3,
    offset: 0,
  });
  const p1 = page1.json as {
    page: { total: number; offset: number };
    options: Array<{ code: string }>;
    next?: { tool: string; arguments: Record<string, unknown> };
  };
  const page2 = await followContinuation('dcsc_configuration_get', page1);
  const p2 = (page2?.json ?? {}) as { options?: Array<{ code: string }> };
  check(
    'dcsc_configuration_get options paginate without repeating',
    p1.options.length > 0 &&
      (p2.options?.length ?? 0) > 0 &&
      !p1.options.some((a) => p2.options?.some((b) => a.code === b.code)),
    `p1=${p1.options.map((o) => o.code).join(',')} p2=${p2.options?.map((o) => o.code).join(',')}`,
  );
  check(
    'dcsc_configuration_get options offer a structured next call',
    p1.next?.tool === 'dcsc_configuration_get' && typeof p1.next.arguments === 'object',
    JSON.stringify(p1.next),
  );

  const selectedOnly = await track('dcsc_configuration_get', { session, view: 'options', filter: 'selected', limit: 50 });
  const sel = selectedOnly.json as { options: Array<{ sel?: number }> };
  check(
    'dcsc_configuration_get filter=selected returns only selected',
    sel.options.length > 0 && sel.options.every((o) => (o.sel ?? 0) > 0),
    `${sel.options.length} options, some unselected`,
  );

  await track('dcsc_configuration_get', { session, view: 'features', codes: [p1.options[0]?.code ?? 'BYVW'] });

  // --- mutation: batch, removal, concurrency -------------------------------
  const memHits = await track('dcsc_configuration_get', { session, view: 'options', query: 'RDIMM', limit: 10 });
  const memOpt = (memHits.json as { options: Array<{ code: string; sel?: number }> }).options.find(
    (o) => !o.sel,
  );
  const cpuOpt = p1.options.find((o) => o.code !== undefined);

  const batch = await track('dcsc_configure', {
    session,
    changes: [
      { section: 'PROCESSOR', code: cpuOpt?.code ?? 'BYVW', quantity: 1 },
      ...(memOpt ? [{ section: 'MEMORY', code: memOpt.code, quantity: 2 }] : []),
    ],
  });
  const batchDiff = batch.json as {
    revision: number;
    price: { delta: number };
    added: unknown[];
    replaced: unknown[];
    applied: boolean;
  };
  check(
    'dcsc_configure applies a batched change',
    !batch.isError && batchDiff.applied === true,
    JSON.stringify(batch.json).slice(0, 200),
  );
  check(
    'dcsc_configure bumps the revision',
    batchDiff.revision > launchRevision,
    `${launchRevision} -> ${batchDiff.revision}`,
  );

  // Stale revision must be rejected, not silently applied.
  const stale = await track('dcsc_configure', {
    session,
    changes: [{ section: 'PROCESSOR', code: cpuOpt?.code ?? 'BYVW', quantity: 1 }],
    expectedRevision: launchRevision,
  });
  check(
    'dcsc_configure rejects a stale expectedRevision',
    stale.isError,
    'stale write was accepted',
  );

  // --- undo ----------------------------------------------------------------
  const preUndo = await track('dcsc_configuration_get', { session });
  const preUndoPrice = (preUndo.json as { totalPrice: number }).totalPrice;
  const undone = await track('dcsc_undo', { session, scope: 'configuration' });
  const postUndo = await track('dcsc_configuration_get', { session });
  const undonePrice = (postUndo.json as { totalPrice: number }).totalPrice;
  check(
    'dcsc_undo restores the previous price',
    !undone.isError && (undone.json as { changed?: boolean }).changed === true && undonePrice !== preUndoPrice,
    `${preUndoPrice} -> ${undonePrice}`,
  );
  // Undo must restore the model we post back too, not just what we display —
  // otherwise the next export silently describes the undone state.
  const afterUndoBom = await track('dcsc_configuration_get', { session, view: 'selections' });
  const bomTotal = (afterUndoBom.json as { totalPrice: number }).totalPrice;
  check(
    'dcsc_undo leaves display and posted state consistent',
    bomTotal === undonePrice,
    `summary=${undonePrice} bom=${bomTotal}`,
  );

  const reapplied = await track('dcsc_configure', {
    session,
    changes: [{ section: 'PROCESSOR', code: cpuOpt?.code ?? 'BYVW', quantity: 1 }],
  });
  check(
    'configure still works after an undo',
    !reapplied.isError,
    JSON.stringify(reapplied.json).slice(0, 160),
  );

  // --- quantity must reach the EXPORT, not just the summary ----------------
  // A summary that says 8 while the exported CFXML says 1 is a quote short by
  // a factor of 8 — the worst failure mode this server has.
  const QTY = 3;
  const qty = await track('dcsc_configure', { session, salesQuantity: QTY });
  const qtyJson = qty.json as {
    quantity: number;
    totalPrice: number;
    extendedPrice: number;
  };
  check(
    'dcsc_configure salesQuantity extends the price',
    qtyJson.quantity === QTY &&
      Math.abs(qtyJson.extendedPrice - qtyJson.totalPrice * QTY) < 0.01,
    `unit=${qtyJson.totalPrice} extended=${qtyJson.extendedPrice}`,
  );

  const qtyExport = await track('dcsc_export', {
    kind: 'reports',
    session,
    fileName: 'conformance-qty',
    fileTypes: ['XML'],
  });
  const qtyBundle = qtyExport.json as { xml?: string };
  if (qtyBundle.xml) {
    const { readFileSync } = await import('node:fs');
    const xml = readFileSync(qtyBundle.xml, 'utf8');
    const m = /<Quantity>(\d+)<\/Quantity>(?:(?!<Quantity>)[\s\S])*?7DMK|<Quantity>(\d+)<\/Quantity>(?:(?!<Quantity>)[\s\S])*?CTO1WW/.exec(xml);
    const exported = m ? Number(m[1] ?? m[2]) : NaN;
    check(
      'exported CFXML carries the configured quantity',
      exported === QTY,
      `set ${QTY}, XML says ${Number.isNaN(exported) ? 'not found' : exported}`,
    );
  } else {
    check('exported CFXML carries the configured quantity', false, 'no XML produced');
  }

  await track('dcsc_configure', { session, salesQuantity: 1 });

  // --- export with explicit formats ----------------------------------------
  const exported = await track('dcsc_export', {
    kind: 'reports',
    session,
    fileName: 'conformance',
    fileTypes: ['XML', 'QUOTE'],
  });
  const bundle = exported.json as {
    members: Array<{ name: string }>;
    xml?: string;
    warnings: string[];
  };
  check(
    'dcsc_export produces an XML member',
    typeof bundle.xml === 'string' && bundle.members.some((m) => m.name.endsWith('.xml')),
    JSON.stringify(bundle).slice(0, 200),
  );
  check(
    'dcsc_export archive is not empty',
    (bundle.warnings ?? []).every((w) => !w.includes('empty archive')),
    (bundle.warnings ?? []).join('; '),
  );

  const recoveryInspection = await track('dcsc_session_list', { view: 'recovery', path: [], offset: 0, limit: 20 });
  const restoreReport = recoveryInspection.json as { items?: Array<{ key: string }> };
  check('dcsc_session_list recovery exposes restore diagnostics and archives',
    !recoveryInspection.isError && ['warnings', 'quarantined', 'recoveryArchives'].every(
      key => restoreReport.items?.some(item => item.key === key)),
    JSON.stringify(restoreReport).slice(0, 180));
  const recovery = await track('dcsc_recovery_export', { session });
  const recoveryJson = recovery.json as {
    path?: string;
    bytes?: number;
    sha256?: string;
    format?: string;
    warning?: string;
  };
  let recoveryContent = '';
  if (!recovery.isError && recoveryJson.path) {
    recoveryContent = readFileSync(recoveryJson.path, 'utf8');
  }
  check(
    'dcsc_recovery_export writes an integrity-checked local snapshot',
    !recovery.isError &&
      typeof recoveryJson.path === 'string' &&
      recoveryJson.bytes === Buffer.byteLength(recoveryContent) &&
      recoveryJson.sha256 === createHash('sha256').update(recoveryContent).digest('hex'),
    JSON.stringify(recoveryJson).slice(0, 180),
  );
  check(
    'dcsc_recovery_export is explicitly JSON recovery data, not CFXML',
    recoveryJson.format === 'lenovo-dcsc-session-snapshot-v2' &&
      recoveryContent.trimStart().startsWith('{') &&
      !/<CFXML/i.test(recoveryContent) &&
      /not CFXML/i.test(recoveryJson.warning ?? ''),
    `format=${recoveryJson.format} warning=${recoveryJson.warning}`,
  );

  // --- rack & cabling ------------------------------------------------------
  const racks = await track('dcsc_rack_get', {});
  check(
    'dcsc_rack_get lists cabinets',
    ((racks.json as { racks?: unknown[] }).racks?.length ?? 0) > 0,
    JSON.stringify(racks.json).slice(0, 120),
  );

  const addedRack = await track('dcsc_rack_add', { session, rackCode: '7D6DCTO1WW' });
  // The response is a LayoutResult ({racks: [{rackId, ...}]}), not {rack:{id}}.
  // Reading the stale shape made this block silently skip for four tools.
  const rackInfo = addedRack.json as { racks?: Array<{ rackId: string; sizeU: number }> };
  const rackId = rackInfo.racks?.[0]?.rackId;
  check(
    'dcsc_rack_add returns a validated layout',
    !addedRack.isError && typeof rackId === 'string' && (rackInfo.racks?.[0]?.sizeU ?? 0) > 0,
    JSON.stringify(addedRack.json).slice(0, 150),
  );

  if (rackId) {
    const placed = await track('dcsc_rack_edit', {
      session,
      action: 'place',
      rackId,
      configuration: session,
    });
    check('dcsc_rack_edit place puts config in rack', !placed.isError, JSON.stringify(placed.json).slice(0, 120));

    const placedJson = placed.json as { racks?: Array<{ items?: Array<{ id?: string }> }> };
    const physicalItemId = placedJson.racks?.flatMap(rack => rack.items ?? [])[0]?.id;
    check('placed rack item exposes its physical identity', typeof physicalItemId === 'string',
      JSON.stringify(placed.json).slice(0, 180));
    if (physicalItemId) {
      const locked = await track('dcsc_rack_edit', { session, action: 'lock', itemId: physicalItemId });
      check('dcsc_rack_edit lock locks a physical item', !locked.isError &&
        (locked.json as { locked?: boolean; position?: number }).locked === true &&
        ((locked.json as { position?: number }).position ?? 0) > 0,
      JSON.stringify(locked.json).slice(0, 180));
      const unlocked = await track('dcsc_rack_edit', { session, action: 'unlock', itemId: physicalItemId });
      check('dcsc_rack_edit unlock unlocks the same physical item', !unlocked.isError &&
        (unlocked.json as { locked?: boolean }).locked === false,
      JSON.stringify(unlocked.json).slice(0, 180));
    }

    const copied = await track('dcsc_rack_edit', { session, action: 'copy' });
    const copyJson = copied.json as {
      copy?: { session?: string };
      source?: { session?: string }; placement?: { configurationId?: string; rackId?: string; position?: number };
    };
    check('dcsc_rack_edit copy creates an independently placed configuration', !copied.isError &&
      typeof copyJson.copy?.session === 'string' && copyJson.source?.session === session &&
      copyJson.placement?.rackId === rackId && (copyJson.placement.position ?? 0) > 0,
    JSON.stringify(copied.json).slice(0, 260));
    if (copyJson.copy?.session) await track('dcsc_session_close', { session: copyJson.copy.session });

    const unplaced = await track('dcsc_rack_edit', {
      session,
      action: 'unplace',
      configuration: session,
    });
    check('dcsc_rack_edit unplaces a configuration', !unplaced.isError, JSON.stringify(unplaced.json).slice(0, 140));
    const layoutUndo = await track('dcsc_undo', { session, action: 'undo' });
    check(
      'dcsc_undo undoes a complete layout edit',
      !layoutUndo.isError && (layoutUndo.json as { changed?: boolean }).changed === true,
      JSON.stringify(layoutUndo.json).slice(0, 140),
    );
    const layoutRedo = await track('dcsc_undo', { session, action: 'redo' });
    check(
      'dcsc_undo redoes a complete layout edit',
      !layoutRedo.isError && (layoutRedo.json as { changed?: boolean }).changed === true,
      JSON.stringify(layoutRedo.json).slice(0, 140),
    );
    await track('dcsc_undo', { session, action: 'undo' });

    const floor = await track('dcsc_floor_set', { session, change: { kind: 'place', rackId, x: 2, y: 3 } });
    check('dcsc_floor_set positions rack on grid', !floor.isError, JSON.stringify(floor.json).slice(0, 120));

    const pdu = await track('dcsc_rack_get', { session, rackId });
    const pduJson = pdu.json as {
      lineCordOptions?: { total?: number };
    };
    check('dcsc_rack_get lists power options for a rack', !pdu.isError, JSON.stringify(pdu.json).slice(0, 120));
    // Regression: line cords used to be truncated out of a flat cord list.
    check(
      'dcsc_rack_get surfaces line cords separately from jumpers',
      (pduJson.lineCordOptions?.total ?? 0) > 0,
      `lineCord total=${pduJson.lineCordOptions?.total}`,
    );
    const pduSet = await track('dcsc_pdu_set', { session, rackId,
      pduCode: (pdu.json as { pduOptions?: { options?: Array<{ code: string }> } }).pduOptions?.options?.[0]?.code ?? 'C0CS' });
    check('dcsc_pdu_set accepts a PDU selection from the listed options', !pduSet.isError,
      JSON.stringify(pduSet.json).slice(0, 180));

    const pciChoices = await track('dcsc_wizard_get', { session, wizard: 'pci' });
    const pciPage = pciChoices.json as { revision?: number; items?: Array<{ key: string; value?: unknown }> };
    check('dcsc_wizard_get reports native PCI availability', !pciChoices.isError &&
      typeof pciPage.items?.find(item => item.key === 'available')?.value === 'boolean', JSON.stringify(pciChoices.json).slice(0, 180));
    const invalidPci = await track('dcsc_wizard_set', { session, wizard: 'pci',
      expectedRevision: pciPage.revision, optionId: '__invalid_pci_option__' });
    check('dcsc_wizard_set rejects unavailable PCI option IDs', invalidPci.isError === true, JSON.stringify(invalidPci.json).slice(0, 180));

    const power = await track('dcsc_power_get', { session });
    const powerChoices = await track('dcsc_power_get', { session, section: 'controls' });
    const powerChoicePage = powerChoices.json as { revision?: number; items?: Array<{ key: string; value?: unknown }> };
    const powerChoiceValues = Object.fromEntries((powerChoicePage.items ?? []).map(item => [item.key, item.value]));
    check('dcsc_power_get controls discovers native voltage and load-factor controls', !powerChoices.isError &&
      powerChoiceValues['available'] === true, JSON.stringify(powerChoices.json).slice(0, 180));
    const previousPower = powerChoiceValues['current'] as { loadFactor?: number } | undefined;
    const savedPower = await track('dcsc_power_set', { session,
      expectedRevision: powerChoicePage.revision, loadFactor: 30 });
    check('dcsc_power_set retains the accepted load factor', !savedPower.isError &&
      (savedPower.json as { current?: { loadFactor?: number } }).current?.loadFactor === 30,
    JSON.stringify(savedPower.json).slice(0, 180));
    if (!savedPower.isError && previousPower?.loadFactor !== undefined) {
      await track('dcsc_power_set', { session,
        expectedRevision: (savedPower.json as { revision: number }).revision,
        loadFactor: previousPower.loadFactor });
    }
    check(
      'dcsc_power_get aggregates the workspace',
      !power.isError && (power.json as { total?: unknown }).total !== undefined,
      JSON.stringify(power.json).slice(0, 120),
    );

    // The layout is only readable here — export cannot carry rack data.
    const layout = await track('dcsc_workspace_get', { session, view: { kind: 'layout' } });
    const layoutJson = layout.json as { rackCount?: number; racks?: unknown };
    check(
      'dcsc_workspace_get layout reads back the placed racks',
      !layout.isError && layoutJson.racks !== undefined,
      JSON.stringify(layout.json).slice(0, 150),
    );
  }

  const val = await track('dcsc_validate', { session });
  check('dcsc_validate returns validation report', !val.isError, JSON.stringify(val.json).slice(0, 120));
  const validation = val.json as { jobId?: string };
  const inspectedValidation = await track('dcsc_workspace_get', {
    session, view: { kind: 'validation', jobId: validation.jobId } });
  check(
    'dcsc_workspace_get validation inspects the saved validation result without rerunning it',
    !inspectedValidation.isError && JSON.stringify(inspectedValidation.json).includes(validation.jobId ?? '__missing__'),
    JSON.stringify(inspectedValidation.json).slice(0, 180),
  );
  check(
    'dcsc_workspace_get validation inspection respects the tool output budget',
    inspectedValidation.bytes <= MAX_TOOL_BYTES,
    `${inspectedValidation.bytes}B`,
  );
  const validationJobs = await track('dcsc_workspace_get', { session, view: 'validation' });
  check(
    'dcsc_workspace_get validation lists the just-completed job',
    !validationJobs.isError && JSON.stringify(validationJobs.json).includes(validation.jobId ?? '__missing__'),
    JSON.stringify(validationJobs.json).slice(0, 180),
  );

  // --- import & diff --------------------------------------------------------
  if (bundle.xml) {
    const imported = await track('dcsc_import', {
      filePath: bundle.xml,
      mode: 'cto',
    });
    check('dcsc_import re-hydrates CFXML', !imported.isError, JSON.stringify(imported.json).slice(0, 150));

    if (!imported.isError) {
      const impSession = ((imported.json as { configurations: Array<{ id: string }> }).configurations[0])?.id;
      if (impSession) {
        const diff = await track('dcsc_compare', {
          analysis: { kind: 'parts', sessionA: session, sessionB: impSession },
        });
        check('dcsc_compare parts compares configurations', !diff.isError, JSON.stringify(diff.json).slice(0, 150));
        await track('dcsc_session_close', { session: impSession });
      }
    }
  }

  // --- authoritative existing-row manual cabling -------------------------
  // This tracked seed is a browser-exported populated Management graph. It
  // keeps discovery and the coupled cable-selection derive in conformance;
  // an empty auto-connect response would only prove transport success.
  const manualSeed = new URL('../test/fixtures/parity/xml/manual-cabling-network.xml', import.meta.url).pathname;
  const manualImported = await track('dcsc_import', {
    filePath: manualSeed,
    solutionMode: 'HPC and AI - Systems',
  });
  const manualWorkspace = (manualImported.json as { session?: string }).session;
  check('manual cabling fixture imports a populated graph', !manualImported.isError && !!manualWorkspace,
    JSON.stringify(manualImported.json).slice(0, 180));
  if (manualWorkspace) {
    const manualRoot = await track('dcsc_cabling_get', {
      session: manualWorkspace, path: [], offset: 0, limit: 20,
    });
    const manualRevision = (manualRoot.json as { revision?: number }).revision;
    check('dcsc_cabling_get exposes revision-bound graph navigation', !manualRoot.isError &&
      Number.isInteger(manualRevision) && JSON.stringify(manualRoot.json).includes('connections'),
    JSON.stringify(manualRoot.json).slice(0, 220));
    if (manualRevision !== undefined) {
      const rowPage = await track('dcsc_cabling_get', {
        session: manualWorkspace, expectedRevision: manualRevision,
        path: ['connections', '0'], offset: 0, limit: 50,
      });
      const rowValues = Object.fromEntries(((rowPage.json as {
        items?: Array<{ key?: string; value?: unknown }>;
      }).items ?? []).filter(item => item.key !== undefined).map(item => [item.key!, item.value]));
      const connectionId = typeof rowValues['id'] === 'string' ? rowValues['id'] : undefined;
      check('manual cabling row detail exposes a stable ID and current cable', !rowPage.isError &&
        !!connectionId && typeof (rowValues['cable'] as { part?: unknown } | undefined)?.part === 'string',
      JSON.stringify(rowPage.json).slice(0, 220));

      const cablePage = await track('dcsc_cabling_get', {
        session: manualWorkspace, expectedRevision: manualRevision,
        path: ['connections', '0', 'compatibleCables'], offset: 0, limit: 50,
      });
      const cableChoices = ((cablePage.json as {
        items?: Array<{ value?: { part?: string } }>;
      }).items ?? []).map(item => item.value).filter((item): item is { part: string } =>
        typeof item?.part === 'string');
      check('manual cabling exposes exact compatible cable identifiers', !cablePage.isError &&
        cableChoices.some(choice => choice.part === '3802'), JSON.stringify(cablePage.json).slice(0, 220));

      if (connectionId && cableChoices.some(choice => choice.part === '3802')) {
        const manualEdited = await track('dcsc_cabling_set', {
          session: manualWorkspace, expectedRevision: manualRevision,
          changes: [{ action: 'edit', connectionId, cablePart: '3802' }],
        });
        const edited = manualEdited.json as {
          revision?: number;
          results?: Array<{ connection?: { cable?: { part?: string } };
            configurationChange?: { priceScope?: string; session?: string } }>;
        };
        const editedRow = edited.results?.[0];
        check('dcsc_cabling_set edit commits the accepted cable derive', !manualEdited.isError &&
          edited.revision === manualRevision + 1 && editedRow?.connection?.cable?.part === '3802' &&
          editedRow.configurationChange?.priceScope === 'editable-configuration' &&
          typeof editedRow.configurationChange.session === 'string',
        JSON.stringify(manualEdited.json).slice(0, 260));
      }
    }
    await track('dcsc_session_close', { session: manualWorkspace });
  }

  // --- native manual creation on a populated graph -----------------------
  const createImported = await track('dcsc_import', {
    filePath: new URL('../test/fixtures/parity/xml/manual-cabling-shared-network.xml', import.meta.url).pathname,
    solutionMode: 'HPC and AI - Systems',
  });
  const createWorkspace = (createImported.json as { session?: string }).session;
  check('native creation fixture imports', !createImported.isError && !!createWorkspace, JSON.stringify(createImported.json).slice(0, 200));
  if (createWorkspace) {
    const root = await track('dcsc_cabling_get', { session: createWorkspace });
    const revision = (root.json as { revision?: number }).revision;
    const example = JSON.parse(readFileSync(new URL('../test/fixtures/parity/manual-row-seeding.json', import.meta.url), 'utf8')).requestedManualRow;
    const candidate = { network: example.network, topology: example.topology,
      source: { configurationId: example.sourceId, portName: 'RJ45', portNumber: '1' },
      destination: { configurationId: example.destinationId, portName: 'RJ45', portNumber: '20' } };
    const options = await track('dcsc_cabling_get', { session: createWorkspace, expectedRevision: revision,
      candidate, path: ['choices'], offset: 0, limit: 50 });
    check('native manual discovery offers a compatible cable', !options.isError && JSON.stringify(options.json).includes('3791'), JSON.stringify(options.json).slice(0, 200));
    const created = await track('dcsc_cabling_set', { session: createWorkspace, expectedRevision: revision,
      changes: [{ action: 'create', ...candidate, cablePart: '3791', pinExistingRoutes: true }] });
    const accepted = created.json as { revision?: number; results?: Array<{ pinnedConnectionCount?: number;
      connection?: { type?: string; source?: { portName?: string }; cable?: { part?: string } } }> };
    const createdRow = accepted.results?.[0];
    check('native manual creation pins prior routes and accepts requested cable', !created.isError &&
      accepted.revision === Number(revision) + 1 && Number(createdRow?.pinnedConnectionCount) > 0 &&
      createdRow?.connection?.type === 'MANUAL' && createdRow.connection.source?.portName === 'RJ45' && createdRow.connection.cable?.part === '3791', JSON.stringify(created.json).slice(0, 250));
    await track('dcsc_session_close', { session: createWorkspace });
  }

  // --- LFO session ---------------------------------------------------------
  if (lfoHits[0]) {
    const lfoLaunch = await track('dcsc_launch', {
      productCode: lfoHits[0].code,
      mode: 'lfo',
      label: 'conformance-lfo',
    });
    const lfoOk = !lfoLaunch.isError;
    check(
      'dcsc_launch works for an LFO (preconfigured) model',
      lfoOk,
      JSON.stringify(lfoLaunch.json).slice(0, 220),
    );
    if (lfoOk) {
      const lfoSession = (lfoLaunch.json as { session: string }).session;
      const lfoInfo = await track('dcsc_workspace_get', { session: lfoSession });
      // A preconfigured model has no sections, so priming is skipped by
      // design rather than failed. What must hold is that we say which it is,
      // and that we did not burn a guaranteed-400 request finding out.
      const lfoJson = lfoInfo.json as { primed?: boolean; configurable?: boolean; note?: string };
      check(
        'LFO session reports whether it is configurable at all',
        typeof lfoJson.configurable === 'boolean',
        JSON.stringify(lfoJson).slice(0, 150),
      );
      // Pure "lfo" mode cannot be primed — DCSC rejects the autoDerive body.
      // That is acceptable (a preconfigured model is meant to be taken as-is),
      // but only if we say so and name the mode that does work.
      check(
        'an unprimed LFO explains itself and names the working mode',
        lfoJson.primed === true ||
          (typeof lfoJson.note === 'string' && lfoJson.note.includes('lfo-as-cto')),
        `primed=${lfoJson.primed} note=${lfoJson.note?.slice(0, 80)}`,
      );

      // lfo-as-cto is the mode that yields a configurable, primed tree.
      const asCto = await track('dcsc_launch', {
        productCode: lfoHits[0].code,
        mode: 'lfo-as-cto',
      });
      const asCtoSession = (asCto.json as { session?: string }).session;
      if (asCtoSession) {
        const asCtoInfo = await track('dcsc_workspace_get', { session: asCtoSession });
        check(
          'lfo-as-cto primes where plain lfo cannot',
          (asCtoInfo.json as { primed?: boolean }).primed === true,
          JSON.stringify(asCtoInfo.json).slice(0, 150),
        );
        await track('dcsc_session_close', { session: asCtoSession });
      }

      const lfoBom = await track('dcsc_configuration_get', { session: lfoSession, view: 'selections' });
      check(
        'LFO configuration has selections',
        ((lfoBom.json as { selections?: unknown[] }).selections?.length ?? 0) > 0,
        'no selections',
      );
      // LFO has its own endpoint family for mutation AND export; routing an
      // LFO session to the /ctos/* routes fails, so both must be exercised.
      const lfoOpts = await track('dcsc_configuration_get', {
        session: lfoSession,
        view: 'options',
        filter: 'selected',
        limit: 5,
      });
      const lfoSel = (lfoOpts.json as { options: Array<{ code: string }> }).options;
      check('LFO session lists options', lfoSel.length > 0, 'no options');

      const lfoExport = await track('dcsc_export', {
        kind: 'reports',
        session: lfoSession,
        fileName: 'conformance-lfo',
        fileTypes: ['XML'],
      });
      const lfoBundle = lfoExport.json as { xml?: string; warnings?: string[] };
      check(
        'dcsc_export works for an LFO session',
        !lfoExport.isError && typeof lfoBundle.xml === 'string',
        JSON.stringify(lfoExport.json).slice(0, 200),
      );

      await track('dcsc_session_close', { session: lfoSession });
    }
  }

  // --- standalone software and product-bound services ---------------------
  const parts = await track('dcsc_search', { search: {
    kind: 'parts',
    query: 'ThinkSystem',
    types: ['HARDWARE', 'SOFTWARE', 'SERVICE'],
    limit: 50,
  } });
  const partRows = (parts.json as { parts?: Array<{ code: string }> }).parts ?? [];
  check('dcsc_search parts returns a bounded fifty-row page', partRows.length > 0 && partRows.length <= 50,
    JSON.stringify(parts.json).slice(0, 160));
  if ((parts.json as { next?: unknown }).next !== undefined) {
    const nextParts = await followContinuation('dcsc_search', parts);
    if (nextParts) {
      const nextRows = (nextParts.json as { parts?: Array<{ code: string }> }).parts ?? [];
      check(
        'dcsc_search parts continuation advances without duplicates',
        nextRows.length > 0 && !partRows.some((a) => nextRows.some((b) => a.code === b.code)),
        `first=${partRows.map((p) => p.code).join(',')} next=${nextRows.map((p) => p.code).join(',')}`,
      );
    }
  }

  const softwareLaunch = await track('dcsc_launch', { mode: 'software', label: 'conformance-software' });
  const softwareWorkspace = (softwareLaunch.json as { session?: string }).session;
  check('dcsc_launch software creates a workspace', typeof softwareWorkspace === 'string', JSON.stringify(softwareLaunch.json).slice(0, 160));
  if (softwareWorkspace) {
    let sessionPage = await track('dcsc_session_list', { offset: 0, limit: 1 });
    let foundStandalone = false;
    for (let page = 0; page < 100; page += 1) {
      const rows = (sessionPage.json as {
        sessions?: Array<{ session?: string; kind?: string }>;
        next?: unknown;
      }).sessions ?? [];
      if (rows.some((row) => row.session === softwareWorkspace && row.kind === 'workspace')) {
        foundStandalone = true;
        break;
      }
      if ((sessionPage.json as { next?: unknown }).next === undefined) break;
      const nextPage = await followContinuation('dcsc_session_list', sessionPage);
      if (!nextPage) break;
      sessionPage = nextPage;
    }
    check(
      'dcsc_session_list paginates to a standalone-only workspace',
      foundStandalone,
      `workspace=${softwareWorkspace}`,
    );
    const softwarePage = await track('dcsc_basket_browse', {
      session: softwareWorkspace,
      basket: 'software',
      limit: 50,
    });
    const softwareRows = (softwarePage.json as { software?: Array<{ code: string }> }).software ?? [];
    check('dcsc_basket_browse software returns a bounded fifty-row page', softwareRows.length > 0 && softwareRows.length <= 50,
      JSON.stringify(softwarePage.json).slice(0, 160));
    const nextSoftware = await followContinuation('dcsc_basket_browse', softwarePage);
    if (nextSoftware) {
      const nextRows = (nextSoftware.json as { software?: Array<{ code: string }> }).software ?? [];
      check(
        'dcsc_basket_browse software continuation advances without duplicates',
        nextRows.length > 0 && !softwareRows.some((first) => nextRows.some((next) => next.code === first.code)),
        `first=${softwareRows.map(row => row.code).join(',')} next=${nextRows.map(row => row.code).join(',')}`,
      );
    }
    const softwareCode = softwareRows[0]?.code;
    if (softwareCode) {
      const selectedSoftware = await track('dcsc_basket_set', {
        session: softwareWorkspace,
        basket: 'software',
        action: 'select',
        code: softwareCode,
        quantity: 2,
      });
      check('dcsc_basket_set software select adds a priced basket line', !selectedSoftware.isError, JSON.stringify(selectedSoftware.json).slice(0, 160));
      const softwareQuantity = await track('dcsc_basket_set', {
        session: softwareWorkspace,
        basket: 'software',
        action: 'setQuantity',
        code: softwareCode,
        quantity: 3,
      });
      check(
        'dcsc_basket_set software setQuantity updates the selected line',
        !softwareQuantity.isError &&
          (softwareQuantity.json as { selections?: Array<{ quantity: number }> }).selections?.[0]?.quantity === 3,
        JSON.stringify(softwareQuantity.json).slice(0, 160),
      );
      const refreshedSoftware = await track('dcsc_launch', {
        mode: 'software',
        session: softwareWorkspace,
        refresh: true,
      });
      const afterSoftwareRefresh = await track('dcsc_workspace_get', {
        session: softwareWorkspace, view: 'baskets', basket: 'software' });
      check(
        'dcsc_launch software refresh keeps the catalog without clearing the basket',
        !refreshedSoftware.isError && !afterSoftwareRefresh.isError &&
          (afterSoftwareRefresh.json as { selections?: unknown[] }).selections?.length === 1,
        JSON.stringify(afterSoftwareRefresh.json).slice(0, 180),
      );
      const softwareInspect = await track('dcsc_workspace_get', { session: softwareWorkspace, view: 'baskets' });
      check('dcsc_workspace_get baskets reads the basket', !softwareInspect.isError, JSON.stringify(softwareInspect.json).slice(0, 160));
      const softwareExport = await track('dcsc_export', {
        kind: 'reports',
        session: softwareWorkspace,
        fileName: 'conformance-software',
        fileTypes: ['XML'],
      });
      check('dcsc_export writes a non-empty software artifact', !softwareExport.isError, JSON.stringify(softwareExport.json).slice(0, 180));
      const removedSoftware = await track('dcsc_basket_set', {
        session: softwareWorkspace,
        basket: 'software',
        action: 'remove',
        code: softwareCode,
      });
      check(
        'dcsc_basket_set software remove empties the selected basket',
        !removedSoftware.isError &&
          ((removedSoftware.json as { selections?: unknown[] }).selections?.length ?? -1) === 0,
        JSON.stringify(removedSoftware.json).slice(0, 160),
      );
    }
    await track('dcsc_session_close', { session: softwareWorkspace });
  }

  const serviceLaunch = await track('dcsc_launch', {
    mode: 'services',
    productCode: ctoCode,
    productQuantity: 1,
    label: 'conformance-services',
  });
  const serviceWorkspace = (serviceLaunch.json as { session?: string }).session;
  check('dcsc_launch services creates a workspace', typeof serviceWorkspace === 'string', JSON.stringify(serviceLaunch.json).slice(0, 180));
  if (serviceWorkspace) {
    const servicePage = await track('dcsc_basket_browse', {
      session: serviceWorkspace,
      basket: 'services',
      limit: 1,
    });
    const serviceRows = (servicePage.json as { options?: Array<{ code: string }> }).options ?? [];
    check('dcsc_basket_browse services returns options', serviceRows.length === 1, JSON.stringify(servicePage.json).slice(0, 180));
    const nextServices = await followContinuation('dcsc_basket_browse', servicePage);
    if (nextServices) {
      const nextRows = (nextServices.json as { options?: Array<{ code: string }> }).options ?? [];
      check(
        'dcsc_basket_browse services continuation advances without duplicates',
        nextRows.length === 1 && nextRows[0]?.code !== serviceRows[0]?.code,
        `first=${serviceRows[0]?.code} next=${nextRows[0]?.code}`,
      );
    }
    const serviceCode = serviceRows[0]?.code;
    if (serviceCode) {
      const selectedService = await track('dcsc_basket_set', {
        session: serviceWorkspace,
        basket: 'services',
        action: 'select',
        code: serviceCode,
        quantity: 1,
      });
      check('dcsc_basket_set services select obtains authoritative summary pricing', !selectedService.isError, JSON.stringify(selectedService.json).slice(0, 180));
      type ServiceProjection = {
        revision?: number;
        product?: { quantity?: number };
        selections?: Array<{ code: string; quantity: number }>;
        summary?: unknown;
      };
      const retainedQuantity = await track('dcsc_basket_set', {
        session: serviceWorkspace,
        basket: 'services',
        action: 'setQuantity',
        code: serviceCode,
        quantity: 1,
      });
      const retained = retainedQuantity.json as ServiceProjection;
      check('dcsc_basket_set services setQuantity retains an accepted selection and refreshes pricing',
        !retainedQuantity.isError &&
          retained.selections?.find(row => row.code === serviceCode)?.quantity === 1 &&
          retained.summary !== undefined,
        JSON.stringify(retainedQuantity.json).slice(0, 180));
      const serviceQuantity = await track('dcsc_basket_set', {
        session: serviceWorkspace,
        basket: 'services',
        action: 'setQuantity',
        code: serviceCode,
        quantity: 2,
        expectedRevision: retained.revision,
      });
      const afterQuantity = await track('dcsc_basket_browse', { session: serviceWorkspace, basket: 'services' });
      const savedQuantity = afterQuantity.json as ServiceProjection;
      if (serviceQuantity.isError) {
        const rejected = serviceQuantity.json as { kind?: string; error?: string };
        check('dcsc_basket_set services setQuantity rejects normalized quantities without changing saved state',
          rejected.kind === 'invalid_request' &&
            /requestedQuantity=2, acceptedQuantity=1/.test(rejected.error ?? '') &&
            !afterQuantity.isError && savedQuantity.revision === retained.revision &&
            isDeepStrictEqual(savedQuantity.product, retained.product) &&
            isDeepStrictEqual(savedQuantity.selections, retained.selections) &&
            isDeepStrictEqual(savedQuantity.summary, retained.summary),
          JSON.stringify(serviceQuantity.json).slice(0, 300));
      } else {
        check('dcsc_basket_set services setQuantity saves only the exact requested quantity',
          !afterQuantity.isError &&
            savedQuantity.selections?.find(row => row.code === serviceCode)?.quantity === 2 &&
            savedQuantity.summary !== undefined,
          JSON.stringify(afterQuantity.json).slice(0, 180));
      }
      const productQuantity = await track('dcsc_basket_set', {
        session: serviceWorkspace,
        basket: 'services',
        action: 'setProductQuantity',
        quantity: 3,
      });
      check(
        'dcsc_basket_set services setProductQuantity preserves service quantities and reprices covered products',
        !productQuantity.isError &&
          (productQuantity.json as ServiceProjection).product?.quantity === 3 &&
          isDeepStrictEqual((productQuantity.json as ServiceProjection).selections, savedQuantity.selections),
        JSON.stringify(productQuantity.json).slice(0, 180),
      );
      const refreshedServices = await track('dcsc_launch', { mode: 'services', session: serviceWorkspace, refresh: true });
      const afterServiceRefresh = await track('dcsc_basket_browse', { session: serviceWorkspace, basket: 'services' });
      const beforeRefresh = productQuantity.json as { selections?: unknown; summary?: unknown; product?: unknown };
      const afterRefresh = afterServiceRefresh.json as typeof beforeRefresh;
      check('dcsc_launch services refresh preserves saved selections and pricing',
        !refreshedServices.isError && !afterServiceRefresh.isError &&
        JSON.stringify(beforeRefresh.selections) === JSON.stringify(afterRefresh.selections) &&
        JSON.stringify(beforeRefresh.summary) === JSON.stringify(afterRefresh.summary) &&
        JSON.stringify(beforeRefresh.product) === JSON.stringify(afterRefresh.product),
        JSON.stringify(afterServiceRefresh.json).slice(0, 180));
      const serviceExport = await track('dcsc_export', {
        kind: 'reports',
        session: serviceWorkspace,
        fileName: 'conformance-services',
      });
      check('dcsc_export writes a non-empty services artifact', !serviceExport.isError, JSON.stringify(serviceExport.json).slice(0, 180));
      const removedService = await track('dcsc_basket_set', { session: serviceWorkspace, basket: 'services', action: 'remove' });
      check(
        'dcsc_basket_set services remove clears the selection',
        !removedService.isError &&
          ((removedService.json as { selections?: unknown[] }).selections?.length ?? -1) === 0,
        JSON.stringify(removedService.json).slice(0, 180),
      );
    }
    await track('dcsc_session_close', { session: serviceWorkspace });
  }

  // --- error surface -------------------------------------------------------
  const badSession = await track('dcsc_workspace_get', { session: 'sess_nope_000000' });
  check('unknown session returns a tool error', badSession.isError, 'no error raised');
  check(
    'unknown session error names the recovery path',
    JSON.stringify(badSession.json).includes('dcsc_session_list'),
    JSON.stringify(badSession.json).slice(0, 150),
  );

  const badProduct = await track('dcsc_launch', { productCode: 'NOTAREALCODE' });
  check('invalid product code returns a tool error', badProduct.isError, 'no error raised');
  const badProductText = JSON.stringify(badProduct.json);
  check(
    'invalid product error leaks no internals',
    !/com\.lenovo|select .*from|xpaas/i.test(badProductText),
    badProductText.slice(0, 200),
  );

  // --- teardown ------------------------------------------------------------
  const closed = await track('dcsc_session_close', { session });
  check('dcsc_session_close reports success', (closed.json as { closed: boolean }).closed === true, '');

  const afterClose = await track('dcsc_workspace_get', { session });
  check('closed session is really gone', afterClose.isError, 'session still usable');

  await track('dcsc_session_list', { view: 'health' });

  // --- solution design surface ---------------------------------------------
  const locales = await track('dcsc_settings_get', { localeQuery: '' });
  check(
    'dcsc_settings_get lists countries',
    ((locales.json as { locales?: { items?: unknown[] } }).locales?.items?.length ?? 0) > 0,
    JSON.stringify(locales.json).slice(0, 120),
  );
  const setLocale = await track('dcsc_settings_set', { country: 'US' });
  check('dcsc_settings_set accepts a valid country', !setLocale.isError, JSON.stringify(setLocale.json).slice(0, 120));

  const fabric = await track('dcsc_network_get', { collection: 'topologies', limit: 1 });
  const topologyRows = (fabric.json as {
    items?: Array<{ id: string; shortName: string }>;
    collections?: Record<string, number>;
  }).items ?? [];
  check(
    'dcsc_network_get pages topologies and inventories all collections',
    topologyRows.length === 1 &&
      Object.values((fabric.json as { collections?: Record<string, number> }).collections ?? {}).some((n) => n > 0),
    JSON.stringify(fabric.json).slice(0, 160),
  );
  if ((fabric.json as { next?: unknown }).next !== undefined) {
    const nextFabric = await followContinuation('dcsc_network_get', fabric);
    if (nextFabric) {
      const nextRows = (nextFabric.json as { items?: Array<{ id: string }> }).items ?? [];
      check(
        'dcsc_network_get continuation advances without duplicates',
        nextRows.length > 0 && nextRows[0]?.id !== topologyRows[0]?.id,
        `first=${topologyRows[0]?.id} next=${nextRows[0]?.id}`,
      );
    }
  }

  const networkCatalog = await track('dcsc_network_get', {
    collection: 'networkTypes',
    limit: 50,
  });
  const networkTypes = (networkCatalog.json as {
    items?: Array<{ id: string; defaultNetworkTechnology?: string }>;
  }).items ?? [];
  check('dcsc_network_get lists network types', networkTypes.length > 0, JSON.stringify(networkCatalog.json).slice(0, 160));

  const svcCats = await track('dcsc_category', { category: { kind: 'services' } });
  check('dcsc_category services responds', !svcCats.isError, JSON.stringify(svcCats.json).slice(0, 120));

  const referenceCatalog = await track('dcsc_reference_solutions', { view: 'categories', limit: 5 });
  check('native reference categories are discoverable', !referenceCatalog.isError &&
    Number((referenceCatalog.json as { total?: number }).total) > 0, JSON.stringify(referenceCatalog.json).slice(0, 200));
  const reference = await track('dcsc_launch', { mode: 'reference-solution', sid: 'SID0000978', solutionMode: 'General Purpose' });
  const originalReference = await track('dcsc_export', { kind: 'reference', crnId: 'SID0000978', solutionMode: 'General Purpose' });
  check('original reference XML downloads', !originalReference.isError &&
    typeof (originalReference.json as { path?: string }).path === 'string', JSON.stringify(originalReference.json).slice(0, 160));
  check('native reference solution customizes into a workspace', !reference.isError &&
    typeof (reference.json as { session?: string }).session === 'string', JSON.stringify(reference.json).slice(0, 200));
  const referenceWorkspace = (reference.json as { session?: string; revision?: number });
  if (referenceWorkspace.session) {
    const members = await track('dcsc_session_list', { session: referenceWorkspace.session });
    const member = (members.json as { sessions?: Array<{ session: string; kind: string }> }).sessions?.find(s => s.kind === 'configuration');
    if (member) {
      const loaded = await track('dcsc_launch', { mode: 'unconfigured', session: member.session, expectedRevision: referenceWorkspace.revision });
      check('Unconfigured catalog loads', !loaded.isError, JSON.stringify(loaded.json).slice(0, 160));
      const edited = await track('dcsc_configure', { session: member.session,
        expectedRevision: (loaded.json as { revision?: number }).revision,
        changes: [{ section: 'UNCONFIGURED_COMMVAULT_SOFTWARE', code: '7S1M004HWW', quantity: 4 }] });
      check('Unconfigured selection edit commits', !edited.isError, JSON.stringify(edited.json).slice(0, 160));
      const pci = await track('dcsc_wizard_get', { session: member.session, wizard: 'pci' });
      const savedPci = await track('dcsc_wizard_set', { session: member.session, wizard: 'pci',
        expectedRevision: (pci.json as { revision?: number }).revision,
        optionId: '1P Rear5-a', rowId: '2', enabled: true });
      check('PCI wizard commits a native validated slot change', !savedPci.isError &&
        (savedPci.json as { affectedConfigurationCount?: number }).affectedConfigurationCount === 1,
      JSON.stringify(savedPci.json).slice(0, 180));
    }
  }

  const storageReference = await track('dcsc_launch', { mode: 'reference-solution', sid: 'SID0001064', solutionMode: 'General Purpose' });
  const storageReferenceWorkspace = (storageReference.json as { session?: string }).session;
  if (storageReferenceWorkspace) {
    const listed = await track('dcsc_session_list', { session: storageReferenceWorkspace });
    const member = (listed.json as { sessions?: Array<{ session: string; product?: string }> }).sessions?.find(s => s.product === '7DJRCTO1WW');
    check('storage wizard reference exposes its server handle', !!member, JSON.stringify(listed.json).slice(0, 160));
    if (member) {
      const choices = await track('dcsc_wizard_get', { session: member.session, wizard: 'storage' });
      const page = choices.json as { revision?: number; items?: Array<{ key: string; value?: unknown }> };
      check('storage wizard discovers native choices', !choices.isError && page.items?.find(i => i.key === 'available')?.value === true,
        JSON.stringify(choices.json).slice(0, 160));
      const selected = await track('dcsc_wizard_set', { session: member.session, wizard: 'storage',
        expectedRevision: page.revision, optionId: '4-2' });
      check('storage wizard commits an explicit linked option', !selected.isError &&
        (selected.json as { affectedConfigurationCount?: number }).affectedConfigurationCount === 4,
        JSON.stringify(selected.json).slice(0, 160));
    }
  }

  const design = await track('dcsc_launch', { productCode: ctoCode, mode: 'cto', label: 'conformance-design' });
  const designSession = (design.json as { session?: string }).session;
  const designWorkspace = (design.json as { workspace?: string }).workspace;
  const rival = await track('dcsc_launch', { productCode: ctoCode, mode: 'cto', label: 'conformance-rival' });
  const rivalSession = (rival.json as { session?: string }).session;
  if (designSession && designWorkspace && rivalSession) {
    const proposed = await track('dcsc_reconcile_workspace', {
      session: rivalSession,
      action: 'propose',
    });
    const proposalId = (proposed.json as { proposalId?: string }).proposalId;
    check(
      'dcsc_reconcile_workspace creates a reviewable proposal',
      !proposed.isError && typeof proposalId === 'string',
      JSON.stringify(proposed.json).slice(0, 180),
    );
    const inspected = await followContinuation('dcsc_reconcile_workspace', proposed);
    if (proposalId && inspected) {
      check(
        'dcsc_reconcile_workspace inspects the proposal before apply',
        !inspected.isError &&
          (inspected.json as { proposalId?: string }).proposalId === proposalId,
        JSON.stringify(inspected.json).slice(0, 180),
      );
      const applied = await track('dcsc_reconcile_workspace', {
        session: rivalSession,
        action: 'apply',
        proposalId,
      });
      check(
        'dcsc_reconcile_workspace explicitly applies the reviewed proposal',
        !applied.isError,
        JSON.stringify(applied.json).slice(0, 180),
      );
    }

    const role = await track('dcsc_network_set', { session: designSession, change: { kind: 'nodeRole', role: 'Compute' } });
    check('dcsc_network_set nodeRole tags the configuration', !role.isError, JSON.stringify(role.json).slice(0, 140));

    let topologyChoice:
      | { topology: string; networkName: string; connectorId?: string | undefined }
      | undefined;
    for (const network of networkTypes) {
      if (!network.defaultNetworkTechnology) continue;
      const connectors = await track('dcsc_network_get', {
        session: designSession,
        collection: 'connectors',
        topology: network.defaultNetworkTechnology,
        limit: 1,
      });
      const connectorJson = connectors.json as {
        total?: number;
        items?: Array<{ id?: string }>;
        next?: unknown;
      };
      if (!connectors.isError && (connectorJson.total ?? 0) > 0) {
        check('dcsc_network_get connectors returns a bounded connector page', connectorJson.items?.length === 1, JSON.stringify(connectors.json).slice(0, 150));
        if (connectorJson.next !== undefined) await followContinuation('dcsc_network_get', connectors);
        topologyChoice = {
          topology: network.defaultNetworkTechnology,
          networkName: network.id,
          ...(connectorJson.items?.[0]?.id !== undefined
            ? { connectorId: connectorJson.items[0].id }
            : {}),
        };
        break;
      }
    }
    if (topologyChoice) {
      const topo = await track('dcsc_network_set', {
        session: designSession,
        change: {
          kind: 'topology',
          topology: topologyChoice.topology,
          networkName: topologyChoice.networkName,
          ...(topologyChoice.connectorId !== undefined
            ? { connectorIds: [topologyChoice.connectorId] }
            : {}),
          autoConnect: false,
        },
      });
      check('dcsc_network_set topology selects a catalog topology', !topo.isError, JSON.stringify(topo.json).slice(0, 150));
    } else {
      check('fabric topology setup', false, 'no topology has a compatible connector on this configuration');
    }

    let preferences: Outcome | undefined;
    let selectedNetwork: string | undefined;
    for (const network of networkTypes) {
      const candidate = await track('dcsc_network_set', {
        session: designWorkspace,
        change: { kind: 'preferences', selections: [{ networkTypeId: network.id }], autoConnect: false },
      });
      if (!candidate.isError) {
        preferences = candidate;
        selectedNetwork = network.id;
        break;
      }
    }
    check(
      'dcsc_network_set preferences accepts a catalog network selection',
      preferences !== undefined && !preferences.isError,
      `tried=${networkTypes.map((network) => network.id).join(',')}`,
    );
    if (preferences) {
      check(
        'dcsc_network_set preferences returns the selected stable ID',
        JSON.stringify(preferences.json).includes(selectedNetwork ?? '__missing__'),
        JSON.stringify(preferences.json).slice(0, 180),
      );
    }

    const storageCatalog = await track('dcsc_network_get', { collection: 'storageControllers', limit: 1 });
    const controller = (storageCatalog.json as { items?: Array<{ id?: string }> }).items?.[0];
    if (controller?.id) {
      const storage = await track('dcsc_storage_set', {
        session: designSession, change: { action: 'add', name: 'Conformance Storage', controllerId: controller.id },
      });
      check('dcsc_storage_set add creates a saved unassigned definition', !storage.isError &&
        (storage.json as { storageNetworkCount?: number }).storageNetworkCount === 1,
      JSON.stringify(storage.json).slice(0, 200));
      const storageRevision = (storage.json as { revision?: number }).revision;
      const inspection = (storage.json as { inspect?: { tool: string; arguments: Record<string, unknown> } }).inspect;
      if (inspection) {
        const detail = await track(inspection.tool, inspection.arguments);
        check('storage inspection continuation exposes the saved definition', !detail.isError &&
          JSON.stringify(detail.json).includes('Conformance Storage'), JSON.stringify(detail.json).slice(0, 200));
      }
      if (storageRevision !== undefined) {
        const updatedStorage = await track('dcsc_storage_set', {
          session: designSession,
          change: { action: 'update', name: 'Conformance Storage',
            changes: { layout: 'Minimal Cabling', expansionQuantity: 0 } },
          expectedRevision: storageRevision,
        });
        check('dcsc_storage_set update changes preferences with workspace CAS', !updatedStorage.isError &&
          (updatedStorage.json as { revision?: number; autoConnectRequired?: boolean }).revision === storageRevision + 1 &&
          (updatedStorage.json as { autoConnectRequired?: boolean }).autoConnectRequired === true,
        JSON.stringify(updatedStorage.json).slice(0, 220));
      } else {
        check('storage definition returns a revision for update CAS', false,
          JSON.stringify(storage.json).slice(0, 180));
      }
      const renameStorage = await track('dcsc_storage_set', {
        session: designSession, change: { action: 'rename', name: 'Conformance Storage', newName: 'Renamed Storage' },
      });
      check('dcsc_storage_set rename renames the definition', !renameStorage.isError,
        JSON.stringify(renameStorage.json).slice(0, 200));
      const removeStorage = await track('dcsc_storage_set', {
        session: designSession, change: { action: 'remove', name: 'Renamed Storage' },
      });
      check('dcsc_storage_set remove removes the unassigned definition', !removeStorage.isError &&
        (removeStorage.json as { storageNetworkCount?: number }).storageNetworkCount === 0,
      JSON.stringify(removeStorage.json).slice(0, 200));
    } else check('storage definition catalog setup', false, 'No storage controller returned');

    // Keep the captured AI/HPC storage lifecycle independent of the comparison
    // workspace: its managed controller is not an ordinary physical rack item.
    const storageLaunch = await track('dcsc_launch', { productCode: '7D73CTOHWW', mode: 'cto',
      solutionMode: 'HPC and AI - Systems', label: 'conformance-storage' });
    const storageTarget = storageLaunch.json as { session?: string; workspace?: string };
    check('storage lifecycle launches its supported server context', !storageLaunch.isError && !!storageTarget.session,
      JSON.stringify(storageLaunch.json).slice(0, 160));
    if (storageTarget.session && storageTarget.workspace) {
      const hbaOptions = await track('dcsc_configuration_get', { session: storageTarget.session, view: 'options', query: 'ATZV' });
      const hba = (hbaOptions.json as { options?: Array<{ code: string; sectionId: string }> }).options?.find(option => option.code === 'ATZV');
      check('storage HBA has a directly usable discovery target', !!hba?.sectionId, JSON.stringify(hbaOptions.json).slice(0, 160));
      if (hba) {
        const selected = await track('dcsc_configure', { session: storageTarget.session,
          changes: [{ section: hba.sectionId, code: hba.code, quantity: 1 }] });
        check('storage HBA edit succeeds', !selected.isError, JSON.stringify(selected.json).slice(0, 160));
      }
      const storageRack = await track('dcsc_rack_add', { session: storageTarget.workspace, rackCode: '7D6DCTO1WW' });
      const storageRackId = (storageRack.json as { racks?: Array<{ rackId?: string }> }).racks?.[0]?.rackId;
      check('storage lifecycle rack setup', !storageRack.isError, JSON.stringify(storageRack.json).slice(0, 160));
      const catalog = await track('dcsc_network_get', { session: storageTarget.workspace,
        collection: 'storageControllers', limit: 100, fields: ['option', 'featureCode'] });
      const selectedController = (catalog.json as { items?: Array<{ id: string; option: string; featureCode?: string }> })
        .items?.find(item => item.option === '7DJ0CTO1WW' && !item.featureCode);
      check('storage lifecycle discovers its controller', !!selectedController, JSON.stringify(catalog.json).slice(0, 160));
      if (selectedController) {
        const definition = await track('dcsc_storage_set', { session: storageTarget.workspace, change: {
          action: 'add', name: 'Managed Storage', controllerId: selectedController.id, expansionQuantity: 0 } });
        check('managed storage definition created', !definition.isError, JSON.stringify(definition.json).slice(0, 160));
        const customizeController = { action: 'customize', name: 'Managed Storage', component: 'controller' } as const;
        const opened = await track('dcsc_storage_set', { session: storageTarget.workspace, change: customizeController });
        const controllerResult = opened.json as { configuration?: string; revision?: number; created?: boolean };
        check('dcsc_storage_set customize returns a controller configuration handle', !opened.isError &&
          controllerResult.created === true && !!controllerResult.configuration, JSON.stringify(opened.json).slice(0, 160));
        if (!opened.isError) {
          await followContinuation('dcsc_storage_set', opened, 'inspect');
          const reopened = await track('dcsc_storage_set', { session: storageTarget.workspace,
            change: customizeController, expectedRevision: controllerResult.revision });
          check('storage controller reopen preserves identity and revision', !reopened.isError &&
            (reopened.json as typeof controllerResult).configuration === controllerResult.configuration &&
            (reopened.json as typeof controllerResult).revision === controllerResult.revision &&
            (reopened.json as typeof controllerResult).created === false, JSON.stringify(reopened.json).slice(0, 160));
        }
        const assigned = await track('dcsc_storage_set', { session: storageTarget.session,
          change: { action: 'assign', networkName: 'Managed Storage', autoConnect: false } });
        check('dcsc_storage_set assign accepts the named storage selection', !assigned.isError &&
          (assigned.json as { selectedStorageNetwork?: string }).selectedStorageNetwork === 'Managed Storage',
        JSON.stringify(assigned.json).slice(0, 160));
        const cablingSettings = await track('dcsc_auto_connect', { session: storageTarget.workspace,
          settings: { autoAddPDU: false, autoAddSwitch: false, p2pCabling: false } });
        check('storage placement disables automated PDU creation explicitly', !cablingSettings.isError,
          JSON.stringify(cablingSettings.json).slice(0, 180));
        if (storageRackId && controllerResult.configuration) {
          const storagePlacement = await track('dcsc_storage_set', {
            session: storageTarget.workspace, change: { action: 'place', name: 'Managed Storage', rackId: storageRackId },
          });
          const placementJson = storagePlacement.json as {
            placements?: Array<{ role?: string; rackId?: string; position?: number }>;
            inspect?: { tool?: string; arguments?: Record<string, unknown> };
          };
          check('dcsc_storage_set place performs the website physical placement', !storagePlacement.isError &&
            (placementJson.placements?.length ?? 0) > 0 &&
            placementJson.placements?.every(item => item.rackId === storageRackId && (item.position ?? 0) > 0) === true &&
            placementJson.inspect?.tool === 'dcsc_workspace_get',
          JSON.stringify(storagePlacement.json).slice(0, 260));
          if (placementJson.inspect?.tool && placementJson.inspect.arguments) {
            let placementInspection = await track(placementJson.inspect.tool, placementJson.inspect.arguments);
            let inspectionText = JSON.stringify(placementInspection.json);
            // Layout projections intentionally return navigation rows for large
            // raw objects. Follow the returned item continuation instead of
            // assuming the rack ID is duplicated into the parent page.
            for (let depth = 0; depth < 5 && !placementInspection.isError &&
                !inspectionText.includes(storageRackId); depth += 1) {
              const page = placementInspection.json as { next?: unknown; items?: Array<{ next?: unknown }> };
              const candidate = [page.next, ...(page.items ?? []).map(item => item.next)].find(value => {
                const next = value as { tool?: unknown; arguments?: unknown } | undefined;
                return typeof next?.tool === 'string' && !!next.arguments && typeof next.arguments === 'object';
              }) as { tool: string; arguments: Record<string, unknown> } | undefined;
              if (!candidate || !registered.includes(candidate.tool)) break;
              placementInspection = await track(candidate.tool, candidate.arguments);
              inspectionText = JSON.stringify(placementInspection.json);
            }
            check('storage placement inspection continuation is executable', !placementInspection.isError &&
              inspectionText.includes(storageRackId), inspectionText.slice(0, 180));
          }
        } else {
          check('storage placement prerequisites expose rack and controller handles', false,
            JSON.stringify({ storageRackId, controllerSession: controllerResult.configuration }));
        }
        const cleared = await track('dcsc_storage_set', { session: storageTarget.session,
          change: { action: 'assign', networkName: null } });
        check('storage assignment can be cleared', !cleared.isError &&
          (cleared.json as { selectedStorageNetwork?: string }).selectedStorageNetwork === '', JSON.stringify(cleared.json).slice(0, 160));
        await checkManagedStorageSwitch(storageTarget.workspace, selectedController.id);
      }
      await track('dcsc_session_close', { session: storageTarget.workspace });
    }

    const scale = await track('dcsc_compare', {
      analysis: { kind: 'scale-out', session: designSession, nodes: 4, rackCode: '7D6DCTO1WW' },
    });
    check(
      'dcsc_compare scale-out sizes against DCSC placement rules',
      !scale.isError && ((scale.json as { nodesPerRack?: number }).nodesPerRack ?? 0) > 0,
      JSON.stringify(scale.json).slice(0, 160),
    );

    const explain = await track('dcsc_configuration_get', { session: designSession, view: 'explain' });
    check('dcsc_configuration_get explain reports DCSC-authored changes', !explain.isError, JSON.stringify(explain.json).slice(0, 150));

    const compare = await track('dcsc_compare', {
      analysis: { kind: 'scenarios', sessions: [designSession, rivalSession] },
    });
    check(
      'dcsc_compare scenarios ranks two catalog-backed designs',
      !compare.isError &&
        ((compare.json as { scenarios?: unknown[] }).scenarios?.length ?? 0) === 2,
      JSON.stringify(compare.json).slice(0, 160),
    );
    await track('dcsc_session_close', { session: designSession });
    await track('dcsc_session_close', { session: rivalSession });
  } else {
    check('solution design fixture setup', false, 'could not launch two catalog-backed sessions');
  }

  // --- cloning -------------------------------------------------------------
  // Costs no DCSC requests: the copy is made from the source's own tree.
  const cloneSource = await track('dcsc_launch', {
    productCode: ctoCode,
    mode: 'cto',
  });
  const cloneSessionId = (cloneSource.json as { session?: string }).session;
  if (cloneSessionId) {
    const cloned = await track('dcsc_rack_edit', {
      session: cloneSessionId,
      action: 'clone',
      count: 2,
      labelPrefix: 'conformance node',
    });
    const cj = cloned.json as {
      created?: Array<{ session: string; configurationId: string }>;
      totalConfigurations?: number;
    };
    check(
      'dcsc_rack_edit clone creates N distinct configurations',
      !cloned.isError &&
        cj.created?.length === 2 &&
        new Set(cj.created.map((c) => c.configurationId)).size === 2,
      JSON.stringify(cloned.json).slice(0, 180),
    );
    check(
      'clones share the workspace with their source',
      cj.totalConfigurations === 3,
      `totalConfigurations=${cj.totalConfigurations}`,
    );
    await track('dcsc_session_close', { session: cloneSessionId });
  } else {
    check('dcsc_rack_edit clone setup', false, 'could not launch a clone source');
  }

  // --- anonymous parity tools coverage -------------------------------------
  const hwAdd = await track('dcsc_basket_set', { basket: 'hardware', action: 'select', code: '4X77A08621', quantity: 2 });
  check('dcsc_basket_set hardware select creates standalone workspace', !hwAdd.isError, JSON.stringify(hwAdd.json).slice(0, 160));
  const hwWs = (hwAdd.json as { session?: string }).session;
  if (hwWs) {
    const hwInspect = await track('dcsc_workspace_get', { session: hwWs, view: 'baskets', basket: 'hardware' });
    check('dcsc_workspace_get baskets reports hardware selections', !hwInspect.isError, JSON.stringify(hwInspect.json).slice(0, 160));
    const hwQty = await track('dcsc_basket_set', { session: hwWs, basket: 'hardware', action: 'setQuantity', code: '4X77A08621', quantity: 3 });
    check('dcsc_basket_set hardware setQuantity updates total', !hwQty.isError, JSON.stringify(hwQty.json).slice(0, 160));
    const hwRem = await track('dcsc_basket_set', { session: hwWs, basket: 'hardware', action: 'remove', code: '4X77A08621' });
    check('dcsc_basket_set hardware remove clears selections', !hwRem.isError, JSON.stringify(hwRem.json).slice(0, 160));
    await track('dcsc_session_close', { session: hwWs });
  }

  const parityLaunch = await track('dcsc_launch', { productCode: '7D73CTO1WW', mode: 'cto' });
  const paritySession = (parityLaunch.json as { session?: string }).session;
  const parityWs = (parityLaunch.json as { workspace?: string }).workspace;
  if (paritySession) {
    const genCid = await track('dcsc_export', { kind: 'configId', session: paritySession });
    const configId = (genCid.json as { configId?: string }).configId;
    check('dcsc_export configId generates 10-char ID', !genCid.isError && typeof configId === 'string' && configId.length === 10, JSON.stringify(genCid.json).slice(0, 160));

    if (configId) {
      const impCid = await track('dcsc_import', { configId });
      check('dcsc_import configId imports online configuration', !impCid.isError, JSON.stringify(impCid.json).slice(0, 160));
      const impWs = (impCid.json as { session?: string }).session;
      if (impWs) await track('dcsc_session_close', { session: impWs });
    }

    const qSids = await track('dcsc_search', { search: { kind: 'sids', categoryId: 'STG@Servers@Rack Server', offset: 0, limit: 5 } });
    check('dcsc_search sids queries category SIDs', !qSids.isError, JSON.stringify(qSids.json).slice(0, 160));

    const autoFix = await track('dcsc_auto_fix', { session: paritySession });
    check('dcsc_auto_fix applies candidate derivations', !autoFix.isError, JSON.stringify(autoFix.json).slice(0, 160));

    const specCat = await track('dcsc_search', { search: { kind: 'specialty', catalog: 'lvr', limit: 2 } });
    check('dcsc_search specialty browses specialty inventory', !specCat.isError, JSON.stringify(specCat.json).slice(0, 160));

    const featDetails = await track('dcsc_configuration_get', { session: paritySession, view: 'features', codes: ['CA0Z'], upstream: true });
    check('dcsc_configuration_get features fetches rich specs', !featDetails.isError, JSON.stringify(featDetails.json).slice(0, 160));

    const subtabRec = await track('dcsc_configuration_get', { session: paritySession, view: 'recommendations', recommendation: 'subtab' });
    check('dcsc_configuration_get recommendations returns context recommendations', !subtabRec.isError, JSON.stringify(subtabRec.json).slice(0, 160));

    const smartRec = await track('dcsc_configuration_get', { session: paritySession, view: 'recommendations', recommendation: 'summary' });
    check('dcsc_configuration_get recommendations returns smart recommendations', !smartRec.isError, JSON.stringify(smartRec.json).slice(0, 160));

    const vlhW = await track('dcsc_vlh_get', { section: 'topologies' });
    check('dcsc_vlh_get returns wizard data', !vlhW.isError, JSON.stringify(vlhW.json).slice(0, 160));

    const vlhA = await track('dcsc_vlh_get', { code: '7D73CTO1WW' });
    check('dcsc_vlh_get returns physical specifications', !vlhA.isError, JSON.stringify(vlhA.json).slice(0, 160));

    if (parityWs) {
      const vcProd = await track('dcsc_virtual_container_get', { session: parityWs, check: 'compatibleProducts' });
      check('dcsc_virtual_container_get discovers products', !vcProd.isError, JSON.stringify(vcProd.json).slice(0, 160));

      const vcRules = await track('dcsc_virtual_container_get', { session: parityWs, check: 'rules' });
      check('dcsc_virtual_container_get checks update rules', !vcRules.isError, JSON.stringify(vcRules.json).slice(0, 160));
    }

    const catDetail = await track('dcsc_category', { category: { kind: 'detail', categoryId: 'STG@Servers@Rack Server', limit: 2 } });
    check('dcsc_category detail discovers sub-category detail', !catDetail.isError, JSON.stringify(catDetail.json).slice(0, 160));

    const ctoLfoCodes = await track('dcsc_search', { search: { kind: 'preconfigured', limit: 5 } });
    check('dcsc_search preconfigured lists filtered product codes', !ctoLfoCodes.isError, JSON.stringify(ctoLfoCodes.json).slice(0, 160));

    const rackRule = await track('dcsc_rack_position_rule', {
      rack: {
        code: '7D6DCTO1WW',
        size: 42,
        machineType: '7D6D',
        sliceCtoCode: '7D6DCTO1WW',
        rackItem: {
          code: '7D73CTO1WW',
          type: 'server',
          machineType: '7D73',
          sliceCtoCode: '7D73CTO1WW',
          asVLH: false,
        },
      },
      configurations: [],
    });
    check('dcsc_rack_position_rule validates U-position bounds', !rackRule.isError, JSON.stringify(rackRule.json).slice(0, 160));

    const mandSw = await track('dcsc_validate', { session: paritySession, includeMandatorySoftware: true });
    check('dcsc_validate inspects mandatory software tabs', !mandSw.isError &&
      (mandSw.json as { mandatorySoftware?: unknown }).mandatorySoftware !== undefined, JSON.stringify(mandSw.json).slice(0, 160));

    const insSave = await track('dcsc_compare', { analysis: { kind: 'insights', session: paritySession, insight: 'serviceSaving' } });
    check('dcsc_compare insights extracts service pricing savings', !insSave.isError, JSON.stringify(insSave.json).slice(0, 160));

    const treeExp = await track('dcsc_export', {
      kind: 'configurationTree',
      name: 'SR630V3_Tree',
      dataList: [{ typeName: 'Processors', contents: ['Intel Xeon Gold 6430'] }],
    });
    check('dcsc_export configurationTree writes a spreadsheet artifact', !treeExp.isError, JSON.stringify(treeExp.json).slice(0, 160));

    await track('dcsc_session_close', { session: paritySession });
  }

  // --- coverage ------------------------------------------------------------
  const invoked = registered.filter((tool) => (coverage.get(tool)?.calls ?? 0) > 0);
  const missed = registered.filter((tool) => !coverage.has(tool));
  const withoutHappyPath = registered.filter((tool) => (coverage.get(tool)?.successes ?? 0) === 0);
  const unknownCalls = [...coverage.keys()].filter((tool) => !registered.includes(tool));
  check(
    `every registered tool invoked (${invoked.length}/${registered.length})`,
    missed.length === 0,
    `never called: ${missed.join(', ')}`,
  );
  check(
    `every registered tool has a successful call (${registered.length - withoutHappyPath.length}/${registered.length})`,
    withoutHappyPath.length === 0,
    `no happy path: ${withoutHappyPath.join(', ')}`,
  );
  check(
    'conformance only calls registered tools',
    unknownCalls.length === 0,
    `unknown calls: ${unknownCalls.join(', ')}`,
  );
  console.log('\nTOOL COVERAGE:');
  for (const tool of registered) {
    const item = coverage.get(tool) ?? { calls: 0, successes: 0, errors: 0, maxBytes: 0 };
    console.log(
      `  ${tool}: ${item.successes}/${item.calls} successful, ${item.errors} errors, max ${item.maxBytes}B`,
    );
  }

  await client.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('\nFAILURES:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch(async (err: unknown) => {
  console.error('CONFORMANCE ERROR');
  console.error(err);
  process.exitCode = 1;
  // A rejected/timed-out request must not leave the stdio server keeping this
  // failed test process alive indefinitely.
  await client?.close().catch(closeError => console.error('MCP cleanup failed', closeError));
});
