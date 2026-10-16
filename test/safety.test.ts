import { describe, expect, it } from 'vitest';

import {
  DcscAmbiguousStateError,
  DcscServerError,
  DcscThrottledError,
  DcscValidationError,
  buildHttpError,
  parseProblemDetail,
  serverErrorMessage,
  toToolError,
} from '../src/http/errors.js';
import { redactBody } from '../src/http/redact.js';
import { assertPreamble, composeQuery } from '../src/http/preamble.js';
import { backoffDelay, shouldRetry } from '../src/http/resilience/retry.js';
import { WafGate } from '../src/http/resilience/waf.js';
import { RequestBudget } from '../src/http/resilience/pacer.js';
import { sanitiseFileName } from '../src/files/artifactStore.js';
import { diffConfigurations } from '../src/model/diff.js';

const locale = { country: 'US', geo: 'NA', language: 'en', currency: 'USD' };
const solution = { solutionMode: 'General Purpose', masterSlices: ['GP', 'HPCGPALL'] };

describe('redaction', () => {
  it('removes leaked SQL entirely rather than token by token', () => {
    const leaked =
      'PreparedStatementCallback; bad SQL grammar [ select category.id as id, cto.cto_code ' +
      'from category inner join cto on category.id = cto.category_id where cto.kind = ? ]';
    const { text } = redactBody(leaked);
    expect(text).toBe('[sql-statement-redacted]');
    expect(text).not.toContain('category_id');
  });

  it('strips Java frames, internal hosts and RFC1918 addresses', () => {
    const leaked =
      'Cannot invoke "com.lenovo.awakens.common.agent.SummaryFeaturesRequest.getSections()" ' +
      'during call to http://cto-rule-engine-rel.earth-us.xpaas.lenovo.com/cto/characters/ ' +
      'via 10.38.87.142:11310 and 192.168.1.5';
    const { text } = redactBody(leaked);
    expect(text).not.toContain('com.lenovo.awakens');
    expect(text).not.toContain('earth-us.xpaas');
    expect(text).not.toContain('10.38.87.142');
    expect(text).not.toContain('192.168.1.5');
    expect(text).toContain('[class]');
    expect(text).toContain('[internal-ip]');
  });

  it('produces a stable hash so repeat failures stay recognisable', () => {
    expect(redactBody('same').hash).toBe(redactBody('same').hash);
    expect(redactBody('a').hash).not.toBe(redactBody('b').hash);
  });
});

