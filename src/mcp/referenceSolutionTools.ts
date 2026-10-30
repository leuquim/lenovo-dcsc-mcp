import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { referenceRows } from '../domain/referenceSolutions.js';
import { toToolError } from '../http/errors.js';
import { projectCatalogPage } from '../model/catalogPage.js';
import type { DcscService } from './service.js';

export function registerReferenceSolutionTools(server: McpServer, service: DcscService): void {
  server.registerTool('dcsc_download_reference_solution', {
    title: 'Download the original Lenovo reference-template XML',
    description: 'Checks current native download eligibility, then saves Lenovo’s original template bytes as a local XML artifact. This does not customize or re-export the design. Invalid templates must use dcsc_launch_reference_solution for review. Returns the file path, byte count and SHA-256; use dcsc_import to open it.',
    inputSchema: { crnId: z.string().max(160), solutionMode: z.string().optional() },
  }, async args => {
    try {
      const artifact = await service.downloadReferenceSolution(args.crnId, service.newCtx(), args.solutionMode);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ crnId: args.crnId, ...artifact,
        next: { tool: 'dcsc_import', arguments: { filePath: artifact.path } } }) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error)) }] };
    }
  });
  server.registerTool('dcsc_reference_solutions', {
    title: 'Browse Lenovo native reference solutions',
    description: 'Discovers the website Deployment-Ready or TruScale reference catalog. categories returns category IDs, breadcrumbs and native SID lists; solutions lists CRNs for a category; category retrieves its full description; popular lists promoted designs; validation checks a CRN for native download eligibility. These are Lenovo templates, separate from local blueprints. Follow fingerprint-bound continuations unchanged. To customize a CRN use dcsc_launch_reference_solution.',
    inputSchema: {
      view: z.enum(['categories', 'category', 'solutions', 'popular', 'validation']).default('categories'),
      catalog: z.enum(['deployment-ready', 'truscale']).default('deployment-ready'),
      categoryId: z.string().max(160).optional(), crnId: z.string().max(160).optional(),
      solutionMode: z.string().optional(),
      offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(15),
      path: z.array(z.string()).optional(), expectedCatalogFingerprint: z.string().optional(),
    },
  }, async args => {
    try {
      if ((args.path !== undefined || args.offset > 0) && !args.expectedCatalogFingerprint) {
        throw new Error('Follow a fingerprint-bound continuation from dcsc_reference_solutions to inspect further pages.');
      }
      const ctx = service.newCtx();
      const { raw, solution } = await service.referenceSolutions(args, ctx, args.solutionMode);
      const items = referenceRows(raw, args.view);
      const result = projectCatalogPage({ tool: 'dcsc_reference_solutions', collection: 'entries',
        context: { locale: ctx.locale, solution },
        arguments: { view: args.view, catalog: args.catalog, categoryId: args.categoryId,
          crnId: args.crnId, solutionMode: solution.solutionMode },
        items, offset: args.offset, limit: args.limit, path: args.path,
        expectedCatalogFingerprint: args.expectedCatalogFingerprint,
        base: { view: args.view, catalog: args.catalog, solutionMode: solution.solutionMode,
          total: items.length, source: 'Lenovo reference-solution API' },
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error)) }] };
    }
  });
  server.registerTool('dcsc_launch_reference_solution', {
    title: 'Customize a native Lenovo reference solution',
    description: 'Loads a catalog CRN/SID through the website Customize endpoint into a new editable workspace. Preserves native configuration, clone, physical layout and commercial state using atomic import. Reports Lenovo missing/removed/replaced parts; creation does not mean the design passes manufacturing validation. Use dcsc_validate before handoff. The caller chooses the solution mode; incompatible imported context is rejected.',
    inputSchema: { crnId: z.string().max(160).describe('Exact crnId or sidNumber from dcsc_reference_solutions.'),
      solutionMode: z.string().optional() },
  }, async args => {
    try {
      const result = await service.launchReferenceSolution(args.crnId, service.newCtx(), args.solutionMode);
      const workspace = service.sessions.getWorkspace(result.workspaceId)!;
      // Complete configuration/diagnostic details remain on the persisted
      // workspace, not a truncated list embedded into this mutation result.
      const response = { crnId: args.crnId, workspace: result.workspaceId, workspaceRevision: workspace.revision,
        importedConfigurations: result.sessions.length, standaloneKind: result.standaloneKind,
        diagnostics: { missingParts: result.diagnostics.missingParts.length,
          removedParts: result.diagnostics.removedParts.length, replacedParts: result.diagnostics.replacedParts.length,
          eccnRestricted: result.diagnostics.eccnRestricted, warningCount: result.diagnostics.warnings?.length ?? 0,
          inspect: { tool: 'dcsc_workspace_layout', arguments: { session: result.workspaceId,
            expectedWorkspaceRevision: workspace.revision, path: ['importDiagnostics'] } } },
        inspect: { tool: 'dcsc_session_info', arguments: { session: result.workspaceId } },
        layout: { tool: 'dcsc_workspace_layout', arguments: { session: result.workspaceId } },
        next: 'Inspect the workspace and import diagnostics, then configure or export it. Run dcsc_validate before manufacturing handoff.' };
      return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error)) }] };
    }
  });
}
