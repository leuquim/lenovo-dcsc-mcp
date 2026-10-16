/**
 * Diagnostic only: replays a website-captured /auto_connect request with one
 * named mutation, to isolate which input controls storage-row generation.
 * A populated result here is a hypothesis, not a native design.
 *
 * npx tsx scripts/recon/replay-storage-auto-connect.ts <request.json> <outDir> <variant...>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/load.js';
import { fetchSolutionModes, toSolutionContext } from '../../src/domain/context.js';
import { DcscHttpClient, RequestBudget } from '../../src/http/request.js';
import { configureLogger, newCorrId } from '../../src/http/trace.js';

type Json = Record<string, any>;

function rackItems(req: Json): Json[] {
  const out: Json[] = [];
  const walk = (items: Json[] = []) => {
    for (const item of items) {
      out.push(item);
      walk(item.rackItems);
      walk(item.nodes);
      walk(item.children);
    }
  };
  walk(req.rackArea);
  walk(req.nonRackArea);
  return out;
}

function aliasPairs(req: Json): Array<{ root: string; alias: string }> {
  const configIds = new Set((req.configurations as Json[]).map((c) => c.id));
  const placed = new Set(rackItems(req).map((i) => i.id));
  const pairs: Array<{ root: string; alias: string }> = [];
  for (const [root, members] of Object.entries(req.cloneDependency as Record<string, string[]>)) {
    for (const alias of members) {
      if (alias !== root && configIds.has(root) && !configIds.has(alias) && placed.has(alias)) {
        pairs.push({ root, alias });
      }
    }
  }
  return pairs;
}

const VARIANTS: Record<string, (req: Json) => void> = {
  control: () => {},
  // H1: backend resolves rack-item connectors by exact configuration ID.
  'alias-config': (req) => {
    for (const { root, alias } of aliasPairs(req)) {
      const source = req.configurations.find((c: Json) => c.id === root);
      req.configurations.push({ ...structuredClone(source), id: alias });
    }
  },
  // H2: backend looks up the definition controller by the placed ID.
  'scn-alias': (req) => {
    const pairs = aliasPairs(req);
    for (const network of req.storageConnectionNetworks as Json[]) {
      const pair = pairs.find((p) => p.root === network.controller?.id);
      if (pair) network.controller.id = pair.alias;
    }
  },
  // H3: P2P alone is insufficient; storage cabling rides on switch provisioning.
  'auto-switch': (req) => {
    req.autoConnectSettings = { ...req.autoConnectSettings, autoAddSwitch: true };
  },
  // H4: controller assignment must also be stamped on the storage configuration.
  'controller-assigned': (req) => {
    for (const network of req.storageConnectionNetworks as Json[]) {
      const cfg = req.configurations.find((c: Json) => c.id === network.controller?.id);
      if (cfg) cfg.selectedStorageNetwork = network.name;
    }
  },
  'layout-minimal': (req) => {
    for (const network of req.storageConnectionNetworks as Json[]) network.layout = 'Minimal Cabling';
  },
  'san-empty-strings': (req) => {
    for (const network of req.storageConnectionNetworks as Json[]) {
      network.mainSwitch = { hardwareType: 'switch', option: '', featureCode: '' };
    }
  },
  'expansion-schema': (req) => {
    for (const network of req.storageConnectionNetworks as Json[]) network.expansion = { hardwareType: 'storage' };
  },
  'type-bw': (req) => {
    for (const network of req.storageConnectionNetworks as Json[]) network.type = 'Balance Warehouse';
  },
  // Reachability probe: can a managed storage alias receive any row, on a network that already works?
  'storage-mgmt': (req) => {
    const server = (req.configurations as Json[]).find((c) => c.selectedTopologies?.Management);
    for (const network of req.storageConnectionNetworks as Json[]) {
      const cfg = req.configurations.find((c: Json) => c.id === network.controller?.id);
      const mgmt = (cfg?.connectors ?? []).filter((k: Json) => (k.topologies ?? []).includes('Management_Ethernet'));
      if (cfg && server && mgmt.length > 0) {
        cfg.selectedTopologies = { Management: { ...server.selectedTopologies.Management, connectors: 1, selectedConnectors: [mgmt[0]] } };
      }
    }
  },
  // Same probe on the managed SAN switch, whose mgmt port shares the network's 1GbE_Copper topology.
  'san-switch-mgmt': (req) => {
    const server = (req.configurations as Json[]).find((c) => c.selectedTopologies?.Management);
    for (const network of req.storageConnectionNetworks as Json[]) {
      const cfg = req.configurations.find((c: Json) => c.id === network.mainSwitch?.id);
      const mgmt = (cfg?.connectors ?? []).filter((k: Json) =>
        (k.topologies ?? []).includes('Management_Ethernet') && (k.topologies ?? []).includes('1GbE_Copper'));
      if (cfg && server && mgmt.length > 0) {
        cfg.selectedTopologies = { Management: { ...server.selectedTopologies.Management, connectors: 1, selectedConnectors: [mgmt[0]] } };
      }
    }
  },
  // Not natively reachable: locates whether the backend filters cabling sources by hardware type.
  'storage-as-server': (req) => {
    for (const item of rackItems(req)) if (item.type === 'storage') { item.type = 'server'; item.hardwareType = 'server'; }
  },
  // Rack item carries the root ID, so the placed controller and its configuration share one identity.
  'rackitem-root': (req) => {
    for (const { root, alias } of aliasPairs(req)) {
      for (const item of rackItems(req)) if (item.id === alias) item.id = root;
      req.cloneDependency[root] = [root];
    }
  },
};

function summarize(res: Json, storageNames: string[]): Json {
  const connections: Json[] = Array.isArray(res?.connections) ? res.connections : [];
  const byNetwork: Record<string, number> = {};
  for (const c of connections) byNetwork[c.network ?? '?'] = (byNetwork[c.network ?? '?'] ?? 0) + 1;
  return {
    connectionCount: connections.length,
    byNetwork,
    storageRows: connections.filter((c) => storageNames.includes(c.network)).map((c) => ({
      network: c.network, topology: c.topology, cablePart: c.cablePart, cableOption: c.cableOption,
      source: `${c.sourcePart} ${c.sourceId} ${c.sourceLocation}`,
      destination: `${c.destinationPart} ${c.destinationId} ${c.destinationLocation}`,
    })),
    errors: res?.errors ?? null,
    topLevelKeys: Object.keys(res ?? {}),
  };
}

async function main(): Promise<void> {
  const [requestPath, outDir, ...variantArgs] = process.argv.slice(2);
  if (!requestPath || !outDir || variantArgs.length === 0) throw new Error('usage: <request.json> <outDir> <variant[+variant]...>');
  const config = loadConfig({ logLevel: process.env.DCSC_LOG_LEVEL ?? 'warn' });
  configureLogger(config.logLevel);
  const http = new DcscHttpClient(config);
  const base = { corrId: newCorrId(), locale: config.locale, budget: new RequestBudget(50) };
  const solution = toSolutionContext(await fetchSolutionModes(http, base), 'HPC and AI - Systems');
  const original = JSON.parse(readFileSync(requestPath, 'utf8')) as Json;
  const storageNames = (original.storageConnectionNetworks as Json[]).map((n) => n.name);
  mkdirSync(outDir, { recursive: true });

  for (const spec of variantArgs) {
    const req = structuredClone(original);
    for (const name of spec.split('+')) {
      const apply = VARIANTS[name];
      if (!apply) throw new Error(`unknown variant ${name}`);
      apply(req);
    }
    const res = await http.send({
      endpoint: 'auto_connect', method: 'POST', path: '/auto_connect',
      query: { sbSlices: '', countryName: 'United States', current_country_or_region: 'US',
        autoArrange: false, autoConnect: true, cogValidation: true },
      body: { kind: 'json', value: req }, responseKind: 'json', timeoutClass: 'interactive',
      ctx: { ...base, solution },
    });
    const summary = { variant: spec, status: res.status, aliasPairs: aliasPairs(original), ...summarize(res.raw as Json, storageNames) };
    writeFileSync(join(outDir, `${spec}-request.json`), JSON.stringify(req));
    writeFileSync(join(outDir, `${spec}-response.json`), JSON.stringify(res.raw));
    writeFileSync(join(outDir, `${spec}-summary.json`), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ variant: spec, status: res.status, connectionCount: summary.connectionCount,
      byNetwork: summary.byNetwork, storageRows: summary.storageRows.length, errors: summary.errors }));
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
