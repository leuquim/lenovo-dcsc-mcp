import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchAiRecommendation } from '../domain/aiConfigurator.js';
import { fetchCategoryDetail, fetchLfoCodes } from '../domain/specialtyCatalog.js';
import { queryDiscoveryHelper } from '../domain/discoveryHelpers.js';
import { fetchServicePortalCategories } from '../domain/services-catalog.js';
import { fetchLocales } from '../domain/locale.js';
import { z } from 'zod';

import { BLUEPRINTS, findBlueprint } from '../domain/blueprints.js';
import { browseCatalog, searchCatalogPage } from '../domain/catalog.js';
import {
  fetchConvergedCategoryDetail,
  fetchConvergedCatalog,
  fetchLvrCatalog,
  fetchSpecialtyCatalog,
} from '../domain/specialtyCatalog.js';
import {
  fetchUpstreamFeatureDetails,
  summarizeFeatureSpec,
} from '../domain/featureDetails.js';
import {
  fetchSmartLfoRecommendation,
  fetchSubTabRecommendations,
  fetchSummaryRecommendations,
  type SummaryRecommendationPayload,
} from '../domain/recommendations.js';
import { projectCatalogBrowsePage } from '../model/catalogBrowsePage.js';
import { projectCatalogPage } from '../model/catalogPage.js';
import { projectSummary } from '../model/project.js';
import type { DcscService } from './service.js';
import { guard, withToolSupport } from './toolSupport.js';

