/** Hardware plus standalone software round trip: website-authored quantity-3 source, MCP edit to 4, website oracle. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { normalizers, type Harness, type Json } from './harness.js';
import { readGrandTotal } from './exportUi.js';
import {
  captureBrowserExport, composeBrowserSoftware, importInBrowser, money, object, array, setBrowserHardwareOption,
  setBrowserSoftwareQuantity, SOFTWARE_CODE,
} from './softwareSummaryUi.js';

const SOURCE_QUANTITY = 3;
const EDITED_QUANTITY = 4;
const LFO_PRODUCT = '7DCE100GNA';
const HARDWARE_SECTION = 'UEFI_OPERATING_MODES';
const HARDWARE_CODE = 'BFYB';
const standaloneLine = (groups: ReturnType<typeof normalizers.wireRequest>['groups'], quantity: number) =>
  groups.find(product => product.code === SOFTWARE_CODE && product.type === 'standalone' && product.quantity === quantity);

export interface MixedVariant {
  summaryRoute: RegExp;
  /** The XML the website imports first, and whether software is composed through the catalog (hardware-only seed). */
  seed(h: Harness): Promise<{ xmlPath: string; composeSoftware: boolean }>;
  /** LFO only: also change a hardware option on both sides. */
  hardwareOption: boolean;
}

export const CTO_VARIANT: MixedVariant = {
  summaryRoute: /#\/rack-summary\/rack-cto/,
  hardwareOption: false,
  seed: async () => ({ xmlPath: path.resolve('test/fixtures/parity/xml/mixed-hw-sw-service.xml'), composeSoftware: false }),
};

export const LFO_VARIANT: MixedVariant = {
  summaryRoute: /#\/rack-summary\/rack-lfo/,
  hardwareOption: true,
  seed: async h => {
    const launched = await h.mcp.call('dcsc_launch', { productCode: LFO_PRODUCT, mode: 'lfo', solutionMode: 'General Purpose', label: 'mixed LFO parity seed' });
    const exported = await h.mcp.call('dcsc_export', { kind: 'reports', session: launched['session'], scope: 'configuration',
      fileName: 'lfo-hardware-seed', fileTypes: ['XML'] });
    const xmlPath = path.join(h.out, 'lfo-hardware-seed.xml');
    await copyFile(String(exported['xml']), xmlPath);
    return { xmlPath, composeSoftware: true };
  },
};

export async function runMixedSoftwareCase(h: Harness, variant: MixedVariant): Promise<void> {
  const { mcp, web, step, compare, out } = h;
  const standaloneState = (workspaceId: string) => {
    const workspace = mcp.persistedWorkspaces().find(entry => entry['id'] === workspaceId);
    assert(workspace, 'MCP workspace was not persisted.');
    const selection = object(array(object(object(workspace['serverState'])['standaloneSoftwareState'])['selections'])[0]);
    return { code: selection['code'], quantity: selection['quantity'], unitPrice: selection['unitPrice'], totalPrice: selection['totalPrice'] };
  };

  const source = await step('website-source', async () => {
    const seed = await variant.seed(h);
    const page = await web.newPage();
    await importInBrowser(page, seed.xmlPath, variant.summaryRoute);
    if (seed.composeSoftware) await composeBrowserSoftware(page, SOURCE_QUANTITY, variant.summaryRoute);
    return { ...(await captureBrowserExport(page, out, 'browser-mixed-qty3-source')), total: await readGrandTotal(page) };
  });
  const sourceLine = standaloneLine(normalizers.wireRequest({ groups: JSON.stringify(source.groups) }).groups, SOURCE_QUANTITY);

  const mcpResult = await step('mcp-edit-and-export', async () => {
    const imported = await mcp.call('dcsc_import', { content: source.xml, solutionMode: 'General Purpose' });
    const workspace = String(imported['session']);
    compare('imported-software', { code: SOFTWARE_CODE, quantity: SOURCE_QUANTITY, unitPrice: sourceLine?.unitPrice, totalPrice: sourceLine?.price },
      standaloneState(workspace));
    let hardware: Json | undefined;
    if (variant.hardwareOption) {
      const session = String((array(imported['configurations'])[0] as Json)['id']);
      await mcp.call('dcsc_configure', { session, changes: [{ section: HARDWARE_SECTION, code: HARDWARE_CODE, quantity: 1 }] });
      hardware = object(object(array(mcp.persistedWorkspaces().find(entry => entry['id'] === workspace)?.['configurations'])[0])['raw']);
    }
    await mcp.call('dcsc_launch', { mode: 'software', session: workspace, refresh: true });
    const refreshed = standaloneState(workspace);
    compare('refresh-keeps-imported-price', { code: SOFTWARE_CODE, quantity: SOURCE_QUANTITY, unitPrice: sourceLine?.unitPrice, totalPrice: sourceLine?.price },
      refreshed);
    await mcp.call('dcsc_basket_set', { basket: 'software', action: 'setQuantity', session: workspace, code: SOFTWARE_CODE, quantity: EDITED_QUANTITY });
    const exported = await mcp.call('dcsc_export', { kind: 'reports', session: workspace, fileName: 'mcp-mixed-qty4', fileTypes: ['XML'] });
    return { xmlPath: String(exported['xml']), hardware, edited: standaloneState(workspace) };
  });

  await step('website-oracle', async () => {
    const page = await web.newPage();
    await importInBrowser(page, source.xmlPath, variant.summaryRoute);
    let hardware: Awaited<ReturnType<typeof setBrowserHardwareOption>> | undefined;
    if (variant.hardwareOption) hardware = await setBrowserHardwareOption(page, out);
    await setBrowserSoftwareQuantity(page, EDITED_QUANTITY, variant.summaryRoute);
    const oracleTotal = await readGrandTotal(page);
    const oracle = await captureBrowserExport(page, out, 'browser-mixed-qty4-oracle');
    const oracleGroups = normalizers.wireRequest({ groups: JSON.stringify(oracle.groups) }).groups;
    const oracleLine = standaloneLine(oracleGroups, EDITED_QUANTITY);

    compare('edited-software-line', { code: SOFTWARE_CODE, quantity: EDITED_QUANTITY, unitPrice: oracleLine?.unitPrice, totalPrice: oracleLine?.price },
      mcpResult.edited);
    if (hardware && mcpResult.hardware) {
      compare('hardware-option', { totalPrice: hardware.totalPrice, price: hardware.price },
        { totalPrice: money(mcpResult.hardware['totalPrice']), price: money(mcpResult.hardware['price'] ?? array(mcpResult.hardware['totalPrices']).map(object)[0]?.['price']) });
    }
    compare('mixed-xml-bom', normalizers.cfxml(oracle.xml), normalizers.cfxml(readFileSync(mcpResult.xmlPath, 'utf8')));

    const reimportPage = await web.newPage();
    const reimported = await importInBrowser(reimportPage, mcpResult.xmlPath, variant.summaryRoute);
    const envelope = object(array(reimported.response)[0]);
    await writeFile(path.join(out, 'browser-reimport-groups.json'), JSON.stringify(envelope['groups'], null, 2));
    compare('reimport-groups', oracleGroups, normalizers.wireRequest({ groups: JSON.stringify(envelope['groups']) }).groups);
    compare('reimport-total', oracleTotal, reimported.total);
  });
}
