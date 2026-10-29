import { z } from 'zod';
/**
 * Locale is deliberately one cohesive object rather than four independent
 * knobs. A mismatched geo/country pairing is a classic DCSC 500 generator, so
 * the four fields must always travel together and be validated as a unit.
 */
export declare const LocaleSchema: z.ZodObject<{
    /** Sent as the `country_or_region` query param. ISO-3166 alpha-2. */
    country: z.ZodString;
    /** Sent as `geo`. e.g. NA, EMEA, AP, LA. */
    geo: z.ZodString;
    /** Sent as `language`. ISO-639-1. */
    language: z.ZodString;
    /** Sent as `currency`. ISO-4217. */
    currency: z.ZodString;
}, "strip", z.ZodTypeAny, {
    geo: string;
    language: string;
    currency: string;
    country: string;
}, {
    geo: string;
    language: string;
    currency: string;
    country: string;
}>;
export type Locale = z.infer<typeof LocaleSchema>;
/** The solution context that pairs with a locale on nearly every call. */
export declare const SolutionContextSchema: z.ZodObject<{
    /** Human-readable mode string, e.g. "General Purpose". NOT an enum. */
    solutionMode: z.ZodString;
    /** Comma-joined on the wire. Omitting this returns HTTP 500. */
    masterSlices: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    solutionMode: string;
    masterSlices: string[];
}, {
    solutionMode: string;
    masterSlices: string[];
}>;
export type SolutionContext = z.infer<typeof SolutionContextSchema>;
export declare const ConfigSchema: z.ZodObject<{
    /** Master kill switch. */
    enabled: z.ZodDefault<z.ZodBoolean>;
    host: z.ZodDefault<z.ZodEnum<["dcsc.lenovo.com", "us-dcsc.lenovo.com", "emea-dcsc.lenovo.com", "cn-dcsc.lenovo.com", "dcsc-api.lenovo.com", "us-dcsc-api.lenovo.com"]>>;
    locale: z.ZodDefault<z.ZodObject<{
        /** Sent as the `country_or_region` query param. ISO-3166 alpha-2. */
        country: z.ZodString;
        /** Sent as `geo`. e.g. NA, EMEA, AP, LA. */
        geo: z.ZodString;
        /** Sent as `language`. ISO-639-1. */
        language: z.ZodString;
        /** Sent as `currency`. ISO-4217. */
        currency: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        geo: string;
        language: string;
        currency: string;
        country: string;
    }, {
        geo: string;
        language: string;
        currency: string;
        country: string;
    }>>;
    /** Reject locale combinations not in the known-good table. */
    localeStrict: z.ZodDefault<z.ZodBoolean>;
    transport: z.ZodDefault<z.ZodEnum<["reverse-engineered", "official"]>>;
    /**
     * Reserved. The reverse-engineered transport ignores this entirely. Do not
     * model OAuth/JWT until credentials actually exist.
     */
    credentials: z.ZodDefault<z.ZodNull>;
    pacing: z.ZodDefault<z.ZodObject<{
        /** Global in-flight request cap; also the undici Agent connection cap. */
        maxConcurrency: z.ZodDefault<z.ZodNumber>;
        /** Never two downloads at once. */
        exportConcurrency: z.ZodDefault<z.ZodNumber>;
        /** Token bucket burst capacity. */
        bucketCapacity: z.ZodDefault<z.ZodNumber>;
        /** Token bucket refill rate (~250ms minimum spacing at 4/s). */
        refillPerSec: z.ZodDefault<z.ZodNumber>;
        /**
         * Hard cap on requests issued during a single MCP tool call. This is the
         * guard against a runaway agent loop hammering DCSC, and is worth more than
         * every other resilience control combined.
         */
        perToolRequestBudget: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        maxConcurrency: number;
        exportConcurrency: number;
        bucketCapacity: number;
        refillPerSec: number;
        perToolRequestBudget: number;
    }, {
        maxConcurrency?: number | undefined;
        exportConcurrency?: number | undefined;
        bucketCapacity?: number | undefined;
        refillPerSec?: number | undefined;
        perToolRequestBudget?: number | undefined;
    }>>;
    timeouts: z.ZodDefault<z.ZodObject<{
        /**
         * Spring Boot does not flush headers until the controller returns, so for
         * non-streaming classes headersTimeout must equal the overall budget.
         */
        fastMs: z.ZodDefault<z.ZodNumber>;
        interactiveMs: z.ZodDefault<z.ZodNumber>;
        heavyMs: z.ZodDefault<z.ZodNumber>;
        exportMs: z.ZodDefault<z.ZodNumber>;
        /** Inter-chunk stall timeout, only meaningful for streamed downloads. */
        streamBodyMs: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        fastMs: number;
        interactiveMs: number;
        heavyMs: number;
        exportMs: number;
        streamBodyMs: number;
    }, {
        fastMs?: number | undefined;
        interactiveMs?: number | undefined;
        heavyMs?: number | undefined;
        exportMs?: number | undefined;
        streamBodyMs?: number | undefined;
    }>>;
    retry: z.ZodDefault<z.ZodObject<{
        maxAttempts: z.ZodDefault<z.ZodNumber>;
        baseDelayMs: z.ZodDefault<z.ZodNumber>;
        factor: z.ZodDefault<z.ZodNumber>;
        maxDelayMs: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        maxAttempts: number;
        baseDelayMs: number;
        factor: number;
        maxDelayMs: number;
    }, {
        maxAttempts?: number | undefined;
        baseDelayMs?: number | undefined;
        factor?: number | undefined;
        maxDelayMs?: number | undefined;
    }>>;
    breaker: z.ZodDefault<z.ZodObject<{
        windowSize: z.ZodDefault<z.ZodNumber>;
        windowMs: z.ZodDefault<z.ZodNumber>;
        minSamples: z.ZodDefault<z.ZodNumber>;
        failureRatio: z.ZodDefault<z.ZodNumber>;
        consecutive5xxTrip: z.ZodDefault<z.ZodNumber>;
        openMs: z.ZodDefault<z.ZodNumber>;
        halfOpenSuccesses: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        windowSize: number;
        windowMs: number;
        minSamples: number;
        failureRatio: number;
        consecutive5xxTrip: number;
        openMs: number;
        halfOpenSuccesses: number;
    }, {
        windowSize?: number | undefined;
        windowMs?: number | undefined;
        minSamples?: number | undefined;
        failureRatio?: number | undefined;
        consecutive5xxTrip?: number | undefined;
        openMs?: number | undefined;
        halfOpenSuccesses?: number | undefined;
    }>>;
    waf: z.ZodDefault<z.ZodObject<{
        /** Cooldown ladder in ms, indexed by strike count. Last value repeats. */
        ladderMs: z.ZodDefault<z.ZodArray<z.ZodNumber, "many">>;
        /** Consecutive successes needed to drop one rung. */
        decayAfterSuccesses: z.ZodDefault<z.ZodNumber>;
        /** Clean period after which strikes fully reset. */
        resetAfterMs: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        ladderMs: number[];
        decayAfterSuccesses: number;
        resetAfterMs: number;
    }, {
        ladderMs?: number[] | undefined;
        decayAfterSuccesses?: number | undefined;
        resetAfterMs?: number | undefined;
    }>>;
    files: z.ZodDefault<z.ZodObject<{
        artifactDir: z.ZodOptional<z.ZodString>;
        /** Completed MCP-owned export bundles older than this are removed. Zero expires prior runs. */
        artifactTtlDays: z.ZodDefault<z.ZodNumber>;
        maxDownloadBytes: z.ZodDefault<z.ZodNumber>;
        maxUnzipBytes: z.ZodDefault<z.ZodNumber>;
        maxUnzipEntries: z.ZodDefault<z.ZodNumber>;
        maxCompressionRatio: z.ZodDefault<z.ZodNumber>;
        exportEncoding: z.ZodDefault<z.ZodEnum<["urlencoded", "multipart"]>>;
        /** Sessions survive a restart unless this is turned off. */
        persistSessions: z.ZodDefault<z.ZodBoolean>;
        /** Overrides the default XDG state path for the session snapshot. */
        sessionFile: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        artifactTtlDays: number;
        maxDownloadBytes: number;
        maxUnzipBytes: number;
        maxUnzipEntries: number;
        maxCompressionRatio: number;
        exportEncoding: "urlencoded" | "multipart";
        persistSessions: boolean;
        artifactDir?: string | undefined;
        sessionFile?: string | undefined;
    }, {
        artifactDir?: string | undefined;
        artifactTtlDays?: number | undefined;
        maxDownloadBytes?: number | undefined;
        maxUnzipBytes?: number | undefined;
        maxUnzipEntries?: number | undefined;
        maxCompressionRatio?: number | undefined;
        exportEncoding?: "urlencoded" | "multipart" | undefined;
        persistSessions?: boolean | undefined;
        sessionFile?: string | undefined;
    }>>;
    /** `lenient` in production; `strict` only in the contract-test suite. */
    schemaMode: z.ZodDefault<z.ZodEnum<["lenient", "strict"]>>;
    logLevel: z.ZodDefault<z.ZodEnum<["trace", "debug", "info", "warn", "error", "silent"]>>;
    /**
     * Bypasses the 5xx redaction rule for local reverse-engineering. Emits a
     * loud warning on every startup where it is set.
     */
    logRawErrors: z.ZodDefault<z.ZodBoolean>;
    /** Enables the discovery probe tool. Off by default so probing is explicit. */
    probe: z.ZodDefault<z.ZodBoolean>;
    /** Writes redacted responses to fixtures/ for the offline test corpus. */
    record: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    enabled: boolean;
    host: "dcsc.lenovo.com" | "us-dcsc.lenovo.com" | "emea-dcsc.lenovo.com" | "cn-dcsc.lenovo.com" | "dcsc-api.lenovo.com" | "us-dcsc-api.lenovo.com";
    locale: {
        geo: string;
        language: string;
        currency: string;
        country: string;
    };
    localeStrict: boolean;
    transport: "reverse-engineered" | "official";
    credentials: null;
    pacing: {
        maxConcurrency: number;
        exportConcurrency: number;
        bucketCapacity: number;
        refillPerSec: number;
        perToolRequestBudget: number;
    };
    timeouts: {
        fastMs: number;
        interactiveMs: number;
        heavyMs: number;
        exportMs: number;
        streamBodyMs: number;
    };
    retry: {
        maxAttempts: number;
        baseDelayMs: number;
        factor: number;
        maxDelayMs: number;
    };
    breaker: {
        windowSize: number;
        windowMs: number;
        minSamples: number;
        failureRatio: number;
        consecutive5xxTrip: number;
        openMs: number;
        halfOpenSuccesses: number;
    };
    waf: {
        ladderMs: number[];
        decayAfterSuccesses: number;
        resetAfterMs: number;
    };
    files: {
        artifactTtlDays: number;
        maxDownloadBytes: number;
        maxUnzipBytes: number;
        maxUnzipEntries: number;
        maxCompressionRatio: number;
        exportEncoding: "urlencoded" | "multipart";
        persistSessions: boolean;
        artifactDir?: string | undefined;
        sessionFile?: string | undefined;
    };
    schemaMode: "lenient" | "strict";
    logLevel: "trace" | "debug" | "info" | "warn" | "error" | "silent";
    logRawErrors: boolean;
    probe: boolean;
    record: boolean;
}, {
    enabled?: boolean | undefined;
    host?: "dcsc.lenovo.com" | "us-dcsc.lenovo.com" | "emea-dcsc.lenovo.com" | "cn-dcsc.lenovo.com" | "dcsc-api.lenovo.com" | "us-dcsc-api.lenovo.com" | undefined;
    locale?: {
        geo: string;
        language: string;
        currency: string;
        country: string;
    } | undefined;
    localeStrict?: boolean | undefined;
    transport?: "reverse-engineered" | "official" | undefined;
    credentials?: null | undefined;
    pacing?: {
        maxConcurrency?: number | undefined;
        exportConcurrency?: number | undefined;
        bucketCapacity?: number | undefined;
        refillPerSec?: number | undefined;
        perToolRequestBudget?: number | undefined;
    } | undefined;
    timeouts?: {
        fastMs?: number | undefined;
        interactiveMs?: number | undefined;
        heavyMs?: number | undefined;
        exportMs?: number | undefined;
        streamBodyMs?: number | undefined;
    } | undefined;
    retry?: {
        maxAttempts?: number | undefined;
        baseDelayMs?: number | undefined;
        factor?: number | undefined;
        maxDelayMs?: number | undefined;
    } | undefined;
    breaker?: {
        windowSize?: number | undefined;
        windowMs?: number | undefined;
        minSamples?: number | undefined;
        failureRatio?: number | undefined;
        consecutive5xxTrip?: number | undefined;
        openMs?: number | undefined;
        halfOpenSuccesses?: number | undefined;
    } | undefined;
    waf?: {
        ladderMs?: number[] | undefined;
        decayAfterSuccesses?: number | undefined;
        resetAfterMs?: number | undefined;
    } | undefined;
    files?: {
        artifactDir?: string | undefined;
        artifactTtlDays?: number | undefined;
        maxDownloadBytes?: number | undefined;
        maxUnzipBytes?: number | undefined;
        maxUnzipEntries?: number | undefined;
        maxCompressionRatio?: number | undefined;
        exportEncoding?: "urlencoded" | "multipart" | undefined;
        persistSessions?: boolean | undefined;
        sessionFile?: string | undefined;
    } | undefined;
    schemaMode?: "lenient" | "strict" | undefined;
    logLevel?: "trace" | "debug" | "info" | "warn" | "error" | "silent" | undefined;
    logRawErrors?: boolean | undefined;
    probe?: boolean | undefined;
    record?: boolean | undefined;
}>;
export type Config = z.infer<typeof ConfigSchema>;
/** Masks anything sensitive before config is logged or returned by dcsc_health. */
export declare function redactConfig(config: Config): Record<string, unknown>;
