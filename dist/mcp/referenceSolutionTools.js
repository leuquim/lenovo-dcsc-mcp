import { z } from 'zod';
import { referenceRows } from '../domain/referenceSolutions.js';
import { projectCatalogPage } from '../model/catalogPage.js';
import { guard } from './toolSupport.js';
export function registerReferenceSolutionTools(server, service) {
    server.registerTool('dcsc_reference_solutions', {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        title: 'Browse Lenovo reference solutions',
        description: 'Lists the Deployment-Ready or TruScale reference solution catalog (categories, category, solutions, popular, validation). Follow returned continuations unchanged.',
        inputSchema: {
            view: z.enum(['categories', 'category', 'solutions', 'popular', 'validation']).default('categories'),
            catalog: z.enum(['deployment-ready', 'truscale']).default('deployment-ready'),
            categoryId: z.string().max(160).optional(), crnId: z.string().max(160).optional(),
            solutionMode: z.string().optional(),
            offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(15),
            path: z.array(z.string()).optional(), expectedCatalogFingerprint: z.string().optional(),
        },
    }, async (args) => guard(async () => {
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
}
//# sourceMappingURL=referenceSolutionTools.js.map