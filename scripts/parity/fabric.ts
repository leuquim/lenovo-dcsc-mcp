/** Shared evidence helpers for the network, storage, cabling and rack-power parity cases. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildExportGroups } from '../../src/domain/exportGroups.js';
import type { RawConfiguration } from '../../src/model/types.js';
import { selectBrowserSolutionMode } from './browser.js';
import type { Harness, Json } from './harness.js';

export type Obj = Json;
export const HPC_MODE = 'HPC and AI - Systems';
export const HPC_MODE_LABEL = 'AI & HPC – ThinkSystem Hardware';
const SUMMARY_ROUTE = /#\/(?:rack-summary|summary)\//;

export const object = (value: unknown): Obj =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
export const rows = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];
export const text = (value: unknown): string => value === undefined || value === null ? '' : String(value);
const byJson = (left: unknown, right: unknown) => JSON.stringify(left).localeCompare(JSON.stringify(right));

/** The workspace the MCP persisted for a handle (first workspace when omitted). */
export function persistedWorkspace(h: Harness, workspace?: string): Obj {
  const found = h.mcp.persistedWorkspaces().find(item => workspace === undefined || item['id'] === workspace);
  assert(found, `Workspace ${workspace ?? ''} was not persisted.`);
  return found;
}
export const persistedGraph = (h: Harness, workspace?: string): Obj[] =>
  rows(object(persistedWorkspace(h, workspace)['serverState'])['connections']);

export function selectedResults(raw: Obj, sectionName: string): Obj[] {
  return rows(raw['tabs']).flatMap(tab => rows(tab['subTabs'])).flatMap(tab => rows(tab['sections']))
    .filter(section => section['name'] === sectionName).flatMap(section => rows(section['results']));
}
export const selectedQuantity = (raw: Obj, sectionName: string, code: string) =>
  selectedResults(raw, sectionName).find(result => result['code'] === code)?.['quantity'];

/** Commercial export rows of the given configuration ids, computed from a persisted workspace. */
export function commercialRows(workspace: Obj, ids: string[], fields = ['id', 'code', 'type', 'quantity', 'price', 'unitPrice']): Obj[] {
  const input = { serverState: object(workspace['serverState']), rackArea: rows(workspace['rackArea']),
    nonRackArea: rows(workspace['nonRackArea']), configurations: new Map(rows(workspace['configurations']).map(item => [String(item['id']), {
      configurationId: String(item['configurationId']), raw: object(item['raw']) as RawConfiguration,
      product: { code: String(object(item['product'])['code']) }, mode: 'cto' as const,
    }])) };
  return (buildExportGroups(input).flatMap(group => group.products) as Obj[])
    .filter(item => ids.includes(String(item['id'])))
    .map(item => Object.fromEntries(fields.map(key => [key, item[key]])));
}

/** Connection graph, switch map and configurations as the website returns them on CFXML import. */
export function importedGraph(payload: Obj): Obj[] {
  const networking = object(payload['networkingInformation']);
  for (const candidate of [payload['connections'], payload['autoConnectResults'], networking['autoConnectResults'],
    networking['connections'], object(payload['workspace'])['connections']]) {
    if (Array.isArray(candidate)) return rows(candidate);
  }
  return [];
}
export function importedSwitchMap(payload: Obj): Obj[] {
  const networking = object(payload['networkingInformation']);
  for (const candidate of [payload['switchMap'], networking['switchMap'], object(payload['workspace'])['switchMap']]) {
    if (Array.isArray(candidate)) return rows(candidate);
  }
  return [];
}
export const importedConfigurations = (payload: Obj): Obj[] =>
  rows(payload['configuration']).length > 0 ? rows(payload['configuration']) : rows(payload['configurations']);

