import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { referenceRows } from '../domain/referenceSolutions.js';
import { projectCatalogPage } from '../model/catalogPage.js';
import type { DcscService } from './service.js';
import { guard, withToolSupport } from './toolSupport.js';

export function registerReferenceSolutionTools(rawServer: McpServer, service: DcscService): void {
  const server = withToolSupport(rawServer);
  server.registerTool('dcsc_download_reference_solution', {
    title: 'Download the original Lenovo reference-template XML',
    description: 'Checks native download eligibility and saves Lenovo’s original template bytes as a local XML artifact without customizing or re-exporting. Returns file path, byte count and SHA-256; use dcsc_import to open it.',
    inputSchema: { crnId: z.string().max(160), solutionMode: z.string().optional() },
  }, async args => guard(async () => {
    const artifact = await service.downloadReferenceSolution(args.crnId, service.newCtx(), args.solutionMode);
    return { crnId: args.crnId, ...artifact,
      next: { tool: 'dcsc_import', arguments: { filePath: artifact.path } } };
  }, 'dcsc_download_reference_solution failed'));

  server.registerTool('dcsc_reference_solutions', {
    title: 'Browse Lenovo native reference solutions',
    description: 'Discovers the Deployment-Ready or TruScale reference catalog (categories, category, solutions, popular, validation). Follow fingerprint-bound continuations unchanged. Use dcsc_launch_reference_solution to customize a CRN.',
    inputSchema: {
      view: z.enum(['categories', 'category', 'solutions', 'popular', 'validation']).default('categories'),
      catalog: z.enum(['deployment-ready', 'truscale']).default('deployment-ready'),
      categoryId: z.string().max(160).optional(), crnId: z.string().max(160).optional(),
      solutionMode: z.string().optional(),
      offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(15),
      path: z.array(z.string()).optional(), expectedCatalogFingerprint: z.string().optional(),
    },
  }, async args => guard(async () => {
    if ((args.path !== undefined || args.offset > 0) && !args.expectedCatalogFingerprint) {
      throw new Error('Follow a fingerprint-bound continuation from dcsc_reference_solutions to inspect further pages.');
    }
    const ctx = service.newCtx();
    const { raw, solution } = await service.referenceSolutions(args, ctx, args.solutionMode);
    const items = referenceRows(raw, args.view);
    return projectCatalogPage({ tool: 'dcsc_reference_solutions', collection: 'entries',
      context: { locale: ctx.locale, solution },
      arguments: { view: args.view, catalog: args.catalog, categoryId: args.categoryId,
        crnId: args.crnId, solutionMode: solution.solutionMode },
      items, offset: args.offset, limit: args.limit, path: args.path,
      expectedCatalogFingerprint: args.expectedCatalogFingerprint,
      base: { view: args.view, catalog: args.catalog, solutionMode: solution.solutionMode,
        total: items.length, source: 'Lenovo reference-solution API' },
    });
  }, 'dcsc_reference_solutions failed'));

  server.registerTool('dcsc_launch_reference_solution', {
    title: 'Customize a native Lenovo reference solution',
    description: 'Loads a catalog CRN/SID through the website Customize endpoint into a new editable workspace, preserving configuration, clone, physical layout and commercial state. Reports missing/removed/replaced parts; run dcsc_validate before handoff.',
    inputSchema: { crnId: z.string().max(160).describe('Exact crnId or sidNumber from dcsc_reference_solutions.'),
      solutionMode: z.string().optional() },
  }, async args => guard(async () => {
    const result = await service.launchReferenceSolution(args.crnId, service.newCtx(), args.solutionMode);
    const workspace = service.sessions.getWorkspace(result.workspaceId)!;
    return { crnId: args.crnId, workspace: result.workspaceId, workspaceRevision: workspace.revision,
      importedConfigurations: result.sessions.length, standaloneKind: result.standaloneKind,
      diagnostics: { missingParts: result.diagnostics.missingParts.length,
        removedParts: result.diagnostics.removedParts.length, replacedParts: result.diagnostics.replacedParts.length,
        eccnRestricted: result.diagnostics.eccnRestricted, warningCount: result.diagnostics.warnings?.length ?? 0,
        inspect: { tool: 'dcsc_workspace_layout', arguments: { session: result.workspaceId,
          expectedWorkspaceRevision: workspace.revision, path: ['importDiagnostics'] } } },
      inspect: { tool: 'dcsc_session_info', arguments: { session: result.workspaceId } },
      layout: { tool: 'dcsc_workspace_layout', arguments: { session: result.workspaceId } },
      next: 'Inspect the workspace and import diagnostics, then configure or export it. Run dcsc_validate before manufacturing handoff.' };
  }, 'dcsc_launch_reference_solution failed'));
}