describe('5xx never leaks to the user', () => {
  const leaky =
    'bad SQL grammar [ select a from b where c = ? ] com.lenovo.awakens.Thing.method()';

  it('returns only the fixed template for a GET 500', () => {
    const err = buildHttpError({
      status: 500,
      method: 'GET',
      endpoint: 'category_hierarchies',
      contentType: 'text/plain',
      body: leaky,
      requestId: 'req-123',
      traceId: undefined,
      corrId: 'corr-1',
      logRawErrors: false,
    });
    expect(err).toBeInstanceOf(DcscServerError);
    expect(err.userMessage).toContain('HTTP 500');
    expect(err.userMessage).toContain('req-123');
    expect(err.userMessage).not.toContain('required parameter');
    expect(err.userMessage).not.toContain('API shape');
    expect(err.userMessage).not.toContain('select');
    expect(err.userMessage).not.toContain('com.lenovo');

    // And the same holds at the MCP boundary.
    const tool = toToolError(err);
    expect(JSON.stringify(tool)).not.toContain('select');
    expect(JSON.stringify(tool)).not.toContain('com.lenovo');
  });

  it('surfaces safe trace and correlation references without leaking a 5xx body', () => {
    const rawBody =
      '[502 Bad Gateway] during GET to http://cto-rule-engine-rel.earth-us.xpaas.lenovo.com/private';
    const err = buildHttpError({
      status: 502,
      method: 'GET',
      endpoint: 'lfo_autoDerive',
      contentType: 'text/plain',
      body: rawBody,
      requestId: undefined,
      traceId: '6ad18c05c7127dff4b640651a25974dd',
      corrId: '01M518NX21G4ST446KTX3PBNGS',
      logRawErrors: true,
    });
    const tool = toToolError(err);
    expect(err.internal).toContain('cto-rule-engine-rel');
    expect(err.userMessage).toBe(
      'DCSC returned a server error (HTTP 502). References: ' +
      'trace 6ad18c05c7127dff4b640651a25974dd, correlation 01M518NX21G4ST446KTX3PBNGS.',
    );
    expect(tool).toMatchObject({
      kind: 'server',
      traceId: '6ad18c05c7127dff4b640651a25974dd',
      correlationId: '01M518NX21G4ST446KTX3PBNGS',
    });
    expect(JSON.stringify(tool)).not.toContain('cto-rule-engine-rel');
    expect(JSON.stringify(tool)).not.toContain('/private');
    expect(JSON.stringify(tool)).not.toContain(rawBody);
    expect(tool).not.toHaveProperty('endpoint');
  });

  it('drops unsafe upstream identifiers and falls back to the safe local correlation', () => {
    const err = buildHttpError({
      status: 503,
      method: 'GET',
      endpoint: 'category_hierarchies',
      contentType: 'text/plain',
      body: leaky,
      requestId: 'http://internal.example/request',
      traceId: 'cto-rule-engine-rel.earth-us.xpaas.lenovo.com',
      corrId: '01M518NX21G4ST446KTX3PBNGS',
      logRawErrors: false,
    });
    const tool = toToolError(err);
    expect(err.userMessage).toBe(
      'DCSC returned a server error (HTTP 503). References: correlation 01M518NX21G4ST446KTX3PBNGS.',
    );
    expect(tool).not.toHaveProperty('requestId');
    expect(tool).not.toHaveProperty('traceId');
    expect(tool).toHaveProperty('correlationId', '01M518NX21G4ST446KTX3PBNGS');
  });

  it('states when no correlation reference is available', () => {
    expect(serverErrorMessage(500, undefined)).toBe(
      'DCSC returned a server error (HTTP 500). No correlation reference was returned.',
    );
  });

  it('rejects whitespace and overlong identifiers at the MCP boundary', () => {
    const err = buildHttpError({
      status: 502,
      method: 'GET',
      endpoint: 'category_hierarchies',
      contentType: 'text/plain',
      body: leaky,
      requestId: 'request id with spaces',
      traceId: 'a'.repeat(129),
      corrId: 'corr\nheader-injection',
      logRawErrors: false,
    });
    expect(err.userMessage).toContain('No correlation reference was returned.');
    expect(toToolError(err)).toEqual({ error: err.userMessage, kind: 'server' });
  });

  it('flags a 5xx on a mutation as ambiguous rather than retryable', () => {
    const err = buildHttpError({
      status: 500,
      method: 'POST',
      endpoint: 'cto_autoderive',
      contentType: 'text/plain',
      body: leaky,
      requestId: 'req-9',
      traceId: undefined,
      corrId: 'corr-2',
      logRawErrors: false,
    });
    expect(err).toBeInstanceOf(DcscAmbiguousStateError);
    expect(err.userMessage).toContain('may or may not have been applied');
    expect(toToolError(err).kind).toBe('ambiguous_state');
    expect(err.retryable).toBe(false);
  });

  it('surfaces a 4xx detail verbatim, because it names a parameter', () => {
    const err = buildHttpError({
      status: 400,
      method: 'POST',
      endpoint: 'export_zip',
      contentType: 'application/problem+json',
      body: { detail: "Required parameter 'fileName' is not present.", status: 400 },
      requestId: 'req-4',
      traceId: undefined,
      corrId: 'corr-3',
      logRawErrors: false,
    });
    expect(err).toBeInstanceOf(DcscValidationError);
    expect((err as DcscValidationError).missingParam).toBe('fileName');
    expect(err.userMessage).toContain('fileName');
  });
});

