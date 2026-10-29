import { z } from 'zod';
/**
 * Schemas are lenient by default: every object is `.passthrough()` and only
 * the fields we actually consume are required. DCSC adds fields on a weekly
 * cadence and that must never break a user. The contract-test suite re-parses
 * the same fixtures in strict mode, where the goal is *detection*.
 */
/** Accepts a known member, but lets unknown ones through as opaque strings. */
export declare const openEnum: <T extends readonly [string, ...string[]]>(values: T) => z.ZodUnion<[z.ZodEnum<z.Writeable<T>>, z.ZodString]>;
export declare const ProductSchema: z.ZodObject<{
    /** The code passed to /ctos/{code}/launch, e.g. "7D73CTO1WW". */
    code: z.ZodString;
    ctoCode: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    machineType: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    type: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodEnum<[string, string]>, z.ZodString]>>>;
    hardwareType: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    price: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    showPrice: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    announceDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    withdrawnDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    eosDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    shipStatus: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    slice: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    isExpress: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    eccnRestricted: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    lfo: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    cto: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    rackless: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    /** The code passed to /ctos/{code}/launch, e.g. "7D73CTO1WW". */
    code: z.ZodString;
    ctoCode: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    machineType: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    type: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodEnum<[string, string]>, z.ZodString]>>>;
    hardwareType: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    price: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    showPrice: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    announceDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    withdrawnDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    eosDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    shipStatus: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    slice: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    isExpress: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    eccnRestricted: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    lfo: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    cto: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    rackless: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    /** The code passed to /ctos/{code}/launch, e.g. "7D73CTO1WW". */
    code: z.ZodString;
    ctoCode: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    machineType: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    type: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodEnum<[string, string]>, z.ZodString]>>>;
    hardwareType: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    price: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    showPrice: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    announceDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    withdrawnDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    eosDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    shipStatus: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    slice: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    isExpress: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    eccnRestricted: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    lfo: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    cto: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    rackless: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
}, z.ZodTypeAny, "passthrough">>;
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
export declare const CategoryNodeSchema: z.ZodType<CategoryNode>;
export declare const CategoryHierarchySchema: z.ZodArray<z.ZodType<CategoryNode, z.ZodTypeDef, CategoryNode>, "many">;
export declare const SolutionModeSchema: z.ZodObject<{
    /** The human-readable string the API expects for `solutionMode`. */
    mode: z.ZodString;
    modeDescription: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    systemFunctionList: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodBoolean>>>;
    masterSlices: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodString, "many">>>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    /** The human-readable string the API expects for `solutionMode`. */
    mode: z.ZodString;
    modeDescription: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    systemFunctionList: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodBoolean>>>;
    masterSlices: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodString, "many">>>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    /** The human-readable string the API expects for `solutionMode`. */
    mode: z.ZodString;
    modeDescription: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    systemFunctionList: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodBoolean>>>;
    masterSlices: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodString, "many">>>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.ZodTypeAny, "passthrough">>;
export declare const SolutionModesSchema: z.ZodArray<z.ZodObject<{
    /** The human-readable string the API expects for `solutionMode`. */
    mode: z.ZodString;
    modeDescription: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    systemFunctionList: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodBoolean>>>;
    masterSlices: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodString, "many">>>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    /** The human-readable string the API expects for `solutionMode`. */
    mode: z.ZodString;
    modeDescription: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    systemFunctionList: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodBoolean>>>;
    masterSlices: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodString, "many">>>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    /** The human-readable string the API expects for `solutionMode`. */
    mode: z.ZodString;
    modeDescription: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    systemFunctionList: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodBoolean>>>;
    masterSlices: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodString, "many">>>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.ZodTypeAny, "passthrough">>, "many">;
export declare const LocaleEntrySchema: z.ZodObject<{
    country: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    countryName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    geo: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    language: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    currency: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    country: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    countryName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    geo: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    language: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    currency: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    country: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    countryName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    geo: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    language: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    currency: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.ZodTypeAny, "passthrough">>;
