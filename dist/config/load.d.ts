import { type Config } from './schema.js';
/**
 * Precedence, low to high: built-in defaults -> config file -> DCSC_* env vars.
 *
 * Validated once at startup, failing fast and reporting every problem at once
 * rather than one per run.
 */
export declare function loadConfig(overrides?: Record<string, unknown>): Config;
