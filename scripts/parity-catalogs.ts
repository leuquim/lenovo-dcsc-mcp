/** Real-transport catalog continuation and identifier usability gate. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { isolatedChildEnv } from './lib/isolated-runtime.js';

type Json = Record<string, unknown>;
type Continuation = { tool: string; arguments: Json };
type Call = { tool: string; bytes: number; isError: boolean };

const MAX_BYTES = 8_000;

function object(value: unknown): Json {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Json;
}

function array(value: unknown): unknown[] {
  assert(Array.isArray(value));
  return value;
}

function parseArgs(argv = process.argv.slice(2)): { outDir: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const result = { outDir: path.resolve(`artifacts/parity-catalogs/${stamp}`) };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]; const value = argv[index + 1];
    if (key !== '--out' || !value) throw new Error(`Invalid argument ${key ?? ''}.`);
    result.outDir = path.resolve(value); index += 1;
  }
  return result;
}

function next(value: unknown): Continuation | undefined {
  if (value === undefined) return undefined;
  const link = object(value);
  assert.equal(typeof link['tool'], 'string');
  return { tool: String(link['tool']), arguments: object(link['arguments']) };
}

async function main(): Promise<void> {
  const options = parseArgs();
  await mkdir(options.outDir, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp/server.ts'],
    cwd: process.cwd(),
    stderr: 'pipe',
    maxBufferSize: 12 * 1024 * 1024,
    env: isolatedChildEnv({ DCSC_LOG_LEVEL: 'error' }),
  });
  const client = new Client({ name: 'parity-catalogs', version: '1.0.0' });
  const calls: Call[] = [];
  const call = async (tool: string, args: Json): Promise<Json> => {
    const response = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 300_000 });
    const content = (response as { content?: Array<{ type?: string; text?: string }>; isError?: boolean }).content ?? [];
    const text = content.find(item => item.type === 'text')?.text ?? '';
    const bytes = Buffer.byteLength(text);
    calls.push({ tool, bytes, isError: response.isError === true });
    assert(bytes < MAX_BYTES, `${tool} returned ${bytes} bytes.`);
    assert.notEqual(response.isError, true, `${tool} failed: ${text.slice(0, 500)}`);
    return object(JSON.parse(text) as unknown);
  };
  const detailField = async (link: Continuation, key: string): Promise<unknown> => {
    const page = await call(link.tool, link.arguments);
    const field = array(page['items']).map(object).find(item => item['key'] === key);
    assert(field, `${link.tool} detail omitted ${key}.`);
    return field['value'];
  };
  const enumerate = async (tool: string, args: Json, collection: string, idKey: string) => {
    const ids: string[] = [];
    let link: Continuation | undefined = { tool, arguments: args };
    let pages = 0;
    let fingerprint: string | undefined;
    while (link) {
      const page = await call(link.tool, link.arguments);
      pages += 1;
      fingerprint ??= typeof page['catalogFingerprint'] === 'string' ? page['catalogFingerprint'] : undefined;
      for (const raw of array(page[collection])) {
        const item = object(raw);
        let id = item[idKey];
        if (typeof id !== 'string') {
          const detail = next(object(item['detail']));
          assert(detail, `${tool} compact row omitted a detail continuation.`);
          id = await detailField(detail, idKey);
        }
        assert.equal(typeof id, 'string', `${tool} returned no ${idKey}.`);
        ids.push(String(id));
      }
      link = next(page['next']);
    }
    assert(ids.length > 0, `${tool} returned no ${collection}.`);
    assert.equal(new Set(ids).size, ids.length, `${tool} returned duplicate ${idKey} values.`);
    assert(fingerprint, `${tool} omitted catalogFingerprint.`);
    return { ids, pages, fingerprint };
  };
  const browseLevel = async (breadcrumb: string[]) => {
    const categories: Json[] = [];
    const productCodes: string[] = [];
    let link: Continuation | undefined = { tool: 'dcsc_search', arguments: { search: {
      kind: 'tree', categoryPath: breadcrumb, categoryOffset: 0, offset: 0, limit: 50,
      includeWithdrawn: false, solutionMode: 'General Purpose',
    } } };
    let pages = 0;
    let categoryTotal: number | undefined;
    let productTotal: number | undefined;
    let fingerprint: string | undefined;
    let resolvedPath: string[] = [];
    while (link) {
      const page = await call(link.tool, link.arguments);
      pages += 1;
      resolvedPath = array(page['path']).map(String);
      fingerprint ??= typeof page['catalogFingerprint'] === 'string' ? page['catalogFingerprint'] : undefined;
      categoryTotal ??= Number(object(page['categoryPage'])['total']);
      productTotal ??= Number(object(page['page'])['total']);
      for (const raw of array(page['categories'])) {
        const item = object(raw);
        if (item['compacted'] === true) {
          const detail = next(object(item['detail']));
          assert(detail);
          const detailPage = await call(detail.tool, detail.arguments);
          for (const field of array(detailPage['items']).map(object)) {
            if (field['value'] !== undefined) item[String(field['key'])] = field['value'];
          }
        }
        assert.equal(typeof item['id'], 'string', 'dcsc_search tree category omitted id.');
        assert.equal(typeof item['name'], 'string', 'dcsc_search tree category omitted name.');
        categories.push(item);
      }
      for (const raw of array(page['products'])) {
        const item = object(raw);
        let code = item['code'];
        if (typeof code !== 'string') {
          const detail = next(object(item['detail']));
          assert(detail);
          code = await detailField(detail, 'code');
        }
        assert.equal(typeof code, 'string', 'dcsc_search tree product omitted code.');
        productCodes.push(String(code));
      }
      link = next(page['next']);
    }
    assert.equal(categories.length, categoryTotal);
    assert.equal(productCodes.length, productTotal);
    assert.equal(new Set(categories.map(item => item['id'])).size, categories.length);
    assert.equal(new Set(productCodes).size, productCodes.length);
    assert(fingerprint);
    return { path: resolvedPath, categories, productCodes, pages, fingerprint };
  };

  const startedAt = new Date().toISOString();
  let report: Json;
  try {
    await client.connect(transport);
    const browseRoot = await browseLevel([]);
    assert(browseRoot.categories.length > 0, 'Catalog root returned no categories.');
    const rootChoice = browseRoot.categories.find(category => category['name'] === 'Servers')
      ?? browseRoot.categories.find(category => Number(category['childCount'] ?? 0) > 0 || Number(category['productCount'] ?? 0) > 0);
    assert(rootChoice, 'Catalog root exposed no traversable category.');
    const nestedPath = [String(rootChoice['name'])];
    const browseNested = await browseLevel(nestedPath);
    assert.deepEqual(browseNested.path, nestedPath);
    const nestedChoice = browseNested.categories.find(category => Number(category['productCount'] ?? 0) > 0)
      ?? browseNested.categories.find(category => Number(category['childCount'] ?? 0) > 0);
    assert(nestedChoice, `${nestedPath.join(' > ')} exposed no leaf category.`);
    const leafPath = [...nestedPath, String(nestedChoice['name'])];
    let browseLeaf = await browseLevel(leafPath);
    for (let depth = 0; browseLeaf.productCodes.length === 0 && depth < 6; depth += 1) {
      const child = browseLeaf.categories.find(category => Number(category['productCount'] ?? 0) > 0)
        ?? browseLeaf.categories.find(category => Number(category['childCount'] ?? 0) > 0);
      assert(child, `${browseLeaf.path.join(' > ')} exposed neither products nor a traversable child.`);
      leafPath.push(String(child['name']));
      browseLeaf = await browseLevel(leafPath);
    }
    assert(browseLeaf.productCodes.length > 0, `Catalog path ${leafPath.join(' > ')} returned no products.`);

    const products = await enumerate('dcsc_search', { search: {
      kind: 'products', query: 'ThinkSystem', type: 'CTO', includeWithdrawn: false,
      solutionMode: 'General Purpose', offset: 0, limit: 50,
    } }, 'products', 'code');
    const exactProduct = await call('dcsc_search', { search: {
      kind: 'products', query: products.ids[0], type: 'CTO', includeWithdrawn: false,
      solutionMode: 'General Purpose', offset: 0, limit: 10,
    } });
    assert(array(exactProduct['products']).map(object).some(item => item['code'] === products.ids[0]));

    // /findpart has no upstream cursor or total. Exercise a deliberately broad
    // service query to prove its large single response is projected safely and
    // that the returned continuation remains local to that response snapshot.
    const partsFirst = await call('dcsc_search', { search: {
      kind: 'parts', query: 'Premier', types: ['SERVICE'], mode: 'CTO',
      solutionMode: 'General Purpose', offset: 0, limit: 50,
    } });
    const partsPage = object(partsFirst['page']);
    assert.equal(partsPage['source'], 'GET /api/findpart');
    assert.equal(partsPage['upstreamCompleteness'], 'unknown');
    assert.equal(partsPage['upstreamContract'], 'single-response-array');
    assert.equal(partsPage['upstreamPagination'], 'none-reported');
    assert.equal(partsPage['continuationScope'], 'local-snapshot');
    assert(Number(partsPage['itemsInFetchedResponse']) > 1_000,
      'Broad service lookup did not exercise a large upstream response.');
    assert(!Object.hasOwn(partsFirst, 'total'), 'Part lookup must not invent an upstream total.');
    const partsNext = next(partsFirst['next']);
    assert(partsNext, 'Broad service lookup omitted its local continuation.');
    const partsSecond = await call(partsNext.tool, partsNext.arguments);
    const firstPartCodes = array(partsFirst['parts']).map(item => String(object(item)['code']));
    const secondPartCodes = array(partsSecond['parts']).map(item => String(object(item)['code']));
    assert.equal(new Set([...firstPartCodes, ...secondPartCodes]).size,
      firstPartCodes.length + secondPartCodes.length,
      'Adjacent local part pages overlap.');

    const racks = await enumerate('dcsc_rack_get', {
      solutionMode: 'General Purpose', offset: 0, limit: 50,
    }, 'racks', 'code');
    const compatibleRacks = await call('dcsc_rack_get', {
      solutionMode: 'General Purpose', productCode: products.ids[0], offset: 0, limit: 20,
    });
    assert.equal(compatibleRacks['compatibleWith'], products.ids[0]);

    const fabricCollections = [
      'topologies', 'networkDevices', 'networkTypes', 'cables', 'selectedServices',
      'nodeRoles', 'storageSwitches', 'storageControllers',
    ];
    const fabric: Record<string, unknown> = {};
    for (const collection of fabricCollections) {
      const first = await call('dcsc_network_get', {
        solutionMode: 'General Purpose', collection, offset: 0, limit: 50,
      });
      if (Number(first['total'] ?? 0) === 0) {
        fabric[collection] = { count: 0, pages: 1, fingerprint: first['catalogFingerprint'] };
        continue;
      }
      const enumerated = await enumerate('dcsc_network_get', {
        solutionMode: 'General Purpose', collection, offset: 0, limit: 50,
      }, 'items', 'id');
      const byId = await call('dcsc_network_get', {
        solutionMode: 'General Purpose', collection, optionId: enumerated.ids[0], offset: 0, limit: 20,
      });
      const item = object(array(byId['items'])[0]);
      const returnedId = typeof item['id'] === 'string'
        ? item['id']
        : await detailField(next(object(item['detail']))!, 'id');
      assert.equal(returnedId, enumerated.ids[0], `${collection} optionId was not executable.`);
      fabric[collection] = { count: enumerated.ids.length, pages: enumerated.pages,
        fingerprint: enumerated.fingerprint, firstId: enumerated.ids[0] };
    }

    const launched = await call('dcsc_launch', { mode: 'software', replace: false, refresh: false });
    const workspace = String(launched['session']);
    const software = await enumerate('dcsc_basket_browse', {
      basket: 'software', session: workspace, offset: 0, limit: 50,
    }, 'software', 'code');
    const selected = await call('dcsc_basket_set', {
      basket: 'software', action: 'select', session: workspace, code: software.ids[0], quantity: 1,
    });
    assert(array(selected['selections']).map(object).some(item => item['code'] === software.ids[0]));
    const removed = await call('dcsc_basket_set', { basket: 'software', action: 'remove', session: workspace, code: software.ids[0] });
    assert(!array(removed['selections']).map(object).some(item => item['code'] === software.ids[0]));
    await call('dcsc_session_close', { session: workspace });

    const callsByTool = Object.fromEntries([...new Set(calls.map(entry => entry.tool))].map(tool => {
      const matching = calls.filter(entry => entry.tool === tool);
      return [tool, { calls: matching.length, maxBytes: Math.max(...matching.map(entry => entry.bytes)) }];
    }));
    report = {
      status: 'passed', startedAt, finishedAt: new Date().toISOString(),
      maxResponseBytes: Math.max(...calls.map(entry => entry.bytes)), calls: calls.length,
      products: { count: products.ids.length, pages: products.pages, firstCode: products.ids[0], exactLookup: true },
      browseCatalog: {
        root: { path: browseRoot.path, categories: browseRoot.categories.length,
          products: browseRoot.productCodes.length, pages: browseRoot.pages },
        nested: { path: browseNested.path, categories: browseNested.categories.length,
          products: browseNested.productCodes.length, pages: browseNested.pages },
        leaf: { path: browseLeaf.path, categories: browseLeaf.categories.length,
          products: browseLeaf.productCodes.length, pages: browseLeaf.pages,
          firstCode: browseLeaf.productCodes[0] },
      },
      racks: { count: racks.ids.length, pages: racks.pages, firstCode: racks.ids[0], compatibleLookup: true },
      fabric,
      software: { count: software.ids.length, pages: software.pages, firstCode: software.ids[0], selectRemove: true },
      parts: {
        query: 'Premier', type: 'SERVICE',
        itemsInFetchedResponse: Number(partsPage['itemsInFetchedResponse']),
        pagesChecked: 2, singleResponseContract: true, localSnapshotContinuation: true,
      },
      assertions: { byteBudget: true, continuationsExhaustive: true, noDuplicateIdentifiers: true,
        fingerprintsPresent: true, identifiersExecutable: true },
      callsByTool,
    };
    await writeFile(path.join(options.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    report = { status: 'failed', startedAt, finishedAt: new Date().toISOString(), calls,
      error: error instanceof Error ? error.stack ?? error.message : String(error) };
    await writeFile(path.join(options.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

await main();
