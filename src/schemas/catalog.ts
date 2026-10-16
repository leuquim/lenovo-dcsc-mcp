import { z } from 'zod';

/**
 * Schemas are lenient by default: every object is `.passthrough()` and only
 * the fields we actually consume are required. DCSC adds fields on a weekly
 * cadence and that must never break a user. The contract-test suite re-parses
 * the same fixtures in strict mode, where the goal is *detection*.
 */

/** Accepts a known member, but lets unknown ones through as opaque strings. */
export const openEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.union([z.enum(values), z.string()]);

export const ProductSchema = z
  .object({
    /** The code passed to /ctos/{code}/launch, e.g. "7D73CTO1WW". */
    code: z.string(),
    ctoCode: z.string().nullish(),
    machineType: z.string().nullish(),
    model: z.string().nullish(),
    description: z.string().nullish(),
    type: openEnum(['CTO', 'LFO']).nullish(),
    hardwareType: z.string().nullish(),
    price: z.number().nullish(),
    showPrice: z.boolean().nullish(),
    announceDate: z.string().nullish(),
    withdrawnDate: z.string().nullish(),
    eosDate: z.string().nullish(),
    shipStatus: z.number().nullish(),
    slice: z.string().nullish(),
    isExpress: z.boolean().nullish(),
    eccnRestricted: z.boolean().nullish(),
    lfo: z.boolean().nullish(),
    cto: z.boolean().nullish(),
    rackless: z.boolean().nullish(),
  })
  .passthrough();

export type Product = z.infer<typeof ProductSchema>;

export interface CategoryNode {
  id: string;
  name?: string | null | undefined;
  parent?: string | null | undefined;
  sequence?: number | null | undefined;
  leafNode?: boolean | null | undefined;
  products?: Product[] | null | undefined;
  children?: CategoryNode[] | null | undefined;
}

export const CategoryNodeSchema: z.ZodType<CategoryNode> = z.lazy(() =>
  z
    .object({
      id: z.string(),
      name: z.string().nullish(),
      parent: z.string().nullish(),
      sequence: z.number().nullish(),
      leafNode: z.boolean().nullish(),
      products: z.array(ProductSchema).nullish(),
      children: z.array(CategoryNodeSchema).nullish(),
    })
    .passthrough(),
);

export const CategoryHierarchySchema = z.array(CategoryNodeSchema);

export const SolutionModeSchema = z
  .object({
    /** The human-readable string the API expects for `solutionMode`. */
    mode: z.string(),
    modeDescription: z.string().nullish(),
    systemFunctionList: z.record(z.boolean()).nullish(),
    masterSlices: z.array(z.string()).nullish(),
    description: z.string().nullish(),
  })
  .passthrough();

export const SolutionModesSchema = z.array(SolutionModeSchema);

export const LocaleEntrySchema = z
  .object({
    country: z.string().nullish(),
    countryName: z.string().nullish(),
    geo: z.string().nullish(),
    language: z.string().nullish(),
    currency: z.string().nullish(),
  })
  .passthrough();