/** Cable graph keyed by device role instead of generated ids, so two independent builds can be compared. */
export function connectionsByRole(connections: Obj[], switches: Obj[]): Obj[] {
  const role = (id: string, location: string) => {
    const mapped = switches.find(entry => text(entry['id']) === id);
    if (mapped) return text(mapped['type']);
    const unit = /\/U(\d+)/.exec(location)?.[1];
    return unit ? `server@U${unit}` : `server:${id}`;
  };
  return connections.map(connection => ({
    sourceRole: role(text(connection['sourceId']), text(connection['sourceLocation'])),
    destinationRole: role(text(connection['destinationId']), text(connection['destinationLocation'])),
    sourcePortNumber: text(connection['sourcePortNumber']),
    destinationPortNumber: text(connection['destinationPortNumber']),
    cablePart: text(connection['cablePart']),
    cableOption: text(connection['cableOption']),
    totalDistance: connection['totalDistance'],
  })).sort((left, right) => text(left['sourceRole']).localeCompare(text(right['sourceRole'])));
}

/** Every item of a paged dcsc_network_get collection. */
export async function enumerateNetwork(h: Harness, args: Obj): Promise<Obj[]> {
  const items: Obj[] = [];
  let next: Obj | undefined = args;
  while (next) {
    const page = await h.mcp.call('dcsc_network_get', next);
    const returned = rows(page['items']);
    assert(returned.length > 0 || Number(page['total']) === 0, `Network continuation for ${text(args['collection'])} made no progress.`);
    items.push(...returned);
    const continuation = object(page['next']);
    next = Object.keys(continuation).length > 0 ? object(continuation['arguments']) : undefined;
  }
  return items;
}

export interface WebsiteImport {
  payload: Obj;
  status: number;
  route: string;
  layouts: Obj[];
  summaryCodes: string[];
}

/** Imports a CFXML file in a fresh headless website session, optionally under a solution mode, and waits for the summary page. */
export async function websiteImport(h: Harness, file: string, label: string,
  options: { mode?: string; collectLayouts?: boolean } = {}): Promise<WebsiteImport> {
  const page = await h.web.newPage();
  try {
    const layouts: Obj[] = [];
    const pending: Promise<void>[] = [];
    if (options.collectLayouts) {
      page.on('response', response => {
        if (response.url().includes('/ctos/racks/customize?')) pending.push(response.json().then(raw => { layouts.push(object(raw)); }));
      });
    }
    await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const cookie = page.locator('.dcsc-cookie-close').first();
    if (await cookie.isVisible({ timeout: 1_500 }).catch(() => false)) await cookie.click();
    if (options.mode) await selectBrowserSolutionMode(page, options.mode, { diagnosticsDir: h.out });
    const input = page.locator('input[type="file"]').first();
    await input.waitFor({ state: 'attached', timeout: 60_000 });
    const response = page.waitForResponse(candidate =>
      candidate.url().includes('/multiple/cfxml_import') && candidate.request().method() === 'POST', { timeout: 180_000 });
    await input.setInputFiles(file);
    const imported = await response;
    const body: unknown = await imported.json();
    await writeFile(path.join(h.out, `${label}-browser-import.json`), JSON.stringify(body, null, 2));
    await page.waitForURL(SUMMARY_ROUTE, { timeout: 120_000 }).catch(() => undefined);
    if (options.collectLayouts) {
      await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
      await page.waitForTimeout(3_000);
      await Promise.all(pending);
    }
    const summaryCodes = (await page.locator('.productCode-col').allTextContents())
      .map(value => value.trim().split(/\s/)[0] ?? '').filter(Boolean);
    return { payload: object(Array.isArray(body) ? body[0] : body), status: imported.status(), route: page.url(), layouts, summaryCodes };
  } finally {
    await page.context().close();
  }
}

const CONNECTION_IDENTITY_FIELDS = ['network', 'topology', 'sourceId', 'sourcePortName', 'sourcePortNumber', 'destinationId',
  'destinationPortName', 'destinationPortNumber', 'cablePart', 'type', 'subType', 'category', 'divider'] as const;
const IDENTITY_ORDER_FIELDS = CONNECTION_IDENTITY_FIELDS.filter(field => field !== 'category' && field !== 'divider');

/** The fields the native graph check retains, ordered by endpoints so a category/divider difference stays on the same row. */
export function connectionIdentity(connections: Obj[]): Obj[] {
  return connections.map(row => Object.fromEntries(CONNECTION_IDENTITY_FIELDS.map(field => [field, row[field]])))
    .sort((left, right) => byJson(IDENTITY_ORDER_FIELDS.map(field => left[field]), IDENTITY_ORDER_FIELDS.map(field => right[field])));
}
