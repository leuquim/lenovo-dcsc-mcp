import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';
import { projectValidationToolResult, registerValidationTools } from '../src/mcp/validationTools.js';
import { projectJsonPage } from '../src/model/pagedJson.js';
import type { RawConfiguration } from '../src/model/types.js';

const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const raw: RawConfiguration = { code: 'NODE', sliceCtoCode: 'NODE', quantity: 1, totalPrice: 100, tabs: [] };
  const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };
  const session = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw,
    configurationId: 'US__node', reduced: reduceConfiguration(raw, 'US__node'), primed: true });
  const send = vi.spyOn(service.http, 'send').mockImplementation(async request => ({
    raw: request.path.endsWith('/result') ? ['finish'] : [{ buildEntityNumber: 'BUILD', uuid: 'job' }],
  }) as never);
  return { service, session, send };
}

describe('saved validation inspection', () => {
  it('persists target scope, recomputes hash/revision staleness and never repeats retrieval', async () => {
    const { service, session, send } = setup();
    const report = await service.validate(session.id, service.newCtx());
    expect(report.isValid).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    let job = service.validationJobs(session.workspaceId)[0]!;
    expect(job.target).toEqual({ handle: session.id, scope: 'configuration' });
    expect(job.isValid).toBe(true);
    expect(job.stale).toBe(false);
    expect(job.projection).toMatchObject({
      rackDataOmitted: false,
      validatedScope: { scope: 'configuration', configurations: 1 },
      localDiagnostics: [],
      headroom: [expect.objectContaining({ productCode: 'NODE' })],
    });
    await service.sessions.transact(session.workspaceId, {}, draft => { draft.label = 'unchanged configuration'; });
    expect(service.validationJobs(session.id)[0]!.stale).toBe(false);
    await service.setQuantity(session, 2);
    job = service.validationJobs(session.id)[0]!;
    expect(job.isValid).toBe(false);
    expect(job.stale).toBe(true);
    expect(job.freshValidationRequired).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not trust an older job whose validated scope was never stored', async () => {
    const { service, session, send } = setup();
    await service.validate(session.id, service.newCtx());
    const jobs = service.sessions.getWorkspace(session.id)!.serverState.validationJobs as Record<string, unknown>[];
    delete jobs[0]!.target;
    expect(service.validationJobs(session.id)[0]).toMatchObject({ isValid: false, stale: true, freshValidationRequired: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('publishes the terminal projection atomically and samples freshness after a queued edit', async () => {
    const { service, session, send } = setup();
    let enteredResult!: () => void;
    let releaseResult!: () => void;
    const resultStarted = new Promise<void>(resolve => { enteredResult = resolve; });
    const resultBlocked = new Promise<void>(resolve => { releaseResult = resolve; });
    send.mockImplementation(async request => {
      if (!request.path.endsWith('/result')) {
        return { raw: [{ buildEntityNumber: 'BUILD', uuid: 'job' }] } as never;
      }
      enteredResult();
      await resultBlocked;
      return { raw: ['finish'] } as never;
    });

    const validating = service.validate(session.id, service.newCtx());
    await resultStarted;
    await service.setQuantity(session, 2);
    releaseResult();

    const report = await validating;
    expect(report).toMatchObject({
      status: 'unavailable', isValid: false, stale: true, freshValidationRequired: true,
      warning: 'Configuration changed during validation; validate the current revision again.',
    });
    const saved = service.validationJobs(session.id)[0]!;
    expect(saved).toMatchObject({
      terminal: true,
      projection: {
        rackDataOmitted: false,
        validatedScope: { scope: 'configuration', configurations: 1 },
        localDiagnostics: [],
      },
      stale: true,
      isValid: false,
      currentStatus: 'unavailable',
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('offers executable list/detail continuations and rejects foreign job IDs', async () => {
    const { service, session, send } = setup();
    await service.validate(session.id, service.newCtx());
    type Reply = { isError?: boolean; content: Array<{ text: string }> };
    let handler!: (args: { session: string; jobId?: string; path: string[]; offset: number; limit: number }) => Promise<Reply>;
    registerValidationTools({ registerTool(_name: string, _config: unknown, fn: typeof handler) { handler = fn; } } as unknown as McpServer, service);
    const args = { session: session.workspaceId, path: [], offset: 0, limit: 20 };
    const list = JSON.parse((await handler(args)).content[0]!.text);
    const next = list.items[0].value.next;
    expect(next.tool).toBe('dcsc_validation_jobs');
    const detail = await handler({ ...args, ...next.arguments });
    expect(detail.isError).not.toBe(true);
    expect(Buffer.byteLength(detail.content[0]!.text)).toBeLessThan(8000);
    expect((await handler({ ...args, jobId: 'foreign' })).isError).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('bounded validation result projection', () => {
  it('preserves the real tool local info count when its response is compacted', async () => {
    const { service, session } = setup();
    session.raw.expansionMessages = Array.from({ length: 30 }, (_, index) => ({
      type: 'info',
      message: `Informational local diagnostic ${index}: ${'captured context '.repeat(40)}`,
    }));
    type Reply = { isError?: boolean; content: Array<{ text: string }> };
    type Handler = (args: { session: string; deadlineMs?: number }) => Promise<Reply>;
    let handler: Handler | undefined;
    registerTools({ registerTool(name: string, _definition: unknown, callback: Handler) {
      if (name === 'dcsc_validate') handler = callback;
    } } as unknown as McpServer, service);
    if (!handler) throw new Error('dcsc_validate was not registered');

    const reply = await handler({ session: session.id });
    expect(reply.isError).not.toBe(true);
    expect(Buffer.byteLength(reply.content[0]!.text)).toBeLessThan(8_000);
    expect(JSON.parse(reply.content[0]!.text)).toMatchObject({
      status: 'valid',
      isValid: true,
      localErrorCount: 0,
      localWarningCount: 0,
      localInfoCount: 30,
      compacted: true,
    });
  });

  it('keeps a complete small result unchanged', () => {
    const full = {
      status: 'valid', isValid: true, jobId: 'job', payloadSha256: 'a'.repeat(64),
      messages: [], localDiagnostics: [], headroom: [],
    };
    expect(projectValidationToolResult(full, { session: 'ws', jobId: 'job' })).toBe(full);
  });

  it('bounds a captured terminal-invalid shape and exposes every diagnostic through executable paths', () => {
    const messages = Array.from({ length: 21 }, (_, index) => ({
      severity: 'error',
      code: `B923-${index}`,
      message: index === 0
        ? `Derive Table B923-7D73-VGA_FILLER: ${'😀缺少处理器 '.repeat(500)}`
        : `Captured manufacturing rule ${index + 1} failed: ${'evidence '.repeat(45)}`,
    }));
    const localDiagnostics = Array.from({ length: 7 }, (_, index) => ({
      severity: index === 0 ? 'error' : 'warning',
      message: `Local configuration diagnostic ${index}: ${'detail '.repeat(55)}`,
      configurationId: 'US__server',
      sourcePath: `$.tabs[0].subTabs[0].errors[${index}]`,
    }));
    const headroom = Array.from({ length: 12 }, (_, configurationIndex) => ({
      configuration: `sess_server_${configurationIndex}`, productCode: '7D73CTO1WW',
      constraints: Array.from({ length: 18 }, (_, index) => ({
        name: `Constraint ${index}`, used: index, capacity: 16, breached: index > 15, unit: 'Slots',
      })),
      breached: ['Constraint 16', 'Constraint 17'],
    }));
    const full = {
      session: 'ws', workspaceId: 'ws', source: 'lmc_validation',
      status: 'invalid', isValid: false, terminal: true,
      jobId: 'job', payloadSha256: 'a'.repeat(64), validatedRevision: 3,
      stale: false, freshValidationRequired: false,
      validatedScope: { scope: 'workspace', configurations: 2, racksInSolution: 1,
        racksValidated: 1, covers: '2 configuration(s) and 1 rack(s).' },
      errorCount: 21, warningCount: 0, infoCount: 2,
      localErrorCount: 1, localWarningCount: 6,
      messages, localDiagnostics, headroom,
      lmc: { buildEntityNumber: 'BUILD', uuid: 'uuid', lmcURL: 'https://example.invalid/lmc/' },
      rackDataOmitted: false,
      next: 'Inspect the server and local diagnostics, correct the configuration, then validate again.',
    };
    expect(Buffer.byteLength(JSON.stringify(full, null, 2))).toBeGreaterThan(8_000);

    const compact = projectValidationToolResult(full, { session: 'ws', jobId: 'job' });
    expect(Buffer.byteLength(JSON.stringify(compact, null, 2))).toBeLessThan(8_000);
    expect(compact).toMatchObject({
      status: 'invalid', isValid: false, jobId: 'job', payloadSha256: 'a'.repeat(64),
      validatedRevision: 3, stale: false, freshValidationRequired: false,
      errorCount: 21, localErrorCount: 1, compacted: true,
      pages: {
        messages: { total: 21, inspect: { tool: 'dcsc_validation_jobs', arguments: {
          session: 'ws', jobId: 'job', path: ['report', 'messages'], offset: 0, limit: 20,
        } } },
        localDiagnostics: { total: 7 },
        headroom: { total: 12 },
      },
      headroomReturned: 3,
    });
    expect(Array.from((compact['messages'] as Array<{ message: string }>)[0]!.message).length)
      .toBeLessThanOrEqual(281);
    expect(JSON.stringify(compact)).not.toContain('😀缺少处理器 '.repeat(100));

    const saved = { report: { messages }, projection: { localDiagnostics, headroom } };
    const inspectPath = (path: string[]): unknown => {
      let offset = 0;
      const entries: Array<[string, unknown]> = [];
      for (;;) {
        const page = projectJsonPage(saved, { tool: 'dcsc_validation_jobs', arguments: {
          session: 'ws', jobId: 'job',
        }, path, offset, limit: 20 });
        if (typeof page['text'] === 'string') {
          let text = page['text'];
          let next = page['next'] as { arguments: { offset: number } } | undefined;
          while (next) {
            const chunk = projectJsonPage(saved, { tool: 'dcsc_validation_jobs', arguments: {
              session: 'ws', jobId: 'job',
            }, path, offset: next.arguments.offset, limit: 1000 });
            text += String(chunk['text']);
            next = chunk['next'] as { arguments: { offset: number } } | undefined;
          }
          return text;
        }
        for (const item of page['items'] as Array<{
          key: string; value?: unknown; next?: { arguments: { path: string[] } };
        }>) {
          entries.push([item.key, Object.hasOwn(item, 'value')
            ? item.value
            : inspectPath(item.next!.arguments.path)]);
        }
        const next = page['next'] as { arguments: { offset: number } } | undefined;
        if (!next) break;
        offset = next.arguments.offset;
      }
      return path.reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], saved) instanceof Array
        ? entries.map(([, value]) => value)
        : Object.fromEntries(entries);
    };
    for (const [key, expected] of [
      ['messages', messages], ['localDiagnostics', localDiagnostics], ['headroom', headroom],
    ] as const) {
      const page = (compact['pages'] as Record<string, { inspect: { arguments: {
        path: string[]; offset: number; limit: number;
      } } }>)[key]!.inspect.arguments;
      expect(page.offset).toBe(0);
      expect(page.limit).toBe(20);
      expect(inspectPath(page.path)).toEqual(expected);
    }
  });

  it.each([
    { status: 'valid', isValid: true, terminal: true, freshValidationRequired: false },
    { status: 'invalid', isValid: false, terminal: true, freshValidationRequired: false },
    { status: 'unavailable', isValid: false, terminal: false, freshValidationRequired: true },
  ])('bounds oversized descriptor fields for $status without losing the saved-job continuation', verdict => {
    const lmcURL = `https://example.invalid/${'descriptor/'.repeat(1_200)}`;
    const full = {
      session: 'ws', workspaceId: 'ws', source: 'lmc_validation',
      ...verdict,
      jobId: 'job', payloadSha256: 'a'.repeat(64), validatedRevision: 4,
      stale: false, messages: [], localDiagnostics: [], headroom: [],
      lmc: { buildEntityNumber: 'BUILD', uuid: 'uuid', lmcURL },
    };
    const compact = projectValidationToolResult(full, { session: 'ws', jobId: 'job' });
    expect(Buffer.byteLength(JSON.stringify(compact, null, 2))).toBeLessThanOrEqual(7_500);
    expect(compact).toMatchObject({
      status: verdict.status, isValid: verdict.isValid, terminal: verdict.terminal,
      jobId: 'job', payloadSha256: 'a'.repeat(64), validatedRevision: 4,
      compacted: true,
      lmc: { buildEntityNumber: 'BUILD', uuid: 'uuid', lmcURLTruncated: true },
      pages: {
        savedJob: { inspect: { tool: 'dcsc_validation_jobs', arguments: {
          session: 'ws', jobId: 'job', path: [], offset: 0, limit: 20,
        } } },
        lmc: { lmcURL: { total: [...lmcURL].length, inspect: { arguments: {
          path: ['report', 'lmcURL'],
        } } } },
      },
    });
  });

  it('preserves a public unavailable warning through its exact saved error path', () => {
    const warning = `DCSC validation is unavailable: ${'public detail '.repeat(900)}`;
    const full = {
      session: 'ws', status: 'unavailable', isValid: false, terminal: false,
      jobId: 'job', payloadSha256: 'a'.repeat(64), validatedRevision: 4,
      stale: false, freshValidationRequired: true,
      messages: [], localDiagnostics: [], headroom: [], warning,
    };
    const compact = projectValidationToolResult(full, { session: 'ws', jobId: 'job' });
    expect(Buffer.byteLength(JSON.stringify(compact, null, 2))).toBeLessThanOrEqual(7_500);
    expect(compact).toMatchObject({
      status: 'unavailable', jobId: 'job', warningTruncated: true,
      pages: { warning: { total: [...warning].length, inspect: { arguments: {
        path: ['error', 'message'],
      } } } },
    });
    const page = projectJsonPage({ error: { message: warning } }, {
      tool: 'dcsc_validation_jobs', arguments: { session: 'ws', jobId: 'job' },
      path: ['error', 'message'], offset: 0, limit: 1_000,
    });
    expect(page['text']).toBe(warning.slice(0, 1_000));
  });

  it('falls back with exact verdict counts and saved-job lookup for combined oversized context', () => {
    const warning = `DCSC validation is unavailable: ${'公開された詳細 '.repeat(900)}`;
    const lmcURL = `https://example.invalid/${'製造検証/'.repeat(2_000)}`;
    const full = {
      session: 'ws', workspaceId: 'ws', source: 'lmc_validation',
      status: 'invalid', isValid: false, terminal: true,
      jobId: 'job', payloadSha256: 'a'.repeat(64), validatedRevision: 9,
      stale: false, freshValidationRequired: false,
      errorCount: 23, warningCount: 17, infoCount: 11,
      localErrorCount: 7, localWarningCount: 5, localInfoCount: 3,
      messages: [], localDiagnostics: [], headroom: [],
      warning,
      lmc: { buildEntityNumber: '構成'.repeat(1_000), uuid: '識別子'.repeat(1_000), lmcURL },
      futureContext: { metadata: '追加コンテキスト'.repeat(4_000) },
    };
    const compact = projectValidationToolResult(full, { session: 'ws', jobId: 'job' });
    expect(Buffer.byteLength(JSON.stringify(compact, null, 2))).toBeLessThanOrEqual(7_500);
    expect(compact).toMatchObject({
      status: 'invalid', isValid: false, terminal: true, jobId: 'job',
      payloadSha256: 'a'.repeat(64), validatedRevision: 9,
      stale: false, freshValidationRequired: false,
      errorCount: 23, warningCount: 17, infoCount: 11,
      localErrorCount: 7, localWarningCount: 5, localInfoCount: 3,
      compacted: true, contextOmitted: true,
      warningTruncated: true,
      warningInspect: { tool: 'dcsc_validation_jobs', arguments: {
        session: 'ws', jobId: 'job', path: ['error', 'message'], offset: 0, limit: 20,
      } },
      inspectSavedJob: { tool: 'dcsc_validation_jobs', arguments: {
        session: 'ws', jobId: 'job', path: [], offset: 0, limit: 20,
      } },
    });
    expect(compact).not.toHaveProperty('futureContext');
  });
});

describe('bounded report navigation', () => {
  it('enumerates more than forty messages without losing long report fields', () => {
    const source = { messages: Array.from({ length: 83 }, (_, index) => ({ code: `E${index}`, text: 'message '.repeat(50) })),
      explanation: '😀'.repeat(5000) };
    const options = { tool: 'inspect', arguments: { session: 'ws' }, path: ['messages'], offset: 0, limit: 50 };
    const codes: string[] = [];
    for (;;) {
      const page = projectJsonPage(source, options) as { items: Array<{ value: { code: string } }>; next?: { arguments: typeof options }; };
      expect(Buffer.byteLength(JSON.stringify(page, null, 2))).toBeLessThan(8000);
      codes.push(...page.items.map(item => item.value.code));
      if (!page.next) break;
      options.offset = page.next.arguments.offset;
    }
    expect(codes).toEqual(source.messages.map(message => message.code));
    let text = '';
    for (let offset = 0; offset < source.explanation.length; offset += 999) {
      const page = projectJsonPage(source, { ...options, path: ['explanation'], offset, limit: 999 });
      text += page.text;
      expect(Buffer.byteLength(JSON.stringify(page, null, 2))).toBeLessThan(8000);
    }
    expect(text).toBe(source.explanation);
    expect(() => projectJsonPage(source, { ...options, path: ['__proto__'] })).toThrow('Unknown report path');
  });

  it('uses useful chunks when a collection page links to a large string', () => {
    const source = { messages: ['😀'.repeat(5_000)] };
    const collection = projectJsonPage(source, {
      tool: 'inspect', arguments: { session: 'ws' }, path: ['messages'], offset: 0, limit: 20,
    }) as { items: Array<{ next: { arguments: { path: string[]; limit: number } } }> };
    expect(collection.items[0]!.next.arguments).toMatchObject({
      path: ['messages', '0'], limit: 1000,
    });
    const first = projectJsonPage(source, {
      tool: 'inspect', arguments: { session: 'ws' }, ...collection.items[0]!.next.arguments, offset: 0,
    });
    expect((first['text'] as string).length).toBe(1000);
    expect(Buffer.byteLength(JSON.stringify(first, null, 2))).toBeLessThan(7_500);
  });
});
