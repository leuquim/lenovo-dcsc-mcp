import { z } from 'zod';
/**
 * Locale is deliberately one cohesive object rather than four independent
 * knobs. A mismatched geo/country pairing is a classic DCSC 500 generator, so
 * the four fields must always travel together and be validated as a unit.
 */
export declare const LocaleSchema: z.ZodObject<{
    country: z.ZodString;
    geo: z.ZodString;
    language: z.ZodString;
    currency: z.ZodString;
}, z.core.$strip>;
export type Locale = z.infer<typeof LocaleSchema>;
/** The solution context that pairs with a locale on nearly every call. */
export declare const SolutionContextSchema: z.ZodObject<{
    solutionMode: z.ZodString;
    masterSlices: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export type SolutionContext = z.infer<typeof SolutionContextSchema>;
export declare const ConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    host: z.ZodDefault<z.ZodEnum<{
        "cn-dcsc.lenovo.com": "cn-dcsc.lenovo.com";
        "dcsc-api.lenovo.com": "dcsc-api.lenovo.com";
        "dcsc.lenovo.com": "dcsc.lenovo.com";
        "emea-dcsc.lenovo.com": "emea-dcsc.lenovo.com";
        "us-dcsc-api.lenovo.com": "us-dcsc-api.lenovo.com";
        "us-dcsc.lenovo.com": "us-dcsc.lenovo.com";
    }>>;
    locale: z.ZodDefault<z.ZodObject<{
        country: z.ZodString;
        geo: z.ZodString;
        language: z.ZodString;
        currency: z.ZodString;
    }, z.core.$strip>>;
    localeStrict: z.ZodDefault<z.ZodBoolean>;
    transport: z.ZodDefault<z.ZodEnum<{
        official: "official";
        "reverse-engineered": "reverse-engineered";
    }>>;
    credentials: z.ZodDefault<z.ZodNull>;
    pacing: z.ZodPrefault<z.ZodObject<{
        maxConcurrency: z.ZodDefault<z.ZodNumber>;
        exportConcurrency: z.ZodDefault<z.ZodNumber>;
        bucketCapacity: z.ZodDefault<z.ZodNumber>;
        refillPerSec: z.ZodDefault<z.ZodNumber>;
        perToolRequestBudget: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    timeouts: z.ZodPrefault<z.ZodObject<{
        fastMs: z.ZodDefault<z.ZodNumber>;
        interactiveMs: z.ZodDefault<z.ZodNumber>;
        heavyMs: z.ZodDefault<z.ZodNumber>;
        exportMs: z.ZodDefault<z.ZodNumber>;
        streamBodyMs: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    retry: z.ZodPrefault<z.ZodObject<{
        maxAttempts: z.ZodDefault<z.ZodNumber>;
        baseDelayMs: z.ZodDefault<z.ZodNumber>;
        factor: z.ZodDefault<z.ZodNumber>;
        maxDelayMs: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    breaker: z.ZodPrefault<z.ZodObject<{
        windowSize: z.ZodDefault<z.ZodNumber>;
        windowMs: z.ZodDefault<z.ZodNumber>;
        minSamples: z.ZodDefault<z.ZodNumber>;
        failureRatio: z.ZodDefault<z.ZodNumber>;
        consecutive5xxTrip: z.ZodDefault<z.ZodNumber>;
        openMs: z.ZodDefault<z.ZodNumber>;
        halfOpenSuccesses: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    waf: z.ZodPrefault<z.ZodObject<{
        ladderMs: z.ZodDefault<z.ZodArray<z.ZodNumber>>;
        decayAfterSuccesses: z.ZodDefault<z.ZodNumber>;
        resetAfterMs: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    files: z.ZodPrefault<z.ZodObject<{
        artifactDir: z.ZodOptional<z.ZodString>;
        artifactTtlDays: z.ZodDefault<z.ZodNumber>;
        maxDownloadBytes: z.ZodDefault<z.ZodNumber>;
        maxUnzipBytes: z.ZodDefault<z.ZodNumber>;
        maxUnzipEntries: z.ZodDefault<z.ZodNumber>;
        maxCompressionRatio: z.ZodDefault<z.ZodNumber>;
        exportEncoding: z.ZodDefault<z.ZodEnum<{
            multipart: "multipart";
            urlencoded: "urlencoded";
        }>>;
        persistSessions: z.ZodDefault<z.ZodBoolean>;
        sessionFile: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    schemaMode: z.ZodDefault<z.ZodEnum<{
        lenient: "lenient";
        strict: "strict";
    }>>;
    logLevel: z.ZodDefault<z.ZodEnum<{
        debug: "debug";
        error: "error";
        info: "info";
        silent: "silent";
        trace: "trace";
        warn: "warn";
    }>>;
    logRawErrors: z.ZodDefault<z.ZodBoolean>;
    probe: z.ZodDefault<z.ZodBoolean>;
    record: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type Config = z.infer<typeof ConfigSchema>;
/** Masks anything sensitive before config is logged or returned to clients. */
export declare function redactConfig(config: Config): Record<string, unknown>;