describe('problem+json parsing drives contract discovery', () => {
  it.each([
    ["Required parameter 'masterSlices' is not present.", 'missing_param', 'masterSlices'],
    ['No static resource ctos/batch_customizing.', 'not_found', 'ctos/batch_customizing'],
  ])('parses %s', (detail, kind, param) => {
    const parsed = parseProblemDetail(detail);
    expect(parsed.kind).toBe(kind);
    expect(parsed.param).toBe(param);
  });

  it('falls back to unknown without throwing', () => {
    expect(parseProblemDetail('something entirely new').kind).toBe('unknown');
    expect(parseProblemDetail(undefined).kind).toBe('unknown');
  });
});

describe('retry policy', () => {
  const transport = Object.assign(new Error('socket'), { code: 'ECONNRESET' });

  it('never retries a POST that reached the server', () => {
    const err = new DcscServerError({ userMessage: 'x', status: 503, retryable: true });
    expect(
      shouldRetry({ err, method: 'POST', connectPhase: false, attempt: 1, maxAttempts: 3 }),
    ).toBe(false);
  });

  it('retries a POST that failed before the body was written', () => {
    expect(
      shouldRetry({
        err: transport,
        method: 'POST',
        connectPhase: true,
        attempt: 1,
        maxAttempts: 3,
      }),
    ).toBe(true);
  });

  it('retries idempotent GETs on transport failure', () => {
    expect(
      shouldRetry({
        err: transport,
        method: 'GET',
        connectPhase: false,
        attempt: 1,
        maxAttempts: 3,
      }),
    ).toBe(true);
  });

  it('never retries 499', () => {
    const err = new DcscThrottledError({ userMessage: 'x', status: 499, retryAfterMs: 1000 });
    expect(
      shouldRetry({ err, method: 'GET', connectPhase: false, attempt: 1, maxAttempts: 3 }),
    ).toBe(false);
  });

  it('never retries a 4xx', () => {
    const err = new DcscValidationError({
      userMessage: 'x',
      status: 400,
      problemKind: 'missing_param',
    });
    expect(
      shouldRetry({ err, method: 'GET', connectPhase: false, attempt: 1, maxAttempts: 3 }),
    ).toBe(false);
  });

  it('stops at the attempt ceiling', () => {
    expect(
      shouldRetry({
        err: transport,
        method: 'GET',
        connectPhase: false,
        attempt: 3,
        maxAttempts: 3,
      }),
    ).toBe(false);
  });

  it('keeps backoff inside the configured ceiling', () => {
    const opts = { maxAttempts: 3, baseDelayMs: 1000, factor: 3, maxDelayMs: 20_000 };
    for (let i = 0; i < 200; i += 1) {
      expect(backoffDelay(1, opts)).toBeLessThanOrEqual(1000);
      expect(backoffDelay(2, opts)).toBeLessThanOrEqual(3000);
      expect(backoffDelay(9, opts)).toBeLessThanOrEqual(20_000);
    }
  });
});

describe('WAF ladder', () => {
  it('climbs 60s -> 300s -> 900s -> 1h and holds', () => {
    const gate = new WafGate([60_000, 300_000, 900_000, 3_600_000], 10, 30 * 60_000);
    expect(gate.recordStrike()).toBe(60_000);
    expect(gate.recordStrike()).toBe(300_000);
    expect(gate.recordStrike()).toBe(900_000);
    expect(gate.recordStrike()).toBe(3_600_000);
    expect(gate.recordStrike()).toBe(3_600_000);
  });

  it('reports a cooldown after a strike', () => {
    const gate = new WafGate([60_000], 10, 30 * 60_000);
    expect(gate.isCoolingDown).toBe(false);
    gate.recordStrike();
    expect(gate.isCoolingDown).toBe(true);
    expect(gate.remainingMs()).toBeGreaterThan(50_000);
  });

  it('decays a rung only after enough clean responses', () => {
    const gate = new WafGate([60_000, 300_000], 3, 30 * 60_000);
    gate.recordStrike();
    gate.recordStrike();
    expect(gate.strikes).toBe(2);
    gate.recordSuccess();
    gate.recordSuccess();
    expect(gate.strikes).toBe(2);
    gate.recordSuccess();
    expect(gate.strikes).toBe(1);
  });
});

