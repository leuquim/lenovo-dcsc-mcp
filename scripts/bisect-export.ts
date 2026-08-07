/**
 * Binary-search which optional `data` field breaks export_zip deserialization.
 *
 * The minimal payload parses; the full one returns 400 "Failed to read
 * request", which is a Jackson failure rather than a missing field — so the
 * error oracle goes quiet and bisection is the cheap way in. ~5 requests.
 */
import { readFileSync } from 'node:fs';

import { reduceConfiguration } from '../src/domain/reduce.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function attempt(data: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const body = new URLSearchParams({
    data: JSON.stringify(data),
    groups: '[]',
    integrationParams: '{}',
    cancelDownload: 'false',
    lfoCode: '',
    user: '',
    uuid: '',
  });
  const res = await fetch(
    'https://dcsc.lenovo.com/api/ctos/export_zip?country_or_region=US&language=en&currency=USD&fileName=bisect&_request=web',
    {
      method: 'POST',
      headers: {
        'user-agent': UA,
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://dcsc.lenovo.com',
        referer: 'https://dcsc.lenovo.com/',
        integrationParams: '{}',
      },
      body,
    },
  );
  if (res.status === 200) {
    const b = await res.arrayBuffer();
    return { status: 200, text: `binary ${b.byteLength}b` };
  }
  return { status: res.status, text: (await res.text()).slice(0, 150).replace(/\s+/g, ' ') };
}

async function main(): Promise<void> {
  const raw = JSON.parse(
    readFileSync(
      '/tmp/claude-1000/-home-miquel-projects-lenovo-dcsc/77c5d462-a1d3-4a65-9b71-41632bf9dd2b/scratchpad/launch.json',
      'utf8',
    ),
  ) as Record<string, unknown>;
  const id = 'US__bisect-0';
  const code = String(raw.sliceCtoCode);
  const reduced = reduceConfiguration(raw, id);

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

  const base: Record<string, unknown> = {
    workspaceInformation: {
      configurations: [reduced],
      rackData: [],
      nonRackData: [placement],
      cloneDependency: { [id]: [id] },
      nonRackVirtualData: [],
      rackVirtualData: [],
    },
    configurations: [reduced],
    exportFileTypes: ['XML', 'QUOTE', 'SUMMARY'],
    cloneDependencyColor: {},
    workspace: { rackArea: [], nonRackArea: [layout], floorItems: [], cloneRackMapping: {} },
  };

  const extras: Array<[string, unknown]> = [
    ['toggle7116On', false],
    ['crnId', ''],
    ['virtualContainerIdMapping', {}],
    ['virtualContainerRule2ConfigMapping', {}],
    ['virtualContainerInvalidRuleIdMapping', {}],
    [
      'statusRelatedResult',
      { overPreSelectResults: [], autoDerivedConfigurationIds: [id], requiredSections: null },
    ],
    ['autoDerivedResults', []],
    ['crossSystemConfigs', []],
    ['standaloneData', []],
    ['ruleConditionIdMapping', '{}'],
    ['instanceIdMapping', '{}'],
    ['controllerExpansionMap', {}],
    ['controllerIndexMap', {}],
    ['autoConnectResults', []],
    ['floorInformation', { floorGridSettings: {}, floorPreference: {}, cloneRackMapping: {} }],
    [
      'networkingInformation',
      { powerSelection: {}, autoConnectResults: [], cables: [], switchMap: {} },
    ],
    [
      'customizingFlags',
      {
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
    ],
    ['operationMode', { type: 'guide', options: { autoFix: false, showErrors: true } }],
    ['messageHistory', { history: [], validationReport: [] }],
    [
      'solutionMode',
      { mode: 'General Purpose', masterSlices: ['GP', 'HPCGPALL', 'HPCGPRYO'], sbSlices: [] },
    ],
    ['configId2RecommendedDatasMap', {}],
    ['lbpExportShowPrice', [1]],
    ['crossVariantDeriveResults', []],
  ];

  const withAll = { ...base, ...Object.fromEntries(extras) };
  const all = await attempt(withAll);
  console.log(`all extras   -> ${all.status} :: ${all.text}`);
  if (all.status !== 400) {
    console.log('\nNo parse failure with the full set — the earlier 400 came from elsewhere.');
    return;
  }

  // Binary search for the first failing field.
  let lo = 0;
  let hi = extras.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const subset = { ...base, ...Object.fromEntries(extras.slice(0, mid + 1)) };
    await new Promise((r) => setTimeout(r, 1500));
    const res = await attempt(subset);
    const name = extras[mid]?.[0];
    console.log(`+${String(name).padEnd(36)} (0..${mid}) -> ${res.status} :: ${res.text.slice(0, 90)}`);
    if (res.status === 400) hi = mid;
    else lo = mid + 1;
  }

  const culprit = extras[lo];
  console.log(`\nFIRST BREAKING FIELD: ${culprit?.[0]} = ${JSON.stringify(culprit?.[1])}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
