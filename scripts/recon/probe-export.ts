/**
 * Iterative contract discovery for /ctos/export_zip.
 *
 * DCSC's 500s name the exact field the deserializer wanted, so the fastest way
 * to a working payload is to start minimal and add one field per response.
 * This walks that loop automatically, with a hard cap on requests.
 *
 * Run with: npx tsx scripts/probe-export.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';

const MAX_PROBES = 25;
const BASE = 'https://dcsc.lenovo.com/api/ctos/export_zip';
const QUERY = 'country_or_region=US&language=en&currency=USD&fileName=probe&_request=web';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Candidate values for fields the server may ask for, keyed by field name. */
function candidates(id: string, code: string): Record<string, unknown> {
  const placement = {
    id,
    code,
    sliceCtoCode: code,
    type: 'server',
    size: 1,
    height: 1,
    quantity: 0,
    position: 1,
    lock: false,
    nodes: [],
    features: [],
    errors: [],
    placementError: [],
    attributes: {},
  };
  // The workspace layout entry must carry the product code: the export path
  // resolves it against the rule engine (getCharacters), and an entry without
  // it produces a 404 on `/cto/characters/` with an empty path segment.
  const layout = {
    id,
    code,
    sliceCtoCode: code,
    quantity: 1,
    size: 1,
    type: 'server',
    originalIds: [id],
    derivedResults: [],
    removedResults: [],
  };
  return {
    // The map's value is an object type, not a colour string or index — a
    // scalar makes Jackson fail the whole body with "Failed to read request".
    // An empty map is accepted.
    cloneDependencyColor: {},
    workspace: {
      rackArea: [],
      nonRackArea: [layout],
      floorItems: [],
      cloneRackMapping: {},
    },
    statusRelatedResult: {
      overPreSelectResults: [],
      autoDerivedConfigurationIds: [id],
      requiredSections: null,
    },
    floorInformation: { floorGridSettings: {}, floorPreference: {}, cloneRackMapping: {} },
    networkingInformation: {
      powerSelection: {},
      autoConnectResults: [],
      cables: [],
      switchMap: {},
    },
    messageHistory: { history: [], validationReport: [] },
    solutionMode: {
      mode: 'General Purpose',
      masterSlices: ['GP', 'HPCGPALL', 'HPCGPRYO'],
      sbSlices: [],
    },
    operationMode: { type: 'guide', options: { autoFix: false, showErrors: true } },
    customizingFlags: {
      componentRestriction: true,
      autoDerive: true,
      ctoRules: true,
      minMax: true,
      placement: true,
      fromMemoryWizard: false,
      autoVariant: true,
      cogValidation: true,
      autoAddPDU: false,
      autoAddSwitch: false,
      p2pCabling: false,
      autoArrange: false,
      autoConnect: false,
    },
    virtualContainerIdMapping: {},
    virtualContainerRule2ConfigMapping: {},
    virtualContainerInvalidRuleIdMapping: {},
    controllerExpansionMap: {},
    controllerIndexMap: {},
    configId2RecommendedDatasMap: {},
    autoDerivedResults: [],
    crossSystemConfigs: [],
    standaloneData: [],
    autoConnectResults: [],
    crossVariantDeriveResults: [],
    lbpExportShowPrice: [1],
    ruleConditionIdMapping: '{}',
    instanceIdMapping: '{}',
    toggle7116On: false,
    crnId: '',
    nonRackData: [placement],
    rackData: [],
  };
}

/** Pulls the offending field name out of a Java NPE or Jackson message. */
function extractField(detail: string): string | undefined {
  const patterns = [
    /because "([A-Za-z0-9_.]+)" is null/,
    /because the return value of "[^"]*\.get([A-Za-z0-9_]+)\(\)" is null/,
    /Required parameter '([^']+)' is not present/,
  ];
  for (const p of patterns) {
    const m = p.exec(detail);
    if (m?.[1]) {
      const raw = m[1];
      const last = raw.includes('.') ? (raw.split('.').pop() as string) : raw;
      return last.charAt(0).toLowerCase() + last.slice(1);
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const rawPath =
    process.argv[2] ??
    '/tmp/claude-1000/-home-miquel-projects-lenovo-dcsc/77c5d462-a1d3-4a65-9b71-41632bf9dd2b/scratchpad/launch.json';
  const raw = JSON.parse(readFileSync(rawPath, 'utf8')) as Record<string, unknown>;
  const id = 'US__probe-0';
  const code = String(raw.sliceCtoCode ?? '7D73CTO1WW');
  const pool = candidates(id, code);

  // `configurations` carries the REDUCED model (sections + results), the same
  // shape autoDerive takes — not the full launch tree.
  const { reduceConfiguration } = await import('../src/domain/reduce.js');
  const reduced = reduceConfiguration(raw, id);

  const data: Record<string, unknown> = {
    workspaceInformation: {
      configurations: [reduced],
      rackData: [],
      nonRackData: [pool.nonRackData ? (pool.nonRackData as unknown[])[0] : {}],
      cloneDependency: { [id]: [id] },
      nonRackVirtualData: [],
      rackVirtualData: [],
    },
    configurations: [reduced],
    exportFileTypes: ['XML', 'QUOTE', 'SUMMARY'],
  };

  const journal: Array<{ probe: number; status: number; detail: string; added?: string }> = [];

  for (let probe = 1; probe <= MAX_PROBES; probe += 1) {
    const body = new URLSearchParams({
      data: JSON.stringify(data),
      groups: '[]',
      integrationParams: '{}',
      cancelDownload: 'false',
      lfoCode: '',
      user: '',
      uuid: '',
      crnId: '',
      userGeneratedConfigId: '',
      multipleProductData: '[]',
      excelData: '',
      image: '',
    });

    const res = await fetch(`${BASE}?${QUERY}`, {
      method: 'POST',
      headers: {
        'user-agent': UA,
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://dcsc.lenovo.com',
        referer: 'https://dcsc.lenovo.com/',
        integrationParams: '{}',
        'X-ENABLE-IAD': 'true',
      },
      body,
    });

    if (res.status === 200) {
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync('artifacts/probe-export.zip', buf);
      console.log(`\nprobe ${probe}: HTTP 200, ${buf.length} bytes`);
      console.log(`Content-Disposition: ${res.headers.get('content-disposition')}`);
      writeFileSync('artifacts/probe-export-data.json', JSON.stringify(data, null, 1));
      console.log('\nWorking `data` keys:', Object.keys(data).join(', '));
      return;
    }

    const detail = await res.text();
    const short = detail.slice(0, 160).replace(/\s+/g, ' ');
    const field = extractField(detail);
    console.log(`probe ${probe}: HTTP ${res.status} :: ${short}`);

    if (!field) {
      console.log('\nOracle exhausted — no field name in the response. Stopping.');
      journal.push({ probe, status: res.status, detail: short });
      break;
    }
    if (!(field in pool)) {
      console.log(`\nField "${field}" has no candidate value. Stopping.`);
      break;
    }
    if (field in data) {
      console.log(`\nField "${field}" already sent — value shape is wrong. Stopping.`);
      break;
    }

    data[field] = pool[field];
    journal.push({ probe, status: res.status, detail: short, added: field });
    console.log(`   -> adding "${field}"`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  writeFileSync('artifacts/probe-journal.json', JSON.stringify(journal, null, 1));
  console.log('\nJournal written to artifacts/probe-journal.json');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