describe('preamble', () => {
  it('renames country to country_or_region and joins masterSlices', () => {
    const q = composeQuery({ locale, solution });
    expect(q.get('country_or_region')).toBe('US');
    expect(q.get('country')).toBeNull();
    expect(q.get('masterSlices')).toBe('GP,HPCGPALL');
    expect(q.get('_request')).toBe('web');
  });

  it('fails locally when a mandatory param is missing, costing zero requests', () => {
    const q = composeQuery({ locale });
    expect(() =>
      assertPreamble(q, { endpoint: 'x', corrId: 'c', requiresSolution: true }),
    ).toThrowError(/solutionMode/);
  });

  it('allows bootstrap endpoints to omit solution context', () => {
    const q = composeQuery({ locale });
    expect(() =>
      assertPreamble(q, { endpoint: 'locales', corrId: 'c', requiresSolution: false }),
    ).not.toThrow();
  });
});

describe('request budget', () => {
  it('stops a runaway loop at the limit', () => {
    const budget = new RequestBudget(3);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.remaining).toBe(0);
  });
});

describe('export filename sanitisation', () => {
  it('never lets a server-supplied name escape the target directory', () => {
    expect(sanitiseFileName('../../etc/passwd')).not.toContain('..');
    expect(sanitiseFileName('../../etc/passwd')).not.toContain('/');
    expect(sanitiseFileName('/abs/path.zip')).not.toMatch(/^\//);
    expect(sanitiseFileName('a\\b\\c.xml')).not.toContain('\\');
    expect(sanitiseFileName('')).toBe('export');
    expect(sanitiseFileName('x'.repeat(400)).length).toBeLessThanOrEqual(120);
  });

  it('keeps ordinary names readable', () => {
    expect(sanitiseFileName('SR630-V3_quote.v2')).toBe('SR630-V3_quote.v2');
  });
});

describe('mutation diff', () => {
  const index = (entries: Array<[string, string, number]>) => {
    const features = entries.map(([code, section, qty]) => ({
      code,
      description: `desc ${code}`,
      section,
      sectionTitle: section,
      tab: 'Processors',
      subTab: 'Processors',
      min: 0,
      max: 1,
      unitPrice: 0,
      category: undefined,
      selectedQty: qty,
      eccnRestricted: false,
      haystack: code.toLowerCase(),
    }));
    const byCode = new Map(features.map((f) => [f.code, [f]]));
    const selected = new Map(
      features.filter((f) => f.selectedQty > 0).map((f) => [f.code, f.selectedQty]),
    );
    return {
      features,
      byCode,
      selected,
      sections: [],
      sectionById: new Map(),
      tabs: ['Processors'],
    } as never;
  };

  it('reports a same-section swap as a replacement, not an unexplained auto change', () => {
    const before = index([
      ['BYW3', 'proc', 1],
      ['BYVW', 'proc', 0],
    ]);
    const after = index([
      ['BYW3', 'proc', 0],
      ['BYVW', 'proc', 1],
    ]);
    const diff = diffConfigurations({
      beforeIndex: before,
      afterIndex: after,
      beforeRaw: { totalPrice: 100 },
      afterRaw: { totalPrice: 150 },
      currency: 'USD',
      requested: new Set(['BYVW']),
    });
    expect(diff.replaced).toEqual([
      expect.objectContaining({ from: 'BYW3', to: 'BYVW' }),
    ]);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    // The removal was implied by the swap, so it must not be flagged.
    expect(diff.autoChanges).toBe(0);
    expect(diff.price.delta).toBe(50);
  });

  it('still flags a genuine unrequested addition in another section', () => {
    const before = index([['BYW3', 'proc', 1]]);
    const after = index([
      ['BYW3', 'proc', 1],
      ['HEAT9', 'thermal', 1],
    ]);
    const diff = diffConfigurations({
      beforeIndex: before,
      afterIndex: after,
      beforeRaw: { totalPrice: 100 },
      afterRaw: { totalPrice: 420 },
      currency: 'USD',
      requested: new Set([]),
    });
    expect(diff.added.map((a) => a.code)).toEqual(['HEAT9']);
    expect(diff.added[0]?.auto).toBe(true);
    expect(diff.autoChanges).toBe(1);
  });
});
