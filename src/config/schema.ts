import { z } from 'zod';
import { KNOWN_HOSTS, DEFAULT_HOST } from './constants.js';

/**
 * Locale is deliberately one cohesive object rather than four independent
 * knobs. A mismatched geo/country pairing is a classic DCSC 500 generator, so
 * the four fields must always travel together and be validated as a unit.
 */
export const LocaleSchema = z.object({
  /** Sent as the `country_or_region` query param. ISO-3166 alpha-2. */
  country: z.string().length(2).toUpperCase(),
  /** Sent as `geo`. e.g. NA, EMEA, AP, LA. */
  geo: z.string().min(2).max(8),
  /** Sent as `language`. ISO-639-1. */
  language: z.string().min(2).max(5),
  /** Sent as `currency`. ISO-4217. */
  currency: z.string().length(3).toUpperCase(),
});

export type Locale = z.infer<typeof LocaleSchema>;

/** The solution context that pairs with a locale on nearly every call. */
export const SolutionContextSchema = z.object({
  /** Human-readable mode string, e.g. "General Purpose". NOT an enum. */
  solutionMode: z.string().min(1),
  /** Comma-joined on the wire. Omitting this returns HTTP 500. */
  masterSlices: z.array(z.string().min(1)).min(1),
});

export type SolutionContext = z.infer<typeof SolutionContextSchema>;

const PacingSchema = z.object({
  /** Global in-flight request cap; also the undici Agent connection cap. */
  maxConcurrency: z.number().int().min(1).max(8).default(2),
  /** Never two downloads at once. */
  exportConcurrency: z.number().int().min(1).max(2).default(1),
  /** Token bucket burst capacity. */
  bucketCapacity: z.number().int().min(1).max(20).default(5),
  /** Token bucket refill rate (~250ms minimum spacing at 4/s). */
  refillPerSec: z.number().min(0.5).max(10).default(4),
  /**
   * Hard cap on requests issued during a single MCP tool call. This is the
   * guard against a runaway agent loop hammering DCSC, and is worth more than
   * every other resilience control combined.
   */
  perToolRequestBudget: z.number().int().min(1).max(500).default(40),
});

const TimeoutsSchema = z.object({
  /**
   * Spring Boot does not flush headers until the controller returns, so for
   * non-streaming classes headersTimeout must equal the overall budget.
   */
  fastMs: z.number().int().default(20_000),
  interactiveMs: z.number().int().default(120_000),
  heavyMs: z.number().int().default(300_000),
  exportMs: z.number().int().default(600_000),
  /** Inter-chunk stall timeout, only meaningful for streamed downloads. */
  streamBodyMs: z.number().int().default(120_000),
});

const RetrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(5).default(3),
  baseDelayMs: z.number().int().default(1_000),
  factor: z.number().min(1).default(3),
  maxDelayMs: z.number().int().default(20_000),
});

const BreakerSchema = z.object({
  windowSize: z.number().int().default(20),
  windowMs: z.number().int().default(60_000),
  minSamples: z.number().int().default(5),
  failureRatio: z.number().min(0).max(1).default(0.5),
  consecutive5xxTrip: z.number().int().default(3),
  openMs: z.number().int().default(30_000),
  halfOpenSuccesses: z.number().int().default(2),
});

const WafSchema = z.object({
  /** Cooldown ladder in ms, indexed by strike count. Last value repeats. */
  ladderMs: z
    .array(z.number().int())
    .min(1)
    .default([60_000, 300_000, 900_000, 3_600_000]),
  /** Consecutive successes needed to drop one rung. */
  decayAfterSuccesses: z.number().int().default(10),
  /** Clean period after which strikes fully reset. */
  resetAfterMs: z.number().int().default(30 * 60_000),
});

const FilesSchema = z.object({
  artifactDir: z.string().optional(),
  /** Completed MCP-owned export bundles older than this are removed. Zero expires prior runs. */
  artifactTtlDays: z.number().int().nonnegative().default(30),
  maxDownloadBytes: z.number().int().positive().default(200 * 1024 * 1024),
  maxUnzipBytes: z.number().int().positive().default(500 * 1024 * 1024),
  maxUnzipEntries: z.number().int().positive().default(500),
  maxCompressionRatio: z.number().positive().default(100),
  exportEncoding: z.enum(['urlencoded', 'multipart']).default('urlencoded'),
  /** Sessions survive a restart unless this is turned off. */
  persistSessions: z.boolean().default(true),
  /** Overrides the default XDG state path; workspaces persist under a `workspaces` directory beside it. */
  sessionFile: z.string().optional(),
});

export const ConfigSchema = z.object({
  /** Master kill switch. */
  enabled: z.boolean().default(true),

  host: z.enum(KNOWN_HOSTS).default(DEFAULT_HOST),

  locale: LocaleSchema.default({
    country: 'US',
    geo: 'NA',
    language: 'en',
    currency: 'USD',
  }),

  /** Reject locale combinations not in the known-good table. */
  localeStrict: z.boolean().default(true),

  transport: z.enum(['reverse-engineered', 'official']).default('reverse-engineered'),

  /**
   * Reserved. The reverse-engineered transport ignores this entirely. Do not
   * model OAuth/JWT until credentials actually exist.
   */
  credentials: z.null().default(null),

  // Parse omitted sections so their field defaults are populated. Zod 4's
  // default({}) would return the empty object without parsing its children.
  pacing: PacingSchema.prefault({}),
  timeouts: TimeoutsSchema.prefault({}),
  retry: RetrySchema.prefault({}),
  breaker: BreakerSchema.prefault({}),
  waf: WafSchema.prefault({}),
  files: FilesSchema.prefault({}),

  /** `lenient` in production; `strict` only in the contract-test suite. */
  schemaMode: z.enum(['lenient', 'strict']).default('lenient'),

  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),

  /**
   * Bypasses the 5xx redaction rule for local reverse-engineering. Emits a
   * loud warning on every startup where it is set.
   */
  logRawErrors: z.boolean().default(false),

  /** Enables the discovery probe tool. Off by default so probing is explicit. */
  probe: z.boolean().default(false),

  /** Writes redacted responses to fixtures/ for the offline test corpus. */
  record: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Masks anything sensitive before config is logged or returned to clients. */
export function redactConfig(config: Config): Record<string, unknown> {
  return { ...config, credentials: config.credentials ? '[redacted]' : null };
}