export function registerCatalogTools(rawServer: McpServer, service: DcscService): void {
  const server = withToolSupport(rawServer);

  server.registerTool(
    'dcsc_solution_modes',
    {
      title: 'List DCSC solution modes',
      description:
        'Lists available DCSC solution modes, their website labels, master slices and mode-specific website functions. Pass the exact mode into catalog and launch tools.',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const ctx = service.newCtx();
        const modes = await service.solutionModes(ctx);
        return { modes };
      }, 'dcsc_solution_modes failed'),
  );

  server.registerTool(
    'dcsc_find_products',
    {
      title: 'Search the DCSC product catalog',
      description:
        'Searches the Lenovo DCSC catalog for configurable products by name, model or product code (e.g. "SR630 V3" -> "7D73CTO1WW") for dcsc_launch. Prefer this over dcsc_browse_catalog.',
      inputSchema: {
        query: z.string().describe('Product name, model or code, e.g. "SR630 V3" or "7D73CTO1WW".'),
        type: z
          .enum(['CTO', 'LFO'])
          .optional()
          .describe('CTO = configure-to-order (built by Lenovo). LFO = preconfigured model.'),
        includeWithdrawn: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(50).optional().default(15),
        offset: z.number().int().min(0).optional().default(0),
        solutionMode: z.string().optional(),
        path: z.array(z.string()).optional().describe('Lossless detail path from a returned continuation.'),
        expectedCatalogFingerprint: z.string().optional().describe('Returned continuation fingerprint; rejects changed catalog or context.'),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const solution = await service.resolveSolution(ctx, args.solutionMode);
        const catalog = await service.catalog(ctx, solution);
        const page = searchCatalogPage(catalog, {
          query: args.query,
          ...(args.type !== undefined ? { type: args.type } : {}),
          includeWithdrawn: args.includeWithdrawn,
          limit: Math.max(catalog.entries.length, 1),
          offset: 0,
        });
        const hits = page.items;
        const availability = await service.modesContaining(
          ctx,
          hits.map((h) => h.code),
        );

        return projectCatalogPage({
          tool: 'dcsc_find_products', collection: 'products', context: ctx.locale,
          arguments: { query: args.query, type: args.type, includeWithdrawn: args.includeWithdrawn,
            solutionMode: solution.solutionMode },
          offset: args.offset, limit: args.limit, path: args.path,
          expectedCatalogFingerprint: args.expectedCatalogFingerprint,
          items: hits.map((h) => {
            const modes = availability.get(h.code.toUpperCase()) ?? [];
            return {
              code: h.code,
              type: h.type,
              description: h.description,
              path: h.path.join(' > '),
              ...(h.price !== undefined ? { listPrice: h.price } : {}),
              ...(h.withdrawn ? { withdrawn: true } : {}),
              availableIn: modes,
            };
          }),
          base: { solutionMode: solution.solutionMode, currency: ctx.locale.currency, country: ctx.locale.country,
            total: page.total, page: { total: page.total },
            action: 'dcsc_launch(productCode) to start configuring one of these.' },
        });
      }, 'dcsc_find_products failed'),
  );

  server.registerTool(
    'dcsc_browse_catalog',
    {
      title: 'Browse the DCSC catalog tree',
      description:
        'Walks one level of the DCSC category tree. Use dcsc_find_products when searching for a specific product. Follow returned continuations unchanged.',
      inputSchema: {
        path: z
          .array(z.string())
          .optional()
          .describe('Category breadcrumb, e.g. ["Servers", "Rack Server"]. Omit for the top level.'),
        offset: z.number().int().min(0).optional().default(0),
        categoryOffset: z.number().int().min(0).optional().default(0).describe('Category cursor returned by a continuation; pass it unchanged.'),
        limit: z.number().int().min(1).max(50).optional().default(25),
        includeWithdrawn: z.boolean().optional().default(false),
        solutionMode: z.string().optional(),
        detailPath: z.array(z.string()).optional().describe('Lossless detail path returned for an oversized category or product.'),
        expectedCatalogFingerprint: z.string().optional().describe('Returned continuation fingerprint; rejects changed catalog, breadcrumb or locale context.'),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const solution = await service.resolveSolution(ctx, args.solutionMode);
        const catalog = await service.catalog(ctx, solution);
        const result = browseCatalog(catalog, args.path ?? [], {
          offset: 0, limit: Math.max(catalog.entries.length, 1), includeWithdrawn: args.includeWithdrawn,
        });
        return projectCatalogBrowsePage({
          tool: 'dcsc_browse_catalog', context: ctx.locale, path: result.path,
          arguments: { path: result.path, solutionMode: solution.solutionMode,
            includeWithdrawn: args.includeWithdrawn },
          categories: result.children,
          products: result.products.map((p) => ({
            code: p.code,
            type: p.type,
            description: p.description,
          })),
          categoryOffset: args.categoryOffset, productOffset: args.offset, limit: args.limit,
          detailPath: args.detailPath,
          expectedCatalogFingerprint: args.expectedCatalogFingerprint,
        });
      }, 'dcsc_browse_catalog failed'),
  );

  server.registerTool(
    'dcsc_list_locales',
    {
      title: 'List DCSC countries, languages and currencies',
      description:
        'Returns the country/region catalogue from DCSC /locales. Pass a country code into dcsc_set_locale.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Optional filter on country name or code, e.g. "Germany" or "DE".'),
        limit: z.number().int().min(1).max(50).optional().default(20),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        let locales = await fetchLocales(service.http, ctx);
        locales = locales.filter((l) => !l.countryInvalid);
        if (args.query) {
          const q = args.query.toLowerCase();
          locales = locales.filter(
            (l) =>
              l.countryCode.toLowerCase().includes(q) ||
              l.countryName.toLowerCase().includes(q) ||
              l.currency.toLowerCase().includes(q),
          );
        }
        const limit = args.limit ?? 20;
        return {
          count: locales.length,
          locales: locales.slice(0, limit).map((l) => ({
            country: l.countryCode,
            name: l.countryName,
            currency: l.currency,
            geo: l.region,
            languages: l.languages.map((x) => x.languageCode),
            defaultLanguage: l.languages.find((x) => x.defaulted)?.languageCode ?? l.languages[0]?.languageCode,
          })),
          current: service.locale,
          next: 'dcsc_set_locale(country: "DE") then dcsc_launch — new sessions use the chosen locale.',
        };
      }, 'dcsc_list_locales failed'),
  );

  server.registerTool(
    'dcsc_set_locale',
    {
      title: 'Set country / language / currency for subsequent DCSC calls',
      description:
        'Resolves a country against DCSC /locales and sets the process default locale for subsequent launches and searches. Existing workspaces retain their own locales.',
      inputSchema: {
        country: z.string().describe('ISO country code from dcsc_list_locales, e.g. "US", "DE", "GB".'),
        language: z.string().optional().describe('Optional language code; defaults to the country default.'),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const locale = await service.resolveLocale(ctx, args.country, args.language);
        service.setLocale(locale);
        return {
          locale,
          scope: 'process-default',
          persisted: false,
          priceType: 'LIST',
          note:
            'Subsequent launches and catalog searches use this locale. ' +
            'Prices are anonymous LIST prices for the configured country/currency, not a quote.',
          next: 'dcsc_launch or dcsc_find_products under the new locale.',
        };
      }, 'dcsc_set_locale failed'),
  );

  server.registerTool(
    'dcsc_service_categories',
    {
      title: 'List Services portal categories (anonymous)',
      description:
        'Lists the top of the Lenovo Services portal category tree. Use dcsc_list_options(session, tab: "Services") for attached warranty packages, or dcsc_services_launch for independent product-bound services.',
      inputSchema: {
        solutionMode: z.string().optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const solution = await service.resolveSolution(ctx, args.solutionMode);
        const root = await fetchServicePortalCategories(service.http, { ...ctx, solution });
        if (!root) {
          return {
            categories: [],
            warning: 'DCSC returned no services portal categories for this locale/mode.',
          };
        }
        return {
          root: { id: root.id, title: root.title },
          categories: root.children.map((c) => ({
            id: c.id,
            title: c.title,
            description: c.description,
            childCount: c.children.length,
            children: c.children.slice(0, 12).map((ch) => ({
              id: ch.id,
              title: ch.title,
              childCount: ch.children.length,
            })),
          })),
          note:
            'Portal catalogue only. Product Services tab: dcsc_list_options(session, tab: "Services"). ' +
            'Use dcsc_services_launch to choose independent product-bound services, or dcsc_configure to change an attached warranty package.',
          next: 'dcsc_launch then dcsc_list_options(session, tab: "Services") or query: "warranty".',
        };
      }, 'dcsc_service_categories failed'),
  );

  server.registerTool(
    'dcsc_blueprints',
    {
      title: 'List AI factory starting points and current availability',
      description: 'Lists curated AI factory starting points with current catalog availability by solution mode.',
      inputSchema: {},
    },
    async () =>
      guard(async () => ({
        blueprints: await service.blueprintAvailability(service.newCtx()),
        priceType: 'LIST',
        note:
          'Prices were verified on the stated date for US/USD and will drift. ' +
          'dcsc_start_from_blueprint(id) launches one and returns live pricing.',
        readBeforeQuoting:
          'Every blueprint launches as a partial node — check shipsWithout. The launch price ' +
          'covers the GPU baseboard, CPUs and memory, but none of these models include a boot ' +
          'device, local storage or fabric adapters, so a launched node is not yet a usable one.',
      }), 'dcsc_blueprints failed'),
  );

  server.registerTool(
    'dcsc_start_from_blueprint',
    {
      title: 'Start a currently available blueprint',
      description:
        'Launches one of the reference AI factory configurations in the appropriate solution mode.',
      inputSchema: {
        blueprint: z.string().describe('Blueprint id or product code from dcsc_blueprints.'),
        label: z.string().optional(),
        solutionMode: z.string().optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const blueprint = findBlueprint(args.blueprint);
        if (!blueprint) {
          throw new Error(
            `Unknown blueprint "${args.blueprint}". Valid ids: ${BLUEPRINTS.map((b) => b.id).join(', ')}.`,
          );
        }
        const ctx = service.newCtx();
        const availability = (await service.blueprintAvailability(ctx)).find(item => item.id === blueprint.id)!;
        if (!availability.available) throw new Error(`Blueprint ${blueprint.id} (${blueprint.productCode}) is absent from the current catalogs for this locale. Use dcsc_blueprints for available alternatives.`);
        const requestedMode = args.solutionMode ?? (availability.availableModes.includes(blueprint.solutionMode) ? blueprint.solutionMode : availability.availableModes[0]);
        const solution = await service.resolveSolution(ctx, requestedMode);
        if (!availability.availableModes.includes(solution.solutionMode)) throw new Error(`Blueprint ${blueprint.id} is not available in ${solution.solutionMode}. Available modes: ${availability.availableModes.join(', ')}.`);
        const session = await service.launch({
          productCode: blueprint.productCode,
          mode: 'cto',
          solution,
          ctx,
          ...(args.label !== undefined ? { label: args.label } : {}),
        });
        return {
          blueprint: blueprint.id,
          workspace: session.workspaceId,
          solutionMode: solution.solutionMode,
          ...projectSummary({
            sessionId: session.id,
            revision: session.revision,
            raw: session.raw,
            index: session.index,
            currency: session.locale.currency,
            country: session.locale.country,
            pricedAt: session.pricedAt,
          }),
          shipsWithout: blueprint.shipsWithout,
          incompleteWarning:
            `This node is NOT yet usable as launched. It ships without: ${blueprint.shipsWithout.join('; ')}. ` +
            'Add them with dcsc_configure before pricing or quoting it.',
          next: 'dcsc_list_options(session, tab: "Storage" | "PCI") to fill the gaps above, then dcsc_scale_out to size a cluster.',
        };
      }, 'dcsc_start_from_blueprint failed'),
  );

  server.registerTool(
    'dcsc_specialty_catalog',
    {
      title: 'Browse specialty catalogs (LVR refurbished, Converged/MultiProd, Promotions)',
      description:
        'Discovers products in Lenovo DCSC specialty catalogs: LVR (Certified Refurbished), Converged (ThinkAgile multi-product systems), and Promotions (hierarchies, promotional SIDs, promotional LFOs).',
      inputSchema: {
        catalog: z
          .enum(['lvr', 'converged', 'promotion'])
          .default('lvr')
          .describe('Specialty catalog type: lvr (refurbished), converged (ThinkAgile), or promotion.'),
        subType: z
          .enum(['hierarchies', 'sid', 'lfo', 'option'])
          .optional()
          .describe('For promotion catalog: hierarchies, sid (promotional SIDs), lfo, or option.'),
        categoryId: z
          .string()
          .optional()
          .describe('Category ID for converged category detail or promotion option filter.'),
        query: z
          .string()
          .optional()
          .describe('Optional search query over LVR or converged catalog entries.'),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(50).optional().default(15),
        solutionMode: z.string().optional(),
      },
      annotations: {
        title: 'Browse specialty catalogs (LVR refurbished, Converged/MultiProd, Promotions)',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const solution = await service.resolveSolution(ctx, args.solutionMode);
        const resolvedCtx = { ...ctx, solution };

        if (args.catalog === 'lvr') {
          const catalog = await fetchLvrCatalog(service.http, resolvedCtx);
          if (args.query) {
            const page = searchCatalogPage(catalog, {
              query: args.query,
              offset: args.offset,
              limit: args.limit,
            });
            return {
              catalog: 'lvr',
              total: page.total,
              offset: page.offset,
              limit: page.limit,
              entries: page.items,
            };
          }
          const offset = args.offset ?? 0;
          const limit = args.limit ?? 15;
          return {
            catalog: 'lvr',
            total: catalog.entries.length,
            offset,
            limit,
            entries: catalog.entries.slice(offset, offset + limit),
          };
        }

        if (args.catalog === 'converged') {
          if (args.categoryId) {
            const detail = await fetchConvergedCategoryDetail(
              service.http,
              resolvedCtx,
              args.categoryId,
            );
            return {
              catalog: 'converged',
              categoryId: args.categoryId,
              detail,
            };
          }
          const catalog = await fetchConvergedCatalog(service.http, resolvedCtx);
          if (args.query) {
            const page = searchCatalogPage(catalog, {
              query: args.query,
              offset: args.offset,
              limit: args.limit,
            });
            return {
              catalog: 'converged',
              total: page.total,
              offset: page.offset,
              limit: page.limit,
              entries: page.items,
            };
          }
          const offset = args.offset ?? 0;
          const limit = args.limit ?? 15;
          return {
            catalog: 'converged',
            total: catalog.entries.length,
            offset,
            limit,
            entries: catalog.entries.slice(offset, offset + limit),
          };
        }

        const promo = await fetchSpecialtyCatalog(service.http, resolvedCtx, {
          type: 'promotion',
          subType: args.subType,
          categoryId: args.categoryId,
        });
        return {
          catalog: 'promotion',
          subType: promo.type === 'promotion' ? promo.subType : 'hierarchies',
          data: (promo as { data: unknown }).data,
        };
      }, 'dcsc_specialty_catalog failed'),
  );

  server.registerTool(
    'dcsc_subtab_recommendations',
    {
      title: 'Get smart recommendations and rules for configuration sub-tabs',
      description:
        'Returns context-aware recommendations, transition guides, and rule warnings for a model’s configuration tabs (e.g. Microsoft ROK OS, Storage bundle constraints).',
      inputSchema: {
        session: z
          .string()
          .optional()
          .describe('Session or workspace ID to inspect productCode from.'),
        productCode: z
          .string()
          .optional()
          .describe('CTO product code (e.g. "7D73CTO1WW") if no session.'),
        mode: z
          .string()
          .optional()
          .default('CTO')
          .describe('Configuration mode, e.g. CTO.'),
        solutionMode: z.string().optional(),
      },
      annotations: {
        title: 'Get smart recommendations and rules for configuration sub-tabs',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      guard(async () => {
        let code = args.productCode?.trim();
        if (!code && args.session) {
          const session = service.sessions.get(args.session);
          if (session && typeof session.raw.code === 'string') {
            code = session.raw.code;
          }
        }
        if (!code) {
          throw new Error('Provide either a valid productCode or an active session.');
        }

        const ctx = service.newCtx();
        const solution = await service.resolveSolution(ctx, args.solutionMode);
        const recommendations = await fetchSubTabRecommendations(
          service.http,
          { ...ctx, solution },
          args.mode ?? 'CTO',
          code,
        );

        return {
          productCode: code,
          count: recommendations.length,
          recommendations,
        };
      }, 'dcsc_subtab_recommendations failed'),
  );

  server.registerTool(
    'dcsc_feature_details',
    {
      title: 'Get rich upstream spec details for feature codes',
      description:
        'Queries Lenovo DCSC upstream for rich feature specifications, including shipping lead times (shippingStatus), lifecycle dates (announceDate, withdrawnDate), commercial recommendations (topChoice, recommendedFeature), marketing tags, and price breakdown.',
      inputSchema: {
        session: z
          .string()
          .optional()
          .describe('Optional session or workspace ID to resolve CTO code and session context.'),
        ctoCode: z
          .string()
          .optional()
          .describe('CTO product code (e.g. "7D73CTO1WW").'),
        codes: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe('List of feature/option codes to query (1-20).'),
        solutionMode: z.string().optional(),
      },
      annotations: {
        title: 'Get rich upstream spec details for feature codes',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      guard(async () => {
        let cto = args.ctoCode?.trim();
        let sessionId = args.session ?? 'anon';
        if (args.session) {
          const session = service.sessions.get(args.session);
          if (session) {
            if (!cto && typeof session.raw.code === 'string') {
              cto = session.raw.code;
            }
            sessionId = session.id;
          }
        }
        if (!cto) {
          throw new Error('Provide either ctoCode or an active session.');
        }

        const ctx = service.newCtx();
        const solution = await service.resolveSolution(ctx, args.solutionMode);
        const rawFeatures = await fetchUpstreamFeatureDetails(
          service.http,
          { ...ctx, solution },
          cto,
          sessionId,
          args.codes,
        );
        const specs = rawFeatures.map(summarizeFeatureSpec);

        return {
          ctoCode: cto,
          count: specs.length,
          features: specs,
        };
      }, 'dcsc_feature_details failed'),
  );

  server.registerTool(
    'dcsc_smart_recommendations',
    {
      title: 'Get summary cross-sell and smart LFO top choice recommendations',
      description:
        'Queries Lenovo DCSC for cross-sell/summary attach recommendations or smart LFO top-choice preconfigured alternatives.',
      inputSchema: {
        type: z
          .enum(['summary', 'smart-lfo'])
          .default('summary')
          .describe('Type of smart recommendation: summary (cross-sell attach) or smart-lfo (top-choice models).'),
        session: z.string().optional().describe('Session or workspace ID.'),
        ctoCode: z.string().optional().describe('CTO product code.'),
        country: z.string().optional().describe('2-letter ISO country code for smart-lfo recommendations.'),
        solutionMode: z.string().optional(),
      },
      annotations: {
        title: 'Get summary cross-sell and smart LFO top choice recommendations',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const solution = await service.resolveSolution(ctx, args.solutionMode);
        const resolvedCtx = { ...ctx, solution };

        if (args.type === 'smart-lfo') {
          const country = (args.country ?? ctx.locale.country ?? 'US').toUpperCase();
          let cto = args.ctoCode?.trim();
          if (!cto && args.session) {
            const session = service.sessions.get(args.session);
            if (session && typeof session.raw.code === 'string') {
              cto = session.raw.code;
            }
          }
          if (!cto) {
            throw new Error('Provide either ctoCode or an active session for smart LFO recommendations.');
          }

          const result = await fetchSmartLfoRecommendation(
            service.http,
            resolvedCtx,
            country,
            cto,
          );
          return {
            type: 'smart-lfo',
            country,
            ctoCode: cto,
            result,
          };
        }

        let cto = args.ctoCode?.trim();
        let payload: SummaryRecommendationPayload = {
          selectedProductDataLists: [],
        };

        if (args.session) {
          const session = service.sessions.get(args.session);
          if (session) {
            if (!cto && typeof session.raw.code === 'string') {
              cto = session.raw.code;
            }
            const features: Array<{ code: string; quantity?: number }> = [];
            for (const tab of session.raw.tabs ?? []) {
              for (const subTab of tab.subTabs ?? []) {
                for (const sec of subTab.sections ?? []) {
                  for (const res of sec.results ?? []) {
                    if (res.code) {
                      features.push({ code: res.code, quantity: res.quantity ?? 1 });
                    }
                  }
                }
              }
            }
            payload = {
              selectedProductDataLists: [
                [
                  {
                    code: cto ?? 'CTO',
                    id: session.id,
                    quantity: session.raw.quantity ?? 1,
                    features,
                  },
                ],
              ],
            };
          }
        } else if (cto) {
          payload = {
            selectedProductDataLists: [[{ code: cto, quantity: 1 }]],
          };
        }

        const result = await fetchSummaryRecommendations(
          service.http,
          resolvedCtx,
          payload,
        );

        return {
          type: 'summary',
          ctoCode: cto,
          result,
        };
      }, 'dcsc_smart_recommendations failed'),
    );

  server.registerTool(
    'dcsc_category_detail',
    {
      title: 'Fetch sub-category detail & configurable products',
      description: 'Fetches sub-category detail, products, paths, or queries anonymous discovery helpers.',
      inputSchema: {
        categoryId: z.string().optional().describe('Category identifier, e.g. "STG@Servers@Rack Server". Optional if discoveryAction is provided.'),
        isTruScale: z.boolean().optional().describe('Set true to force TruScale reference solution category detail routing.'),
        discoveryAction: z.enum([
          'caseStudies',
          'subCategoryConditions',
          'productListBySubCategory',
          'topChoiceCountry',
          'productFunctions',
          'displayOrders',
          'staticFeatures',
        ]).optional().describe('Anonymous discovery helper route to query.'),
        discoveryParams: z.record(z.string(), z.unknown()).optional().describe('Parameters for the discovery action.'),
        limit: z.number().int().min(1).max(50).optional().describe('Optional maximum sub-categories/children to return.'),
      },
    },
    async (args) =>
      guard(async () => {
        if (args.discoveryAction) {
          return queryDiscoveryHelper(service.http, await service.ctxEnsuringSolution(), {
            action: args.discoveryAction,
            params: args.discoveryParams,
          });
        }
        if (!args.categoryId) {
          throw new Error('Either categoryId or discoveryAction must be provided for dcsc_category_detail.');
        }
        const result = await fetchCategoryDetail(service.http, await service.ctxWithSolution(), { categoryId: args.categoryId, isTruScale: args.isTruScale });
        if (args.limit !== undefined) {
          return {
            ...result,
            ...(Array.isArray(result.children) ? { children: result.children.slice(0, args.limit), totalChildren: result.children.length } : {}),
            ...(Array.isArray(result.products) ? { products: result.products.slice(0, args.limit), totalProducts: result.products.length } : {}),
            ...(Array.isArray(result.categories) ? { categories: result.categories.slice(0, args.limit), totalCategories: result.categories.length } : {}),
          };
        }
        return result;
      }, 'dcsc_category_detail failed'),
  );

  server.registerTool(
    'dcsc_cto_lfo_codes',
    {
      title: 'List filtered CTO and LFO codes',
      description: 'Fetches filtered list of CTO and LFO product codes from upstream catalog filter endpoint.',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe('Optional maximum codes to return.'),
      },
    },
    async (args) =>
      guard(async () => {
        const result = await fetchLfoCodes(service.http, await service.ctxWithSolution());
        if (args.limit !== undefined) {
          return {
            ...result,
            lfoCodes: result.lfoCodes.slice(0, args.limit),
            totalLfoCodes: result.lfoCodes.length,
          };
        }
        return result;
      }, 'dcsc_cto_lfo_codes failed'),
  );

  server.registerTool(
    'dcsc_ai_recommend',
    {
      title: 'Nightingale AI configurator recommendations & feature validation',
      description: 'Executes Nightingale AI recommendation or feature compatibility validation via /ai-acceler endpoints.',
      inputSchema: {
        action: z
          .enum([
            'ctoCandidates',
            'featureCompat',
            'bladeRecommendation',
            'defaultPrompt',
            'promptTemplate',
            'candidateAttributes',
            'candidateFeatures',
            'candidateFeaturesDesc',
            'configReplenishment',
            'replaceFeatures',
            'recommendConfigs',
            'recommendServices',
          ])
          .describe('AI action type.'),
        payload: z.record(z.string(), z.unknown()).describe('Payload object required by the specific AI endpoint.'),
      },
    },
    async (args) =>
      guard(async () => {
        return fetchAiRecommendation(service.http, await service.ctxWithSolution(), { action: args.action, payload: args.payload });
      }, 'dcsc_ai_recommend failed'),
  );
}
