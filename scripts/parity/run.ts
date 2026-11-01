import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createHarness, type ParityCase, type Report } from './harness.js';

const BLOCKED_EXIT_CODE = 2;
const casesDir = path.join(import.meta.dirname, 'cases');

async function discoverCases(): Promise<ParityCase[]> {
  const files = (await readdir(casesDir)).filter(file => file.endsWith('.ts')).sort();
  return Promise.all(files.map(async file =>
    (await import(pathToFileURL(path.join(casesDir, file)).href) as { default: ParityCase }).default));
}

const selector = process.argv[2];
if (!selector) {
  console.error('Usage: tsx scripts/parity/run.ts <caseId|tag|all>');
  process.exit(1);
}
const all = await discoverCases();
const selected = selector === 'all' ? all : all.filter(entry => entry.id === selector || entry.tags.includes(selector));
if (selected.length === 0) {
  console.error(`No parity case matches "${selector}". Cases: ${all.map(entry => entry.id).join(', ')}`);
  process.exit(1);
}

const reports: Report[] = [];
for (const entry of selected) {
  const { harness, finish } = await createHarness(entry.id);
  let thrown: unknown;
  try { await entry.run(harness); } catch (error) { thrown = error; }
  const report = await finish(thrown);
  reports.push(report);
  console.log(`${report.status.padEnd(16)} ${report.case}${report.failure ? ` (${report.failure})` : ''}  ${harness.out}`);
}

const failed = reports.some(report => report.status === 'fail');
const blocked = reports.some(report => report.status === 'blocked');
process.exitCode = failed ? 1 : blocked ? BLOCKED_EXIT_CODE : 0;
