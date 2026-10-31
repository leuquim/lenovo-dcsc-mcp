import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import {
  fetchAiRecommendCtos,
  fetchAiFeatureCompat,
  fetchAiBladeRecommendation,
} from '../src/domain/aiConfigurator.js';

const services: DcscService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});

function setupService() {
  const service = new DcscService(
    ConfigSchema.parse({ logLevel: 'silent', files: { persistSessions: false } }),
  );
  services.push(service);
  vi.spyOn(service, 'resolveSolution').mockResolvedValue({
    solutionMode: 'General Purpose',
    masterSlices: ['GP'],
  });
  return service;
}

describe('R6: Nightingale AI Configurator Endpoints', () => {
  it('fetches AI CTO recommendations via /ai-acceler prefix', async () => {
    const service = setupService();
    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: {
        code: 200,
        message: 'Success',
        data: [
          { ctoCode: '7A59CTO1WW', description: 'ThinkSystem SR650 V3 AI Optimized' },
        ],
      },
      requestId: 'req-ai-1',
    } as never);

    const result = await fetchAiRecommendCtos(service.http, service.newCtx(), {
      prompt: 'Recommend a rack server for AI training',
      mode: 'balanced',
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.ctoCode).toBe('7A59CTO1WW');
  });

  it('validates feature compatibility via AI endpoint', async () => {
    const service = setupService();
    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: {
        code: 200,
        data: [
          { sectionName: 'Processors', results: [{ code: 'P1', quantity: 2 }] },
        ],
      },
      requestId: 'req-ai-2',
    } as never);

    const result = await fetchAiFeatureCompat(service.http, service.newCtx(), {
      ctoCode: '7A59CTO1WW',
      selections: [{ sectionName: 'Processors', results: [{ code: 'P1', quantity: 2 }] }],
      candidates: [{ sectionName: 'Memory', results: [{ code: 'M1', quantity: 8 }] }],
    });

    expect(result.validated).toHaveLength(1);
    expect(result.validated[0]?.sectionName).toBe('Processors');
  });

  it('fetches blade recommendations via AI endpoint', async () => {
    const service = setupService();
    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: {
        code: 200,
        data: {
          isBladeConfig: true,
          bladeRecommendations: {
            Chassis: { userSelectionBlade: true, details: [] },
          },
        },
      },
      requestId: 'req-ai-3',
    } as never);

    const result = await fetchAiBladeRecommendation(service.http, service.newCtx(), {
      configurationId: 'cfg-123',
      ctoCode: '7A59CTO1WW',
      userSelections: [],
    });

    expect(result.isBladeConfig).toBe(true);
    expect(result.bladeRecommendations).toHaveProperty('Chassis');
  });
});
