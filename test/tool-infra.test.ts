import { describe, expect, it } from 'vitest';

import { RESPONSE_BYTE_BUDGET } from '../src/config/constants.js';
import { queryDiscoveryHelper } from '../src/domain/discoveryHelpers.js';
import { buildHttpError } from '../src/http/errors.js';
import { ok } from '../src/mcp/toolSupport.js';

describe('tool response infrastructure', () => {
  it('emits compact JSON', () => {
    expect(ok({ a: [1, 2], b: { c: 'x' } }).content[0]?.text).toBe('{"a":[1,2],"b":{"c":"x"}}');
  });

  it('refuses a response over the central byte budget', () => {
    expect(() => ok({ text: 'x'.repeat(RESPONSE_BYTE_BUDGET) })).toThrow(/byte budget/);
  });

  it('bounds and redacts a 4xx problem detail before it reaches the agent', () => {
    const detail = `bad value at http://cto-rule-engine.earth-us.xpaas.lenovo.com/x ${'y'.repeat(1000)}`;
    const error = buildHttpError({
      status: 400,
      method: 'GET',
      endpoint: 'test',
      contentType: 'application/problem+json',
      body: { detail },
      requestId: undefined,
      traceId: undefined,
      corrId: 'corr-1',
      logRawErrors: false,
    });
    expect(error.userMessage).not.toContain('xpaas');
    expect(error.userMessage.length).toBeLessThan(400);
  });

  it('requires the product code instead of defaulting to another product', async () => {
    const http = { send: () => { throw new Error('must not call upstream'); } };
    await expect(queryDiscoveryHelper(http as never, {} as never, {
      action: 'displayOrders',
      params: { cto: '7X02CTO1WW' },
    })).rejects.toThrow(/ctoCode is required/);
  });
});
