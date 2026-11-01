import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';
import type { RawConfiguration } from '../src/model/types.js';
import {
  generateConfigId,
  retrieveConfigId,
  querySids,
  customizeSid,
} from '../src/domain/configId.js';
import {
  inspectAutoFixCandidates,
  buildAutoFixCurrentSelections,
  executeAutoFix,
  applyAutoFixSections,
} from '../src/domain/autoFix.js';
import {
  fetchConvergedCategoryDetail,
  fetchSpecialtyCatalog,
} from '../src/domain/specialtyCatalog.js';
import {
  fetchUpstreamFeatureDetails,
  summarizeFeatureSpec,
} from '../src/domain/featureDetails.js';
import {
  fetchSubTabRecommendations,
  fetchSmartLfoRecommendation,
} from '../src/domain/recommendations.js';
import {
  fetchVlhAttributes,
} from '../src/domain/vlh.js';
import { fetchVirtualContainerCompatibleProducts, checkVirtualContainerRules } from '../src/domain/virtualContainers.js';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';

type Obj = Record<string, unknown>;

interface ExportDataShape {
  toggle7116On?: boolean;
  workspace: {
    rackArea: Obj[];
    nonRackArea: Obj[];
  };
  workspaceInformation?: Obj;
  configurations?: Obj[];
  cloneDependencyColor: Record<string, Obj>;
}

const services: DcscService[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(services.splice(0).map((s) => s.close()));
  vi.restoreAllMocks();
});

async function createHarness() {
  const service = new DcscService(
    ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }),
  );
  services.push(service);
  const server = new McpServer({ name: 'lenovo-dcsc-adversarial', version: '0.1.0' });
  registerTools(server, service);
  const client = new Client({ name: 'adversarial-client', version: '1.0.0' });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { service, server, client };
}

