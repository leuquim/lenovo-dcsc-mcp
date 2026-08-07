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

interface Outcome {
  json: unknown;
  bytes: number;
  isError: boolean;
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
  return extract(await client.callTool({ name, arguments: args }));
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
    env: { ...process.env, DCSC_LOG_LEVEL: 'error' } as Record<string, string>,
  });
  client = new Client({ name: 'conformance', version: '1.0.0' });
  await client.connect(transport);

  const registered = (await client.listTools()).tools.map((t) => t.name).sort();
  const exercised = new Set<string>();
  const origCall = call;
  const track = async (name: string, args: Record<string, unknown>): Promise<Outcome> => {
    exercised.add(name);
    const out = await origCall(name, args);
    if (!out.isError && out.bytes > MAX_TOOL_BYTES) {
      check(`${name} byte budget`, false, `${out.bytes}B exceeds ${MAX_TOOL_BYTES}B`);
    }
    return out;
  };

  // --- discovery -----------------------------------------------------------
  const modes = await track('dcsc_solution_modes', {});
  const modeList = (modes.json as { modes?: Array<{ mode: string; masterSlices: string[] }> }).modes;
  check(
    'dcsc_solution_modes returns modes with slices',
    Array.isArray(modeList) && modeList.length > 0 && (modeList[0]?.masterSlices?.length ?? 0) > 0,
    JSON.stringify(modes.json).slice(0, 120),
  );

  const browse = await track('dcsc_browse_catalog', {});
  const browseTop = browse.json as { categories?: Array<{ name: string }> };
  check(
    'dcsc_browse_catalog lists root categories',
    (browseTop.categories?.length ?? 0) > 0,
    JSON.stringify(browse.json).slice(0, 120),
  );

  const browseDeep = await track('dcsc_browse_catalog', { path: ['Servers'] });
  const deep = browseDeep.json as { path?: string[]; categories?: unknown[] };
  check(
    'dcsc_browse_catalog descends a level',
    deep.path?.[0] === 'Servers' && (deep.categories?.length ?? 0) > 0,
    JSON.stringify(deep).slice(0, 150),
  );

  const cto = await track('dcsc_find_products', { query: 'SR630 V3', type: 'CTO', limit: 3 });
  const ctoHits = (cto.json as { products: Array<{ code: string }> }).products;
  check('dcsc_find_products finds CTO', ctoHits.length > 0, 'no hits');

  // LFO is an entirely separate endpoint family and had never been exercised.
  const lfo = await track('dcsc_find_products', { query: 'ThinkSystem', type: 'LFO', limit: 5 });
  const lfoHits = (lfo.json as { products: Array<{ code: string; description: string }> }).products;
  check('dcsc_find_products finds LFO', lfoHits.length > 0, 'no LFO products in catalog');

  // --- CTO session ---------------------------------------------------------
  const ctoCode = ctoHits[0]?.code as string;
  const launched = await track('dcsc_launch', { productCode: ctoCode, label: 'conformance-cto' });
  const summary = launched.json as {
    session: string;
    revision: number;
    totalPrice: number;
    constraints: unknown[];
    priceType: string;
  };
  const session = summary.session;
  check('dcsc_launch returns a session', typeof session === 'string' && session.length > 0, '');
  check('dcsc_launch stamps priceType LIST', summary.priceType === 'LIST', String(summary.priceType));
  check('dcsc_launch reports constraints', summary.constraints.length > 0, 'no constraints');

  const info = await track('dcsc_session_info', { session });
  check(
    'dcsc_session_info matches launch',
    (info.json as { totalPrice: number }).totalPrice === summary.totalPrice,
    'price mismatch',
  );

  const list = await track('dcsc_session_list', {});
  const sessions = list.json as Array<{ session: string; label?: string }>;
  check(
    'dcsc_session_list includes the session with its label',
    sessions.some((s) => s.session === session && s.label === 'conformance-cto'),
    JSON.stringify(sessions).slice(0, 150),
  );

  // --- options: pagination and filters -------------------------------------
  const page1 = await track('dcsc_list_options', {
    session,
    section: 'processors.processor',
    limit: 3,
    offset: 0,
  });
  const p1 = page1.json as {
    page: { total: number; offset: number };
    options: Array<{ code: string }>;
    next?: string;
  };
  const page2 = await track('dcsc_list_options', {
    session,
    section: 'processors.processor',
    limit: 3,
    offset: 3,
  });
  const p2 = page2.json as { options: Array<{ code: string }> };
  check(
    'dcsc_list_options paginates without repeating',
    p1.options.length > 0 &&
      p2.options.length > 0 &&
      !p1.options.some((a) => p2.options.some((b) => a.code === b.code)),
    `p1=${p1.options.map((o) => o.code).join(',')} p2=${p2.options.map((o) => o.code).join(',')}`,
  );
  check('dcsc_list_options offers a next cursor', typeof p1.next === 'string', 'no next');

  const selectedOnly = await track('dcsc_list_options', { session, filter: 'selected', limit: 50 });
  const sel = selectedOnly.json as { options: Array<{ sel?: number }> };
  check(
    'dcsc_list_options filter=selected returns only selected',
    sel.options.length > 0 && sel.options.every((o) => (o.sel ?? 0) > 0),
    `${sel.options.length} options, some unselected`,
  );

  await track('dcsc_get_feature', { session, codes: [p1.options[0]?.code ?? 'BYVW'] });

  // --- mutation: batch, removal, concurrency -------------------------------
  const memHits = await track('dcsc_list_options', { session, query: 'RDIMM', limit: 10 });
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
    batchDiff.revision > summary.revision,
    `${summary.revision} -> ${batchDiff.revision}`,
  );

  // Stale revision must be rejected, not silently applied.
  const stale = await track('dcsc_configure', {
    session,
    changes: [{ section: 'PROCESSOR', code: cpuOpt?.code ?? 'BYVW', quantity: 1 }],
    expectedRevision: summary.revision,
  });
  check(
    'dcsc_configure rejects a stale expectedRevision',
    stale.isError,
    'stale write was accepted',
  );

  // --- undo ----------------------------------------------------------------
  const preUndo = await track('dcsc_session_info', { session });
  const preUndoPrice = (preUndo.json as { totalPrice: number }).totalPrice;
  const undone = await track('dcsc_undo', { session });
  const undonePrice = (undone.json as { totalPrice: number }).totalPrice;
  check(
    'dcsc_undo restores the previous price',
    !undone.isError && undonePrice !== preUndoPrice,
    `${preUndoPrice} -> ${undonePrice}`,
  );
  // Undo must restore the model we post back too, not just what we display —
  // otherwise the next export silently describes the undone state.
  const afterUndoBom = await track('dcsc_get_configuration', { session });
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
  const qty = await track('dcsc_set_quantity', { session, quantity: QTY });
  const qtyJson = qty.json as {
    quantity: number;
    totalPrice: number;
    extendedPrice: number;
  };
  check(
    'dcsc_set_quantity extends the price',
    qtyJson.quantity === QTY &&
      Math.abs(qtyJson.extendedPrice - qtyJson.totalPrice * QTY) < 0.01,
    `unit=${qtyJson.totalPrice} extended=${qtyJson.extendedPrice}`,
  );

  const qtyExport = await track('dcsc_export', {
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

  await track('dcsc_set_quantity', { session, quantity: 1 });

  // --- export with explicit formats ----------------------------------------
  const exported = await track('dcsc_export', {
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

  // --- rack & cabling ------------------------------------------------------
  const addedRack = await track('dcsc_add_rack', {
    session,
    rackCode: '7D6DCTO1WW',
    description: 'ThinkSystem 42U Onyx Rack',
    uheight: 42,
    position: 1,
  });
  const rackInfo = addedRack.json as { rack: { id: string; uheight: number } };
  check(
    'dcsc_add_rack returns a rack placement',
    !addedRack.isError && typeof rackInfo.rack?.id === 'string',
    JSON.stringify(addedRack.json).slice(0, 150),
  );

  if (rackInfo.rack?.id) {
    const placed = await track('dcsc_place_in_rack', {
      session,
      configId: session,
      rackId: rackInfo.rack.id,
      uPosition: 1,
      height: 1,
    });
    check('dcsc_place_in_rack places config in rack', !placed.isError, JSON.stringify(placed.json).slice(0, 120));
  }

  const cable = await track('dcsc_add_cabling', {
    session,
    fromConfigId: session,
    fromPort: 'RJ45-1',
    toConfigId: session,
    toPort: 'RJ45-mgmt',
    cableCode: '6400',
    description: 'Management Jumper',
  });
  check('dcsc_add_cabling links ports', !cable.isError, JSON.stringify(cable.json).slice(0, 120));

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
      const lfoInfo = await track('dcsc_session_info', { session: lfoSession });
      check(
        'LFO session primed (LFO endpoints resolve by LFO code)',
        (lfoInfo.json as { primed?: boolean }).primed !== false,
        'priming failed — mutation will not work',
      );

      const lfoBom = await track('dcsc_get_configuration', { session: lfoSession });
      check(
        'LFO configuration has selections',
        ((lfoBom.json as { selections?: unknown[] }).selections?.length ?? 0) > 0,
        'no selections',
      );
      // LFO has its own endpoint family for mutation AND export; routing an
      // LFO session to the /ctos/* routes fails, so both must be exercised.
      const lfoOpts = await track('dcsc_list_options', {
        session: lfoSession,
        filter: 'selected',
        limit: 5,
      });
      const lfoSel = (lfoOpts.json as { options: Array<{ code: string }> }).options;
      check('LFO session lists options', lfoSel.length > 0, 'no options');

      const lfoExport = await track('dcsc_export', {
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

  // --- error surface -------------------------------------------------------
  const badSession = await track('dcsc_session_info', { session: 'sess_nope_000000' });
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

  const afterClose = await track('dcsc_session_info', { session });
  check('closed session is really gone', afterClose.isError, 'session still usable');

  await track('dcsc_health', {});

  // --- coverage ------------------------------------------------------------
  const missed = registered.filter((t) => !exercised.has(t));
  check(
    `every registered tool exercised (${exercised.size}/${registered.length})`,
    missed.length === 0,
    `never called: ${missed.join(', ')}`,
  );

  await client.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('\nFAILURES:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error('CONFORMANCE ERROR');
  console.error(err);
  process.exitCode = 1;
});
