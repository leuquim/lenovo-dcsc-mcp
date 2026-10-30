import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';

describe('configuration defaults', () => {
  it('initializes nested operational settings when their sections are omitted', () => {
    const config = ConfigSchema.parse({});
    expect(config.pacing.maxConcurrency).toBe(2);
    expect(config.pacing.perToolRequestBudget).toBe(40);
    expect(config.timeouts.interactiveMs).toBe(120_000);
    expect(config.retry.maxAttempts).toBe(3);
    expect(config.breaker.failureRatio).toBe(0.5);
    expect(config.waf.ladderMs).toEqual([60_000, 300_000, 900_000, 3_600_000]);
    expect(config.files.persistSessions).toBe(true);
    expect(config.files.maxDownloadBytes).toBe(200 * 1024 * 1024);
  });

  it('fills partial sections while retaining and validating explicit overrides', () => {
    const config = ConfigSchema.parse({ pacing: { maxConcurrency: 4 }, files: { persistSessions: false } });
    expect(config.pacing.maxConcurrency).toBe(4);
    expect(config.pacing.perToolRequestBudget).toBe(40);
    expect(config.files.persistSessions).toBe(false);
    expect(config.files.maxDownloadBytes).toBe(200 * 1024 * 1024);
    expect(ConfigSchema.safeParse({ pacing: { maxConcurrency: 0 } }).success).toBe(false);
  });
});
