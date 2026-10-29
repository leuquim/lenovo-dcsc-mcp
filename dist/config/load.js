import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from './schema.js';
const ENV_PREFIX = 'DCSC_';
function envStr(name) {
    const v = process.env[`${ENV_PREFIX}${name}`];
    return v === undefined || v === '' ? undefined : v;
}
function envBool(name) {
    const v = envStr(name);
    if (v === undefined)
        return undefined;
    return /^(1|true|yes|on)$/i.test(v);
}
function envInt(name) {
    const v = envStr(name);
    if (v === undefined)
        return undefined;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
}
function envNumber(name) {
    const v = envStr(name);
    if (v === undefined)
        return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}
/** Drops keys whose value is undefined so zod defaults still apply. */
function defined(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
function readConfigFile() {
    const path = envStr('CONFIG') ?? join(homedir(), '.config', 'lenovo-dcsc', 'config.json');
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (err) {
        const code = err.code;
        if (code === 'ENOENT')
            return {};
        // A malformed config file is a hard failure — silently falling back to
        // defaults would hide a real misconfiguration.
        throw new Error(`Failed to read config file at ${path}: ${String(err)}`);
    }
}
/**
 * Precedence, low to high: built-in defaults -> config file -> DCSC_* env vars.
 *
 * Validated once at startup, failing fast and reporting every problem at once
 * rather than one per run.
 */
export function loadConfig(overrides = {}) {
    const file = readConfigFile();
    const fileObj = (typeof file === 'object' && file !== null ? file : {});
    const localeFromEnv = defined({
        country: envStr('COUNTRY'),
        geo: envStr('GEO'),
        language: envStr('LANGUAGE'),
        currency: envStr('CURRENCY'),
    });
    const fileLocale = (fileObj.locale ?? {});
    const env = defined({
        enabled: envBool('ENABLED'),
        host: envStr('HOST'),
        localeStrict: envBool('LOCALE_STRICT'),
        transport: envStr('TRANSPORT'),
        schemaMode: envStr('SCHEMA_MODE'),
        logLevel: envStr('LOG_LEVEL'),
        logRawErrors: envBool('LOG_RAW_ERRORS'),
        probe: envBool('PROBE'),
        record: envBool('RECORD'),
    });
    const pacing = defined({
        maxConcurrency: envInt('MAX_CONCURRENCY'),
        perToolRequestBudget: envInt('TOOL_REQUEST_BUDGET'),
    });
    const files = defined({
        persistSessions: envBool('PERSIST_SESSIONS'),
        sessionFile: envStr('SESSION_FILE'),
        artifactDir: envStr('ARTIFACT_DIR'),
        artifactTtlDays: envInt('ARTIFACT_TTL_DAYS'),
        maxDownloadBytes: envInt('MAX_DOWNLOAD_BYTES'),
        maxUnzipBytes: envInt('MAX_UNZIP_BYTES'),
        maxUnzipEntries: envInt('MAX_UNZIP_ENTRIES'),
        maxCompressionRatio: envNumber('MAX_COMPRESSION_RATIO'),
        exportEncoding: envStr('EXPORT_ENCODING'),
    });
    // Sub-objects are only included when they carry at least one key, otherwise
    // an empty object would shadow the zod default rather than merge into it.
    const localeMerged = { ...fileLocale, ...localeFromEnv, ...(overrides.locale ?? {}) };
    const pacingMerged = { ...(fileObj.pacing ?? {}), ...pacing, ...(overrides.pacing ?? {}) };
    const filesMerged = { ...(fileObj.files ?? {}), ...files, ...(overrides.files ?? {}) };
    const merged = {
        ...fileObj,
        ...env,
        ...overrides,
        ...(Object.keys(localeMerged).length > 0 ? { locale: localeMerged } : {}),
        ...(Object.keys(pacingMerged).length > 0 ? { pacing: pacingMerged } : {}),
        ...(Object.keys(filesMerged).length > 0 ? { files: filesMerged } : {}),
    };
    const result = ConfigSchema.safeParse(merged);
    if (!result.success) {
        const problems = result.error.issues
            .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('\n');
        throw new Error(`Invalid DCSC configuration:\n${problems}`);
    }
    return result.data;
}
//# sourceMappingURL=load.js.map