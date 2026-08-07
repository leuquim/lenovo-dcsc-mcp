/**
 * Phase 0.1 — offline bundle mining.
 *
 * Fetches the DCSC SPA shell, resolves the date-stamped application bundle,
 * and extracts every API path literal plus the export form definition into
 * fixtures/endpoints.json.
 *
 * This is the highest-leverage drift detector in the project and it costs
 * ZERO API requests: the bundle filename changes on every DCSC release, so
 * diffing the extracted endpoint set tells us what Lenovo added, removed or
 * renamed *before* we ever call one of those endpoints.
 *
 * Run with: npm run mine
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { USER_AGENT } from '../src/config/constants.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = join(ROOT, 'fixtures', 'endpoints.json');
const HOST = process.env.DCSC_HOST ?? 'dcsc.lenovo.com';

interface Fixture {
  minedAt: string;
  host: string;
  bundle: string;
  bundleSha256: string;
  formFields: string[];
  exportOptionValues: string[];
  apiPaths: string[];
  aiPaths: string[];
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: '*/*' },
  });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

/** Extracts the hidden export form's field names straight from the page HTML. */
function extractFormFields(html: string): string[] {
  const form = /<form id="hidden-form"[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
  const names = [...form.matchAll(/name="([^"]+)"/g)].map((m) => m[1] as string);
  return [...new Set(names)].sort();
}

/**
 * Pulls API path literals out of the minified bundle.
 *
 * Deliberately conservative: only slash-prefixed literals that look like
 * routes, filtered against asset extensions and obvious false positives.
 */
function extractApiPaths(bundle: string): { api: string[]; ai: string[] } {
  const literals = new Set<string>();
  for (const m of bundle.matchAll(/"(\/[A-Za-z0-9_\-/.{}:]{2,80})"/g)) {
    literals.add(m[1] as string);
  }

  const api: string[] = [];
  const ai: string[] = [];
  const assetExt = /\.(png|jpe?g|svg|css|js|gif|woff2?|ico|map|html)$/i;

  for (const path of literals) {
    if (assetExt.test(path)) continue;
    if (path.startsWith('/nightingale-configurator/')) {
      ai.push(path);
      continue;
    }
    // Route-shaped: at least one alphanumeric segment, no spaces, not a
    // bare separator or a version-looking string.
    if (!/^\/[a-zA-Z][A-Za-z0-9_\-/.{}:]*$/.test(path)) continue;
    if (path.length < 4) continue;
    api.push(path);
  }

  return { api: api.sort(), ai: ai.sort() };
}

/** Export format flags (XML, VLH, QUOTE_CSV, ...) used by the export ZIP. */
function extractExportOptions(bundle: string): string[] {
  const values = new Set<string>();
  for (const m of bundle.matchAll(/value:\s*"([A-Z][A-Z0-9_]{2,40})"/g)) {
    values.add(m[1] as string);
  }
  return [...values].sort();
}

function diff(previous: string[], next: string[]): { added: string[]; removed: string[] } {
  const prev = new Set(previous);
  const now = new Set(next);
  return {
    added: next.filter((p) => !prev.has(p)),
    removed: previous.filter((p) => !now.has(p)),
  };
}

async function main(): Promise<void> {
  console.log(`Fetching https://${HOST}/ …`);
  const html = await fetchText(`https://${HOST}/`);

  const bundleName = /src="(app-\d{4}-\d{2}-\d{2}-[0-9a-f]+\.js)"/.exec(html)?.[1];
  if (!bundleName) throw new Error('Could not locate the app bundle in the page HTML.');
  console.log(`Bundle: ${bundleName}`);

  const bundle = await fetchText(`https://${HOST}/${bundleName}`);
  console.log(`Bundle size: ${(bundle.length / 1e6).toFixed(2)} MB`);

  const { api, ai } = extractApiPaths(bundle);
  const fixture: Fixture = {
    minedAt: new Date().toISOString(),
    host: HOST,
    bundle: bundleName,
    bundleSha256: createHash('sha256').update(bundle).digest('hex'),
    formFields: extractFormFields(html),
    exportOptionValues: extractExportOptions(bundle),
    apiPaths: api,
    aiPaths: ai,
  };

  let previous: Fixture | undefined;
  if (existsSync(FIXTURE_PATH)) {
    previous = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
  }

  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);

  console.log(`\nExtracted:`);
  console.log(`  ${fixture.apiPaths.length} API path literals`);
  console.log(`  ${fixture.aiPaths.length} AI configurator paths`);
  console.log(`  ${fixture.formFields.length} export form fields: ${fixture.formFields.join(', ')}`);
  console.log(`  ${fixture.exportOptionValues.length} export option flags`);

  if (previous) {
    if (previous.bundle === fixture.bundle) {
      console.log(`\nNo release change since last mine (${previous.bundle}).`);
    } else {
      console.log(`\nRELEASE CHANGED: ${previous.bundle} -> ${fixture.bundle}`);
      const d = diff(previous.apiPaths, fixture.apiPaths);
      if (d.added.length) console.log(`  ADDED (${d.added.length}):\n    ${d.added.join('\n    ')}`);
      if (d.removed.length)
        console.log(`  REMOVED (${d.removed.length}):\n    ${d.removed.join('\n    ')}`);
      if (!d.added.length && !d.removed.length) console.log('  No endpoint changes.');
    }
  } else {
    console.log('\nBaseline written. Re-run after a DCSC release to see the diff.');
  }

  console.log(`\nWrote ${FIXTURE_PATH}`);
}

main().catch((err: unknown) => {
  console.error('Bundle mining failed:', err);
  process.exitCode = 1;
});