function createMinimalRawConfig(id: string, code = '7D73CTO1WW', quantity = 1): RawConfiguration {
  return {
    id,
    code,
    type: 'SERVER',
    quantity,
    totalPrice: 5000,
    tabs: [
      {
        title: 'Processors',
        type: 'hardware',
        subTabs: [
          {
            id: 'subtab-cpu',
            title: 'CPU',
            sections: [
              {
                id: 'sec-cpu',
                name: 'PROCESSOR',
                title: 'Processor Selection',
                features: [
                  {
                    code: 'BB2T',
                    name: 'Intel Xeon Silver 4410Y',
                    description: 'Intel Xeon Silver 4410Y 12C 150W 2.0GHz',
                    unitPrice: 750,
                    type: 'hardware',
                  },
                  {
                    code: 'BB2U',
                    name: 'Intel Xeon Gold 5415+',
                    description: 'Intel Xeon Gold 5415+ 8C 150W 2.9GHz',
                    unitPrice: 950,
                    type: 'hardware',
                  },
                ],
                results: [
                  {
                    code: 'BB2T',
                    quantity: 1,
                    description: 'Intel Xeon Silver 4410Y',
                    characterName: 'PROCESSOR',
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function createSession(
  service: DcscService,
  raw: RawConfiguration,
  mode: 'cto' | 'lfo' = 'cto',
  solutionMode = 'General Purpose',
) {
  const configurationId = String(raw.id);
  return service.sessions.create({
    raw,
    configurationId,
    locale: service.locale,
    solution: { solutionMode, masterSlices: [solutionMode === 'General Purpose' ? 'GP' : 'HPC'] },
    mode,
    primed: true,
    reduced: reduceConfiguration(raw, configurationId),
  });
}

describe('Empirical Adversarial Parity Challenge (R1 - R6)', () => {
  describe('R1: Online Config ID & SIDs — Stress & Boundary Attacks', () => {
    it('generateConfigId: handles malformed upstream responses without leaking unhandled errors', async () => {
      const { service } = await createHarness();
      const ctx = service.newCtx();

      // Empty string
      vi.spyOn(service.http, 'send').mockResolvedValueOnce({ raw: '   ' } as never);
      await expect(generateConfigId(service.http, ctx)).rejects.toThrow(
        /empty or invalid Configuration ID/,
      );

      // Quoted string extraction
      vi.spyOn(service.http, 'send').mockResolvedValueOnce({ raw: '"ABC123XYZ0"' } as never);
      const res1 = await generateConfigId(service.http, ctx);
      expect(res1.configId).toBe('ABC123XYZ0');

      // Object with configuration_id
      vi.spyOn(service.http, 'send').mockResolvedValueOnce({
        raw: { configuration_id: 'CONF999888' },
      } as never);
      const res2 = await generateConfigId(service.http, ctx);
      expect(res2.configId).toBe('CONF999888');

      // Object with empty fields
      vi.spyOn(service.http, 'send').mockResolvedValueOnce({ raw: {} } as never);
      await expect(generateConfigId(service.http, ctx)).rejects.toThrow(
        /empty or invalid Configuration ID/,
      );
    });

    it('retrieveConfigId: verifies boundary rejections, error messages, and currentFileType normalization', async () => {
      const { service } = await createHarness();
      const ctx = service.newCtx();
      const httpSpy = vi.spyOn(service.http, 'send');

      // Whitespace rejection
      await expect(retrieveConfigId(service.http, '   ', [], ctx)).rejects.toThrow(
        /non-empty configuration ID is required/,
      );
      expect(httpSpy).not.toHaveBeenCalled();

      // Upstream errorMessage extraction
      httpSpy.mockResolvedValueOnce({
        raw: { errorMessage: 'Configuration expired or already claimed' },
      } as never);
      await expect(retrieveConfigId(service.http, 'EXPIRED_ID', [], ctx)).rejects.toThrow(
        /Configuration expired or already claimed/,
      );

      // Empty array response
      httpSpy.mockResolvedValueOnce({ raw: [] } as never);
      await expect(retrieveConfigId(service.http, 'EMPTY_ID', [], ctx)).rejects.toThrow(
        /returned no configuration data/,
      );

      // currentFileType normalization to CTO for arbitrary strings
      httpSpy.mockResolvedValueOnce({ raw: [{ id: 'hydrated-1' }] } as never);
      await retrieveConfigId(service.http, 'VALID_ID', ['existing-1'], ctx, 'arbitrary_type<script>');
      expect(httpSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          query: expect.objectContaining({ currentFileType: 'CTO' }),
          body: {
            kind: 'multipart',
            parts: [{ name: 'configurationIds', value: 'existing-1' }],
          },
        }),
      );

      // currentFileType normalization for LFO
      httpSpy.mockResolvedValueOnce({ raw: [{ id: 'hydrated-lfo' }] } as never);
      await retrieveConfigId(service.http, 'VALID_ID', [], ctx, 'lfo');
      expect(httpSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          query: expect.objectContaining({ currentFileType: 'LFO' }),
        }),
      );
    });

    it('querySids & customizeSid: adversarial inputs (URL special chars, empty inputs, pagination edge cases)', async () => {
      const { service } = await createHarness();
      const ctx = service.newCtx();
      const httpSpy = vi.spyOn(service.http, 'send');

      // Empty categoryId throws immediately
      await expect(querySids(service.http, { categoryId: '   ' }, ctx)).rejects.toThrow(
        /A category ID is required/,
      );
      expect(httpSpy).not.toHaveBeenCalled();

      // Category with slashes and special characters gets safely URL encoded
      httpSpy.mockResolvedValueOnce({
        raw: {
          content: [
            {
              sidShortDesc: 'SID Test',
              sidNumber: 'SID001',
              cpu: ['CPU 1'],
              ram: ['RAM 1'],
              storage: null, // tests null array resilience
              gpu: 'not-an-array', // tests invalid type resilience
              network: [],
              ctoCount: 'invalid-num', // tests fallback
              sidPrice: null,
            },
          ],
          totalElements: 1,
          number: 1,
        },
      } as never);

      const sidRes = await querySids(
        service.http,
        { categoryId: 'SERVER/STORAGE & SPECIAL?ID', pageIndex: 1, pageSize: 10 },
        ctx,
      );
      expect(httpSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/sids/query/SERVER%2FSTORAGE%20%26%20SPECIAL%3FID',
        }),
      );
      expect(sidRes.content[0]?.storage).toEqual([]);
      expect(sidRes.content[0]?.gpu).toEqual([]);
      expect(sidRes.content[0]?.ctoCount).toBe(1);
      expect(sidRes.content[0]?.sidPrice).toBe(0);

      // customizeSid empty input check
      await expect(customizeSid(service.http, '   ', ctx)).rejects.toThrow(
        /A non-empty SID number is required/,
      );

      // customizeSid returns non-object / array throws
      httpSpy.mockResolvedValueOnce({ raw: ['array-is-not-solution-payload'] } as never);
      await expect(customizeSid(service.http, 'SID_FAIL', ctx)).rejects.toThrow(
        /returned no customizable reference solution/,
      );
    });
  });

  describe('R2: Hardware Auto-Fix — Concurrency, Skew, and Resilient Section Merging', () => {
    it('buildAutoFixCurrentSelections: aggregates duplicates, ignores empty, handles unselectable & top-level sections', () => {
      const rawWithDuplicates: RawConfiguration = {
        id: 'dup-node',
        code: '7D73CTO1WW',
        type: 'SERVER',
        quantity: 1,
        totalPrice: 1000,
        tabs: [
          {
            title: 'Tab 1',
            type: 'hardware',
            subTabs: [
              {
                id: 'subtab-1',
                title: 'Sub 1',
                sections: [
                  {
                    id: 's1',
                    name: 'MEMORY',
                    results: [
                      { code: 'MEM1', quantity: 2 },
                      { code: 'MEM1', quantity: 4 }, // duplicate in same section
                      { code: 'MEM2', quantity: 1 },
                      { code: '', quantity: 5 }, // empty code ignored
                    ],
                  },
                ],
              },
            ],
          },
        ],
        // unselectableCharacters
        unSelectableCharacters: [
          {
            name: 'CHASSIS_BASE',
            results: [{ featureCode: 'BASE01', quantity: 1 }],
          },
        ],
        // top-level sections
        sections: [
          {
            name: 'SECURITY',
            results: [{ featureCode: 'TPM01', quantity: 1 }],
          },
        ],
      };

      const selections = buildAutoFixCurrentSelections(rawWithDuplicates);
      const memSec = selections.find((s) => s.name === 'MEMORY');
      expect(memSec).toBeDefined();
      const mem1 = memSec?.results.find((r) => r.featureCode === 'MEM1');
      expect(mem1?.quantity).toBe(6); // 2 + 4 aggregated

      const chassisSec = selections.find((s) => s.name === 'CHASSIS_BASE');
      expect(chassisSec).toBeDefined();
      expect(chassisSec?.results[0]?.featureCode).toBe('BASE01');

      const secSec = selections.find((s) => s.name === 'SECURITY');
      expect(secSec).toBeDefined();
      expect(secSec?.results[0]?.featureCode).toBe('TPM01');
    });

    it('applyAutoFixSections: preserves untouched sections, merges metadata for new features, clears errors', () => {
      const raw = createMinimalRawConfig('node-1');
      const targetSec = raw.tabs![0]!.subTabs![0]!.sections![0]!;
      targetSec.errors = ['Rule Violation: Invalid CPU selection'];

      const fixedSections = [
        {
          name: 'PROCESSOR',
          results: [
            {
              featureCode: 'BB2U', // existing in features list -> metadata merged
              quantity: 2,
            },
            {
              featureCode: 'UNKNOWN_FEAT', // not in features list -> safe fallback
              quantity: 1,
              description: 'Brand new feature',
            },
          ],
          errors: [],
        },
        {
          name: 'NON_EXISTENT_SECTION', // section not in config -> safely ignored
          results: [{ featureCode: 'FOO', quantity: 1 }],
        },
      ];

      const { configuration, sectionsChanged } = applyAutoFixSections(raw, fixedSections);
      expect(sectionsChanged).toEqual(['PROCESSOR']);

      const updatedSec = configuration.tabs![0]!.subTabs![0]!.sections![0]!;
      expect(updatedSec.errors).toEqual([]);
      expect(updatedSec.results).toHaveLength(2);

      // BB2U took unitPrice from existing features list
      const bb2u = updatedSec.results!.find((r) => r.code === 'BB2U');
      expect(bb2u?.quantity).toBe(2);
      expect(bb2u?.cost).toBe(950);
      expect(bb2u?.description).toBe('Intel Xeon Gold 5415+ 8C 150W 2.9GHz');

      // UNKNOWN_FEAT used fallback description and default cost 0
      const unknownFeat = updatedSec.results!.find((r) => r.code === 'UNKNOWN_FEAT');
      expect(unknownFeat?.quantity).toBe(1);
      expect(unknownFeat?.cost).toBe(0);
      expect(unknownFeat?.description).toBe('Brand new feature');
    });

    it('dcsc_auto_fix: CAS revision skew and non-CTO rejection via MCP tool', async () => {
      const { service, client } = await createHarness();
      const raw = createMinimalRawConfig('node-test');
      const session = createSession(service, raw, 'cto');

      // 1. Revision conflict: pass expectedRevision: 999
      const skewRes = await client.callTool({
        name: 'dcsc_auto_fix',
        arguments: {
          session: session.id,
          expectedRevision: 999,
        },
      });
      expect(skewRes.isError).toBe(true);
      expect(((skewRes.content as Array<{ text: string }>)[0]?.text) ?? '').toMatch(
        /Revision conflict for configuration: expected 999, current 1/i,
      );

      // Verify session was NOT mutated
      expect(session.revision).toBe(1);

      // 2. Non-CTO session rejection
      const lfoSession = createSession(service, { ...raw, id: 'lfo-node' }, 'lfo');

      const lfoRes = await client.callTool({
        name: 'dcsc_auto_fix',
        arguments: {
          session: lfoSession.id,
        },
      });
      expect(lfoRes.isError).toBe(true);
      expect(((lfoRes.content as Array<{ text: string }>)[0]?.text) ?? '').toMatch(
        /Auto-fix is only supported for hardware CTO configurations/i,
      );
    });

    it('dcsc_auto_fix: concurrent transactions serialize cleanly without corruption', async () => {
      const { service } = await createHarness();
      const raw = createMinimalRawConfig('node-concurrent');
      const session = createSession(service, raw, 'cto');

      let callCount = 0;
      vi.spyOn(service.http, 'send').mockImplementation(async (req) => {
        if (req.path === '/cto/hardware/autoFix/config') {
          return { raw: [{ tabTitle: 'Proc', characterName: 'PROCESSOR', characterDesc: 'CPU' }] } as never;
        }
        if (req.path === '/cto/hardware/autoFix') {
          callCount++;
          // simulate slight async latency
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            raw: {
              autoFixResult: 'FIX_SUCCESS',
              sections: [
                {
                  name: 'PROCESSOR',
                  results: [{ featureCode: 'BB2U', quantity: 1 }],
                },
              ],
            },
          } as never;
        }
        if (req.path === '/ctos/autoDerive') {
          return {
            raw: {
              configurations: [
                {
                  ...session.raw,
                  totalPrice: 5200,
                },
              ],
            },
          } as never;
        }
        throw new Error(`Unexpected request: ${req.path}`);
      });

      // Fire two concurrent autoFix requests
      // Both specify expectedRevision: 1.
      // One will commit first and advance revision to 2.
      // The second will fail CAS and abort cleanly.
      const p1 = service.autoFix(session.id, { expectedRevision: 1, ctx: service.newCtx() });
      const p2 = service.autoFix(session.id, { expectedRevision: 1, ctx: service.newCtx() });

      const results = await Promise.allSettled([p1, p2]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      if (rejected[0]?.status === 'rejected') {
        expect(rejected[0].reason.message).toMatch(/revision/i);
      }
      expect(session.revision).toBe(2);
      expect(callCount).toBeGreaterThanOrEqual(1);
    });

    it('inspectAutoFixCandidates & executeAutoFix: validate input constraints', async () => {
      const { service } = await createHarness();
      const ctx = service.newCtx();

      await expect(inspectAutoFixCandidates(service.http, '', ctx)).rejects.toThrow(
        /A CTO product code is required/,
      );
      await expect(executeAutoFix(service.http, '', [], [], ctx)).rejects.toThrow(
        /A CTO product code is required/,
      );
    });
  });

  describe('R3: Specialty Catalogs — Adversarial Parameters & Encodings', () => {
    it('fetchConvergedCategoryDetail: rejects empty/invalid inputs & handles special characters', async () => {
      const { service } = await createHarness();
      const ctx = service.newCtx();
      const httpSpy = vi.spyOn(service.http, 'send');

      await expect(fetchConvergedCategoryDetail(service.http, ctx, '')).rejects.toThrow(
        /non-empty categoryId is required/,
      );
      await expect(fetchConvergedCategoryDetail(service.http, ctx, '   ')).rejects.toThrow(
        /non-empty categoryId is required/,
      );

      // Special characters in categoryId
      httpSpy.mockResolvedValueOnce({ raw: { categoryId: 'CAT%2F1' } } as never);
      await fetchConvergedCategoryDetail(service.http, ctx, 'CAT/1?x=y');
      expect(httpSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/multiprod_category_detail/CAT%2F1%3Fx%3Dy',
        }),
      );

      // Upstream returning non-object
      httpSpy.mockResolvedValueOnce({ raw: ['unexpected', 'array'] } as never);
      await expect(fetchConvergedCategoryDetail(service.http, ctx, 'CAT1')).rejects.toThrow(
        /invalid converged category detail/,
      );
    });

    it('fetchSpecialtyCatalog: unknown subType defaults to hierarchies', async () => {
      const { service } = await createHarness();
      const ctx = service.newCtx();
      const httpSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
        raw: { id: 'promo-root', children: [] },
      } as never);

      const res = await fetchSpecialtyCatalog(service.http, ctx, {
        type: 'promotion',
        subType: 'unknown_sub_type' as never,
      });

      expect(res.type).toBe('promotion');
      expect(httpSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/promotion/hierarchies',
        }),
      );
    });
  });

  describe('R4: Feature Details & Smart Recommendations — Edge Cases & Date Parsing', () => {
    it('fetchUpstreamFeatureDetails: returns empty array immediately for empty code list', async () => {
      const { service } = await createHarness();
      const ctx = service.newCtx();
      const httpSpy = vi.spyOn(service.http, 'send');

      const res = await fetchUpstreamFeatureDetails(service.http, ctx, '7D73CTO1WW', 'session-1', []);
      expect(res).toEqual([]);
      expect(httpSpy).not.toHaveBeenCalled();
    });

    it('summarizeFeatureSpec: handles extreme dates (FAR_FUTURE, invalid date strings, undefined)', () => {
      // 1. Far future date '2999-12-31'
      const specFarFuture = summarizeFeatureSpec({
        code: 'F01',
        description: 'Far Future Item',
        withdrawnDate: '2999-12-31T00:00:00Z',
      });
      expect(specFarFuture.lifecycle.isWithdrawn).toBe(false);

      // 2. Past date
      const specPast = summarizeFeatureSpec({
        code: 'F02',
        description: 'Past Item',
        withdrawnDate: '2020-01-01T00:00:00Z',
      });
      expect(specPast.lifecycle.isWithdrawn).toBe(true);

      // 3. Undefined date
      const specNoDate = summarizeFeatureSpec({
        code: 'F03',
        description: 'No Date Item',
      });
      expect(specNoDate.lifecycle.isWithdrawn).toBe(false);

      // 4. Invalid date string
      const specInvalidDate = summarizeFeatureSpec({
        code: 'F04',
        description: 'Invalid Date',
        withdrawnDate: 'NOT_A_VALID_DATE',
      });
      expect(specInvalidDate.lifecycle.isWithdrawn).toBe(false);
    });

    it('fetchSubTabRecommendations: validates productCode', async () => {
      const { service } = await createHarness();
      const ctx = service.newCtx();

      await expect(fetchSubTabRecommendations(service.http, ctx, 'CTO', '')).rejects.toThrow(
        /non-empty productCode is required/,
      );
      await expect(fetchSubTabRecommendations(service.http, ctx, 'CTO', '   ')).rejects.toThrow(
        /non-empty productCode is required/,
      );
    });

    it('fetchSmartLfoRecommendation: enforces 2-letter ISO country code and non-empty ctoCode', async () => {
      const { service } = await createHarness();
      const ctx = service.newCtx();

      await expect(fetchSmartLfoRecommendation(service.http, ctx, 'USA', '7D73')).rejects.toThrow(
        /valid 2-letter ISO country code/,
      );
      await expect(fetchSmartLfoRecommendation(service.http, ctx, '12', '7D73')).rejects.toThrow(
        /valid 2-letter ISO country code/,
      );
      await expect(fetchSmartLfoRecommendation(service.http, ctx, '', '7D73')).rejects.toThrow(
        /valid 2-letter ISO country code/,
      );
      await expect(fetchSmartLfoRecommendation(service.http, ctx, 'US', '   ')).rejects.toThrow(
        /non-empty ctoCode is required/,
      );

      // Lowercase country gets normalized to uppercase in path
      const httpSpy = vi.spyOn(service.http, 'send').mockResolvedValueOnce({
        raw: { lfoResponses: [] },
      } as never);
      await fetchSmartLfoRecommendation(service.http, ctx, 'de', '7D73CTO1WW');
      expect(httpSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/smart/recommend/lfo/DE/7D73CTO1WW',
        }),
      );
    });
  });

  describe('R5: Unracked Multi-Unit Auto-Expansion — Boundary & Extreme Scaling', () => {
    it('buildExportData: scales to 25 units without ID collision, sets cloneDependency and colors', async () => {
      const { service } = await createHarness();
      const raw = createMinimalRawConfig('node-scale', '7D73CTO1WW', 25);
      const session = createSession(service, raw, 'cto');

      const workspace = service.sessions.getWorkspace(session.id)!;
      workspace.nonRackArea = [
        { id: raw.id!, code: raw.code, type: 'server', size: 1, quantity: 25, originalIds: [raw.id!] },
      ];

      const exportData = buildExportData({
        workspace,
        solution: workspace.solution,
        fileTypes: ['XML'],
        validationMode: 'guided',
      }) as unknown as ExportDataShape;

      // nonRackArea has the root item with quantity 25 and 25 originalIds
      const nonRackItem = exportData.workspace.nonRackArea[0];
      expect(nonRackItem).toBeDefined();
      expect(nonRackItem?.['quantity']).toBe(25);
      const originalIds = (nonRackItem?.['originalIds'] as string[]) ?? [];
      expect(originalIds).toHaveLength(25);
      expect(originalIds[0]).toBe('node-scale');

      // Clones named node-scale__clone_1 ... node-scale__clone_24
      for (let i = 1; i <= 24; i++) {
        expect(originalIds[i]).toBe(`node-scale__clone_${i}`);
      }

      // Ensure all 25 IDs are completely distinct
      const uniqueIds = new Set(originalIds);
      expect(uniqueIds.size).toBe(25);

      // Verify cloneDependency has the root mapping to all 25 IDs
      expect(exportData.cloneDependencyColor['node-scale']).toBeDefined();
      const colorEntry = exportData.cloneDependencyColor['node-scale'] as Obj;
      expect(colorEntry['root']).toBe('node-scale');
      expect(colorEntry['dependBy']).toEqual(originalIds);
    });

    it('buildExportData: singleton (quantity = 1) produces zero clones', async () => {
      const { service } = await createHarness();
      const raw = createMinimalRawConfig('node-singleton', '7D73CTO1WW', 1);
      const session = createSession(service, raw, 'cto');

      const workspace = service.sessions.getWorkspace(session.id)!;
      workspace.nonRackArea = [
        { id: raw.id!, code: raw.code, type: 'server', size: 1, quantity: 1, originalIds: [raw.id!] },
      ];

      const exportData = buildExportData({
        workspace,
        solution: workspace.solution,
        fileTypes: ['XML'],
        validationMode: 'guided',
      }) as unknown as ExportDataShape;

      const nonRackItem = exportData.workspace.nonRackArea[0];
      expect(nonRackItem?.['quantity']).toBe(1);
      const originalIds = (nonRackItem?.['originalIds'] as string[]) ?? [];
      expect(originalIds).toEqual(['node-singleton']);
      // nonRackData has only the single root record, no clones
      const nonRackData = (exportData.workspaceInformation as Obj).nonRackData as Array<Record<string, unknown>>;
      expect(nonRackData).toHaveLength(1);
      expect(nonRackData[0]?.['id']).toBe('node-singleton');
      // cloneDependency has dependBy with only the singleton ID
      const colorEntry = exportData.cloneDependencyColor['node-singleton'] as Obj;
      expect(colorEntry?.['dependBy']).toEqual(['node-singleton']);
    });

    it('buildExportData: non-General Purpose solution mode replicates configurations array', async () => {
      const { service } = await createHarness();
      const raw = createMinimalRawConfig('node-hpc', '7D73CTO1WW', 3);
      const session = createSession(service, raw, 'cto', 'High Performance Computing');

      const workspace = service.sessions.getWorkspace(session.id)!;
      workspace.nonRackArea = [
        { id: raw.id!, code: raw.code, type: 'server', size: 1, quantity: 3, originalIds: [raw.id!] },
      ];

      const exportData = buildExportData({
        workspace,
        solution: workspace.solution,
        fileTypes: ['XML'],
        validationMode: 'guided',
      }) as unknown as ExportDataShape;

      expect(exportData.toggle7116On).toBe(true);
      // In HPC mode, configurations array expands to 3 configurations
      expect(exportData.configurations).toHaveLength(3);
      expect(exportData.configurations?.[0]?.['id']).toBe('node-hpc');
      expect(exportData.configurations?.[1]?.['id']).toBe('node-hpc__clone_1');
      expect(exportData.configurations?.[2]?.['id']).toBe('node-hpc__clone_2');
    });

    it('buildExportData: mixed workspace keeps racked items intact while expanding unracked multi-units', async () => {
      const { service } = await createHarness();
      const rawRacked = createMinimalRawConfig('racked-node', '7D73CTO1WW', 1);
      const rawUnracked = createMinimalRawConfig('unracked-multi', '7D73CTO1WW', 4);

      const sessionRacked = createSession(service, rawRacked, 'cto');
      const sessionUnracked = createSession(service, rawUnracked, 'cto');

      const workspace = service.sessions.getWorkspace(sessionRacked.id)!;
      // Merge unracked configuration into same workspace
      workspace.configurations.set(sessionUnracked.id, sessionUnracked);

      // Place racked node into rackArea
      workspace.rackArea = [
        {
          id: 'rack-1',
          code: '7D73RACK',
          type: 'rack',
          rackItems: [
            { id: 'racked-node', code: '7D73CTO1WW', type: 'server', size: 1, position: 10 },
          ],
        },
      ];

      // Place unracked multi-unit into nonRackArea
      workspace.nonRackArea = [
        { id: 'unracked-multi', code: '7D73CTO1WW', type: 'server', size: 1, quantity: 4, originalIds: ['unracked-multi'] },
      ];

      const exportData = buildExportData({
        workspace,
        solution: workspace.solution,
        fileTypes: ['XML'],
        validationMode: 'guided',
      }) as unknown as ExportDataShape;

      // Racked area must have exactly 1 child without synthetic clones
      const rackChildren = (exportData.workspace.rackArea[0]?.['children'] ?? []) as Obj[];
      expect(rackChildren).toHaveLength(1);
      expect(rackChildren[0]?.['id']).toBe('racked-node');

      // Unracked area must be expanded to 4 originalIds
      const nonRackItem = exportData.workspace.nonRackArea[0];
      expect(nonRackItem?.['quantity']).toBe(4);
      expect(nonRackItem?.['originalIds']).toHaveLength(4);
      expect(nonRackItem?.['originalIds']).toEqual([
        'unracked-multi',
        'unracked-multi__clone_1',
        'unracked-multi__clone_2',
        'unracked-multi__clone_3',
      ]);
    });

    it('buildExportData: high-volume scale test (100 units) executes in milliseconds with zero collisions', async () => {
      const { service } = await createHarness();
      const raw = createMinimalRawConfig('node-huge', '7D73CTO1WW', 100);
      const session = createSession(service, raw, 'cto');

      const workspace = service.sessions.getWorkspace(session.id)!;
      workspace.nonRackArea = [
        { id: raw.id!, code: raw.code, type: 'server', size: 1, quantity: 100, originalIds: [raw.id!] },
      ];

      const start = Date.now();
      const exportData = buildExportData({
        workspace,
        solution: workspace.solution,
        fileTypes: ['XML'],
        validationMode: 'guided',
      }) as unknown as ExportDataShape;
      const durationMs = Date.now() - start;

      expect(durationMs).toBeLessThan(100); // must be ultra fast
      const nonRackItem = exportData.workspace.nonRackArea[0];
      expect(nonRackItem?.['quantity']).toBe(100);
      const originalIds = (nonRackItem?.['originalIds'] as string[]) ?? [];
      expect(originalIds).toHaveLength(100);
      const unique = new Set(originalIds);
      expect(unique.size).toBe(100);
    });
  });

  describe('R6: VLH & Virtual Containers — Edge Validation & Resilience', () => {
    it('fetchVlhAttributes: rejects empty/invalid code and encodes URL', async () => {
      const { service } = await createHarness();
      const ctx = service.newCtx();
      const httpSpy = vi.spyOn(service.http, 'send');

      await expect(fetchVlhAttributes(service.http, '', ctx)).rejects.toThrow(
        /non-empty product or VLH item code is required/,
      );

      httpSpy.mockResolvedValueOnce({
        raw: { type: 'basic', attributes: {}, connectors: [] },
      } as never);
      await fetchVlhAttributes(service.http, 'VLH/ITEM #1', ctx);
      expect(httpSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/vlh/attributes/VLH%2FITEM%20%231',
        }),
      );
    });

    it('fetchVirtualContainerCompatibleProducts: handles null/empty responses', async () => {
      const { service } = await createHarness();
      const ctx = service.newCtx();
      const raw = createMinimalRawConfig('vc-node');
      const session = createSession(service, raw, 'cto');
      const workspace = service.sessions.getWorkspace(session.id)!;

      // Null response returns empty array
      vi.spyOn(service.http, 'send').mockResolvedValueOnce({ raw: null } as never);
      const compat = await fetchVirtualContainerCompatibleProducts(service.http, workspace, ctx);
      expect(compat).toEqual([]);

      // checkVirtualContainerRules null response returns empty array
      vi.spyOn(service.http, 'send').mockResolvedValueOnce({ raw: null } as never);
      const rules = await checkVirtualContainerRules(service.http, workspace, ctx);
      expect(rules).toEqual([]);
    });
  });

  describe('MCP Server Safety: Unhandled Rejection & Panic Prevention', () => {
    it('ensures tools return isError: true on domain failures without terminating server', async () => {
      const { client } = await createHarness();

      // 1. Invalid Config ID import
      const resImport = await client.callTool({
        name: 'dcsc_import',
        arguments: { configId: 'NOT_FOUND_ID' },
      });
      expect(resImport.isError).toBe(true);

      // 2. Invalid category call
      const resCat = await client.callTool({
        name: 'dcsc_category',
        arguments: { kind: 'detail' },
      });
      expect(resCat.isError).toBe(true);

      // 3. Invalid search call
      const resSearch = await client.callTool({
        name: 'dcsc_search',
        arguments: { kind: 'products' },
      });
      expect(resSearch.isError).toBe(true);

      // Verify client connection is still alive and responsive after multiple failed calls
      const listRes = await client.listTools();
      expect(listRes.tools.length).toBeGreaterThan(0);
    });
  });
});
