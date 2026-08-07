import { createHash } from 'node:crypto';

/**
 * DCSC's 5xx responses leak raw JDBC statements, Java stack frames, internal
 * hostnames and RFC1918 addresses. Observed examples:
 *
 *   "PreparedStatementCallback; bad SQL grammar [ select category.id ... ]"
 *   "Cannot invoke \"com.lenovo.awakens.common.agent...\" because ... is null"
 *   "[404] during [GET] to [http://cto-rule-engine-rel-java25.earth-us.xpaas.lenovo.com/...]"
 *
 * None of that may reach a user, and it should not sit in logs either. This
 * module is the single place that decides what survives.
 */

const MAX_LOG_LEN = 2_000;

const SQL_KEYWORDS =
  /\b(select|insert|update|delete|from|where|inner join|left join|union all)\b/gi;

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Java / Spring stack frames and FQCNs.
  [/\b(?:com\.lenovo|org\.springframework|java|javax|jakarta)(?:\.[A-Za-z0-9_$]+)+/g, '[class]'],
  // JDBC URLs.
  [/jdbc:[a-z0-9]+:\/\/[^\s"'\]]+/gi, '[jdbc]'],
  // Internal hostnames (anything not under a public lenovo.com web host).
  [/\bhttps?:\/\/[a-z0-9.-]*\.(?:xpaas|earth-us|earth-cn)\.lenovo\.com[^\s"'\]]*/gi, '[internal-url]'],
  // RFC1918 / link-local addresses, with optional port.
  [/\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g, '[internal-ip]'],
  [/\b192\.168\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g, '[internal-ip]'],
  [/\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g, '[internal-ip]'],
];

/** Detects text that looks like a leaked SQL statement. */
function looksLikeSql(text: string): boolean {
  SQL_KEYWORDS.lastIndex = 0;
  const matches = text.match(SQL_KEYWORDS);
  return matches !== null && matches.length >= 3;
}

/**
 * Redacts an upstream error body for logging.
 *
 * Returns a stable hash alongside the redacted text so recurring identical
 * 500s stay recognisable without retaining their content.
 */
export function redactBody(raw: string): { text: string; hash: string } {
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 12);

  let text = raw;
  for (const [pattern, replacement] of PATTERNS) {
    text = text.replace(pattern, replacement);
  }

  // A leaked query is redacted wholesale rather than token by token — partial
  // redaction of SQL still discloses the schema.
  if (looksLikeSql(text)) {
    text = '[sql-statement-redacted]';
  }

  if (text.length > MAX_LOG_LEN) {
    text = `${text.slice(0, MAX_LOG_LEN)}… [truncated ${text.length - MAX_LOG_LEN} chars]`;
  }

  return { text, hash };
}

/**
 * Redacts a value of unknown shape (string, Buffer, parsed JSON) for logging.
 */
export function redactUnknown(raw: unknown): { text: string; hash: string } {
  if (raw === undefined || raw === null) return { text: '', hash: '' };
  const asString =
    typeof raw === 'string'
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : safeStringify(raw);
  return redactBody(asString);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserialisable]';
  }
}
