import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { CONFIG_MODES } from '../config/constants.js';
import { detachedNestedNodeIds } from '../domain/nestedPhysical.js';
import { powerLoadFactor } from '../domain/power.js';
import { configurationListPrice } from '../domain/pricing.js';
import { DEFAULT_EXPORT_TYPES, type ExportFileType } from '../domain/reduce.js';
import { sanitiseFileName, writeExportBundle } from '../files/artifactStore.js';
import type { DcscService } from './service.js';
import { exportProductServiceArtifact, exportStandaloneSoftwareArtifact } from './standaloneTools.js';
import { guard, withToolSupport } from './toolSupport.js';

export function registerImportExportTools(rawServer: McpServer, service: DcscService): void {
  const server = withToolSupport(rawServer);

  server.registerTool(
    'dcsc_import',
    {
      title: 'Import a Lenovo CFXML or Excel configuration',
      description:
        'Imports a saved Lenovo CFXML string or a local CFXML/Excel file into a configuration session or workspace. Specify solutionMode for Excel when outside General Purpose.',
      inputSchema: {
        content: z.string().optional().describe('XML content string of the CFXML file.'),
        filePath: z.string().optional().describe('Absolute local file path to a CFXML (.xml) or DCSC Excel (.xlsx/.xls) file.'),
        mode: z.enum(CONFIG_MODES).optional(),
        expectedRevision: z.number().int().min(1).optional(),
        workspace: z.string().optional().describe('Optional existing workspace ID to import into.'),
        solutionMode: z
          .string()
          .optional()
          .describe(
            'Solution mode to import under. Defaults to the existing workspace mode, otherwise the XML declaration or General Purpose for Excel.',
          ),
      },
    },
    async (args) =>
      guard(async () => {
        let importContent: string | Uint8Array | undefined = args.content;
        const inputPath = args.filePath ?? (args.content &&
          (/\.(xml|xlsx|xls)$/i.test(args.content) || args.content.startsWith('/') || args.content.startsWith('./'))
          ? args.content : undefined);
        if (inputPath) {
          const { readFileSync } = await import('node:fs');
          importContent = readFileSync(inputPath);
        }
        if (!importContent) {
          throw new Error('Either content string or filePath must be provided.');
        }

        const ctx = service.newCtx();
        const res = await service.importConfig({
          content: importContent,
          ctx,
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          expectedRevision: args.expectedRevision,
          ...(args.workspace !== undefined ? { workspaceId: args.workspace } : {}),
          ...(args.solutionMode !== undefined ? { solutionMode: args.solutionMode } : {}),
          ...(inputPath !== undefined
            ? { fileName: inputPath.split(/[\\/]/).pop() ?? 'configuration.xml' }
            : {}),
        });

        const { missingParts, removedParts, replacedParts, eccnRestricted } = res.diagnostics;
        const lostParts = missingParts.length + removedParts.length;

        return {
          workspace: res.workspaceId,
          importedConfigurations: res.sessions.length,
          ...(res.standaloneKind ? { standaloneKind: res.standaloneKind } : {}),
          warnings: res.diagnostics.warnings ?? [],
          sessions: res.sessions.map((s) => ({
            id: s.id,
            productCode: s.product.code,
            description: s.product.description,
            quantity: s.raw.quantity ?? 1,
            totalPrice: configurationListPrice(s.raw),
            priceAvailable: configurationListPrice(s.raw) !== null,
          })),
          missingParts,
          removedParts,
          replacedParts,
          eccnRestricted,
          ...(lostParts > 0
            ? {
                warning:
                  `DCSC could not carry ${lostParts} part(s) across the import. ` +
                  'The imported configuration is incomplete and its price is not comparable ' +
                  'to the original.',
              }
            : {}),
          next: res.standaloneKind
            ? {
                tool:
                  res.standaloneKind === 'software'
                    ? 'dcsc_software_inspect'
                    : res.standaloneKind === 'hardware'
                      ? 'dcsc_standalone_hardware_inspect'
                      : 'dcsc_services_inspect',
                arguments: { workspace: res.workspaceId },
              }
            : { tool: 'dcsc_session_info', arguments: { session: res.workspaceId } },
        };
      }, 'dcsc_import failed'),
  );

  server.registerTool(
    'dcsc_export',
    {
      title: 'Export a configuration or solution workspace as XML + Excel',
      description:
        'Exports a configuration or workspace (including rack/floor layout and standalone software) to a ZIP on disk containing Lenovo CFXML and Excel quote reports, returning local file paths.',
      inputSchema: {
        session: z.string(),
        scope: z
          .enum(['auto', 'configuration', 'workspace'])
          .optional()
          .describe(
            'auto (default) infers from the handle: configuration id -> that product only, workspace id -> the whole solution.',
          ),
        fileName: z
          .string()
          .optional()
          .describe('Base name for the archive, without extension.'),
        fileTypes: z
          .array(
            z.enum([
              'XML',
              'QUOTE',
              'QUOTE_CSV',
              'EPRICE_CSV',
              'SUMMARY',
              'POWER_REPORT',
              'QUOTE_SUPPLYINFO',
              'QUOTE_GROUP',
              'RACK_REPORT',
              'RACK_DIAGRAM',
              'FLOOR',
              'MESSAGE_HISTORY',
              'P2P_REPORT',
            ]),
          )
          .optional()
          .describe('Defaults to the applicable reports for this workflow.'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = service.sessions.get(args.session);
        const workspace = service.sessions.getWorkspace(args.session);
        if (!session && !workspace) throw new Error(`Session / Workspace ${args.session} not found`);

        const pCode = session?.product.code ?? [...workspace!.configurations.values()][0]?.product.code ?? 'solution';
        const fileName = sanitiseFileName(args.fileName ?? `${pCode}-${Date.now()}`);
        const solution = workspace?.solution ?? session!.solution;
        const ctx = service.newCtx({ locale: workspace?.locale ?? session!.locale, solution });
        const workspaceScope = args.scope === 'workspace' || (args.scope !== 'configuration' && args.session === workspace?.id);
        if (workspaceScope && workspace) {
          const software = workspace.serverState.standaloneSoftwareState as { selections?: unknown[] } | undefined;
          const hardware = workspace.serverState.standaloneHardwareState as { selections?: unknown[] } | undefined;
          const services = workspace.serverState.standaloneServiceState as { selections?: unknown[] } | undefined;
          const softwareSelected = (software?.selections?.length ?? 0) > 0 || (hardware?.selections?.length ?? 0) > 0;
          const servicesSelected = (services?.selections?.length ?? 0) > 0;
          if (servicesSelected && (softwareSelected || workspace.configurations.size > 0)) {
            throw new Error('Combined independent service and hardware/software export is not yet verified. Export independent services with dcsc_services_export; no products have been silently omitted.');
          }
          if (servicesSelected || softwareSelected) {
            const bundle = servicesSelected
              ? await exportProductServiceArtifact(service, workspace, fileName)
              : await exportStandaloneSoftwareArtifact(service, workspace, fileName, {
                ...(args.fileTypes ? { fileTypes: args.fileTypes } : {}),
              });
            return { session: args.session, scope: 'workspace', configurationsExported: workspace.configurations.size,
              ...bundle, currency: workspace.locale.currency, priceType: 'LIST' };
          }
        }

        const { stream, contentDisposition, rackDataOmitted, scope, configurationsExported, manualPlanningLinksOmitted, breakoutBranchesAtRisk } =
          await service.exportZip(args.session, {
            fileTypes: (args.fileTypes ?? DEFAULT_EXPORT_TYPES) as ExportFileType[],
            fileName,
            ctx,
            ...(args.scope !== undefined ? { scope: args.scope } : {}),
          });

        const bundle = await writeExportBundle(stream, fileName, service.config);
        const powerSettings = (workspaceScope && workspace ? [...workspace.configurations.values()] : session ? [session] : [])
          .map(configuration => powerLoadFactor(configuration.raw));

        return {
          session: args.session,
          scope,
          configurationsExported,
          contentDisposition,
          ...bundle,
          priceType: 'LIST',
          rackDataOmitted,
          ...(powerSettings.some(value => value !== undefined && value !== 70) ? { powerSettingsWarning:
            'Lenovo CFXML reimport can reset custom load factors (verified SR630 V3: 100% to 70%). Saved MCP sessions retain them. Inspect dcsc_power_controls and reapply the desired load factor after XML import.' } : {}),
          ...(scope === 'workspace' && workspace && detachedNestedNodeIds(workspace).size > 0 ? {
            detachedNodesDroppedOnReimport: detachedNestedNodeIds(workspace).size,
            reimportWarning: 'Lenovo reimport drops physically detached nodes even though their commercial lines are exported. Undo detach and use unplace before exporting to retain them through reimport.',
          } : {}),
          ...(breakoutBranchesAtRisk > 0 ? { breakoutBranchesAtRisk,
            breakoutReimportWarning: 'DCSC website reimport has been observed to reset saved four-way breakout branches to point-to-point and change cable quantities. MCP import restores supported shapes and physical cable quantities from this XML; direct website handoff remains unverified.' } : {}),
          ...(manualPlanningLinksOmitted > 0 ? { manualPlanningLinksOmitted,
            warning: `${manualPlanningLinksOmitted} local planning link(s) are excluded from this Lenovo export. They remain inspectable in dcsc_workspace_layout. Use auto-connect for server-authored exportable connections.` } : {}),
          disclaimer:
            'List prices for the configured country and currency. Not a quote. ' +
            'A configuration containing errors cannot be imported into Lenovo quoting tools.',
        };
      }, 'dcsc_export failed'),
  );

  server.registerTool(
    'dcsc_generate_config_id',
    {
      title: 'Generate an online Lenovo DCSC Configuration ID',
      description: 'Generates a 10-character online configuration ID for an active session or workspace.',
      inputSchema: {
        session: z.string().optional().describe('Optional session or workspace ID to bind the Config ID to.'),
      },
    },
    async (args) =>
      guard(async () => {
        const result = await service.generateConfigId(args.session, service.newCtx());
        return {
          configId: result.configId,
          ...(args.session !== undefined ? { session: args.session } : {}),
        };
      }, 'dcsc_generate_config_id failed'),
  );

  server.registerTool(
    'dcsc_import_config_id',
    {
      title: 'Import an online configuration by Config ID',
      description: 'Imports a saved configuration online from DCSC by its 10-character Configuration ID.',
      inputSchema: {
        configId: z.string().describe('The 10-character online Lenovo DCSC Configuration ID.'),
        workspace: z.string().optional().describe('Optional existing workspace ID to import into.'),
        expectedRevision: z.number().int().min(1).optional().describe('Fails if workspace moved on.'),
        solutionMode: z.string().optional().describe('Solution mode to import under (e.g. "General Purpose").'),
        mode: z.enum(CONFIG_MODES).optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const res = await service.retrieveConfigId(args.configId, {
          workspaceId: args.workspace,
          expectedRevision: args.expectedRevision,
          solutionMode: args.solutionMode,
          mode: args.mode,
          ctx,
        });

        const { missingParts, removedParts, replacedParts, eccnRestricted } = res.diagnostics;
        const lostParts = missingParts.length + removedParts.length;

        return {
          workspace: res.workspaceId,
          importedConfigurations: res.sessions.length,
          ...(res.standaloneKind ? { standaloneKind: res.standaloneKind } : {}),
          warnings: res.diagnostics.warnings ?? [],
          sessions: res.sessions.map((s) => ({
            id: s.id,
            productCode: s.product.code,
            description: s.product.description,
            quantity: s.raw.quantity ?? 1,
            totalPrice: configurationListPrice(s.raw),
            priceAvailable: configurationListPrice(s.raw) !== null,
          })),
          missingParts,
          removedParts,
          replacedParts,
          eccnRestricted,
          ...(lostParts > 0
            ? {
                warning:
                  `DCSC could not carry ${lostParts} part(s) across the import. ` +
                  'The imported configuration is incomplete and its price is not comparable ' +
                  'to the original.',
              }
            : {}),
        };
      }, 'dcsc_import_config_id failed'),
  );

  server.registerTool(
    'dcsc_query_sids',
    {
      title: 'Query preconfigured solution templates (SIDs)',
      description: 'Queries preconfigured solution ID (SID) templates by category with pagination.',
      inputSchema: {
        categoryId: z.string().describe('Product category ID to query SIDs for.'),
        pageIndex: z.number().int().min(1).optional().default(1).describe('1-based page index.'),
        pageSize: z.number().int().min(1).max(100).optional().default(10).describe('Page size (1-100).'),
        sidNumber: z.string().optional().describe('Optional SID number to filter by.'),
        tceFlag: z.boolean().optional().describe('Optional TCE flag filter.'),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const result = await service.querySids(
          {
            categoryId: args.categoryId,
            pageIndex: args.pageIndex,
            pageSize: args.pageSize,
            sidNumber: args.sidNumber,
            tceFlag: args.tceFlag,
          },
          ctx,
        );
        return {
          categoryId: args.categoryId,
          pageIndex: result.number,
          totalElements: result.totalElements,
          returned: result.content.length,
          content: result.content,
        };
      }, 'dcsc_query_sids failed'),
  );
}
