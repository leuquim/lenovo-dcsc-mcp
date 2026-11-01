import { describe, expect, it, vi } from 'vitest';

import {
  isValidationJobStale,
  loadValidationJobs,
  runValidationJob,
  saveValidationJob,
  validationPayloadSha256,
  validationResultFromJob,
  type ValidationJob,
} from '../src/domain/validationJobs.js';
import type { DcscHttpClient, RequestCtx, SendInput } from '../src/http/request.js';

const descriptors = [{
  buildEntityNumber: 'B923143235420227',
  uuid: '28700f72-bc3c-4527-ae0c-590b84745901',
  lmcURL: 'https://example.invalid/lmc/',
}];
const ctx = {
  corrId: 'validation-job-test',
  locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
  solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
} satisfies RequestCtx;

function http(send: (input: SendInput) => Promise<{ raw: unknown }>): DcscHttpClient {
  return { send } as unknown as DcscHttpClient;
}

describe('persisted validation jobs', () => {
  it('hashes the semantic start body deterministically and includes mode', () => {
    const left = validationPayloadSha256({ z: 1, nested: { b: 2, a: 1 } }, 'cto');
    const right = validationPayloadSha256({ nested: { a: 1, b: 2 }, z: 1 }, 'cto');
    expect(left).toBe(right);
    expect(validationPayloadSha256({ z: 1, nested: { a: 1, b: 2 } }, 'lfo')).not.toBe(left);
    expect(validationPayloadSha256({ z: 2, nested: { a: 1, b: 2 } }, 'cto')).not.toBe(left);
  });

  it('persists descriptors before making exactly one result request and records terminal success', async () => {
    const calls: SendInput[] = [];
    const snapshots: ValidationJob[] = [];
    let tick = 1000;
    const job = await runValidationJob(
      http(async (input) => {
        calls.push(input);
        return { raw: calls.length === 1 ? descriptors : ['finish'] };
      }),
      ctx,
      { configurations: [{ id: 'cfg-1' }] },
      'cto',
      { validatedRevision: 7, now: () => tick++, onUpdate: (value) => { snapshots.push(value); } },
    );

    expect(calls.map((call) => call.path)).toEqual(['/lmc_validation', '/lmc_validation/result']);
    expect(calls[1]?.body).toEqual({ kind: 'json', value: descriptors });
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]).toMatchObject({ status: 'pending', descriptors });
    expect(snapshots[0]).not.toHaveProperty('resultRequestedAt');
    expect(snapshots[1]).toMatchObject({ status: 'pending', descriptors, resultRequestedAt: 1002 });
    expect(job).toMatchObject({
      validatedRevision: 7, status: 'valid', terminal: true,
      freshValidationRequired: false, descriptors, resultRaw: ['finish'],
      descriptorReceivedAt: 1001, resultRequestedAt: 1002, resultReceivedAt: 1003,
      completedAt: 1003,
    });
    expect(isValidationJobStale(job, 7, job.payloadSha256)).toBe(false);
    expect(isValidationJobStale(job, 8, job.payloadSha256)).toBe(true);
    expect(validationResultFromJob(job)).toMatchObject({
      status: 'valid', isValid: true, buildEntityNumber: descriptors[0]?.buildEntityNumber,
    });
  });

  it('records a terminal authoritative error report without converting it to success', async () => {
    const report = [
      'INFO - Slot Adapter Check Start\n' +
      Array.from({ length: 21 }, (_, i) => `ERROR - Captured manufacturing rule ${i + 1} failed`).join('\n') +
      '\nINFO - Order Completed with 21 errors.',
    ];
    let call = 0;
    const job = await runValidationJob(
      http(async () => ({ raw: call++ === 0 ? descriptors : report })),
      ctx, {}, 'cto', { validatedRevision: 2 },
    );
    expect(job).toMatchObject({ status: 'invalid', terminal: true, freshValidationRequired: false });
    expect(job.resultRaw).toEqual(report);
  });

  it.each([
    { raw: ['No Data Found'], observedStatus: 'pending' },
    { raw: ['Time Out'], observedStatus: 'unavailable' },
    { raw: [{ unexpected: true }], observedStatus: 'unknown' },
  ])('makes a non-terminal $observedStatus result unavailable and fresh-required', async ({ raw, observedStatus }) => {
    let call = 0;
    const job = await runValidationJob(
      http(async () => ({ raw: call++ === 0 ? descriptors : raw })),
      ctx, {}, 'cto', { validatedRevision: 1 },
    );
    expect(job).toMatchObject({
      status: 'unavailable', observedStatus, terminal: false, freshValidationRequired: true,
      descriptors,
    });
  });

  it('requires a fresh validation when the start request fails', async () => {
    const job = await runValidationJob(
      http(async () => { throw new Error('upstream 500'); }),
      ctx, {}, 'cto', { validatedRevision: 1 },
    );
    expect(job).toMatchObject({
      status: 'unavailable', terminal: false, freshValidationRequired: true,
      error: { phase: 'start' },
    });
  });

  it('enforces its deadline even when the HTTP adapter ignores abort', async () => {
    let call = 0;
    const job = await runValidationJob(
      http(async () => {
        if (call++ === 0) return { raw: descriptors };
        return new Promise(() => undefined);
      }),
      ctx, {}, 'cto', { validatedRevision: 1, deadlineMs: 15 },
    );
    expect(job).toMatchObject({
      status: 'unavailable', terminal: false, freshValidationRequired: true,
      error: { phase: 'result', message: expect.stringMatching(/deadline/i) },
    });
  });

  it('honors caller cancellation and never retries the result request', async () => {
    const controller = new AbortController();
    const send = vi.fn(async () => {
      if (send.mock.calls.length === 1) return { raw: descriptors };
      controller.abort(new Error('caller stopped'));
      return new Promise<{ raw: unknown }>(() => undefined);
    });
    const job = await runValidationJob(
      http(send), { ...ctx, signal: controller.signal }, {}, 'cto',
      { validatedRevision: 1, deadlineMs: 1000 },
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(job).toMatchObject({
      status: 'unavailable', freshValidationRequired: true,
      error: { phase: 'result', message: 'caller stopped' },
    });
  });

  it('normalizes interrupted persisted jobs and upserts bounded state without changing identity', () => {
    const pending = job({ status: 'pending', terminal: false, freshValidationRequired: false });
    const terminal = job({ id: 'terminal', status: 'valid', terminal: true, projection: {
      localDiagnostics: [{ severity: 'warning', message: 'retained after restart' }],
      headroom: [{ configuration: 'session', productCode: 'NODE', constraints: [{ name: 'Memory' }], breached: [] }],
      rackDataOmitted: false,
      validatedScope: { scope: 'configuration', configurations: 1, racksInSolution: 0,
        racksValidated: 0, covers: 'One configuration.' },
    } });
    let state = saveValidationJob({ opaque: { kept: true } }, pending, 2);
    state = saveValidationJob(state, terminal, 2);
    state = saveValidationJob(state, { ...pending, descriptors }, 2);

    const restored = loadValidationJobs(state, 9000);
    expect(state['opaque']).toEqual({ kept: true });
    expect(restored).toHaveLength(2);
    expect(restored.find((value) => value.id === pending.id)).toMatchObject({
      status: 'unavailable', freshValidationRequired: true, completedAt: 9000,
      error: { phase: 'result', message: expect.stringMatching(/interrupted/i) },
    });
    expect(restored.find((value) => value.id === terminal.id)).toMatchObject({
      status: 'valid', terminal: true,
      projection: {
        localDiagnostics: [{ message: 'retained after restart' }],
        headroom: [{ productCode: 'NODE' }],
      },
    });
  });
});

function job(overrides: Partial<ValidationJob> = {}): ValidationJob {
  return {
    version: 1, id: 'job-1', payloadSha256: 'a'.repeat(64), validatedRevision: 4,
    mode: 'cto', status: 'pending', terminal: false, freshValidationRequired: false,
    descriptors: [], startedAt: 100,
    ...overrides,
  };
}
