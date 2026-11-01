import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { defaultExportTypes } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';

// Anonymous headless GET /api/solution_modes, captured 2026-10-15.
const modes = JSON.parse(readFileSync(new URL('./fixtures/parity/solution-modes.json', import.meta.url), 'utf8')) as unknown[];
type Reply = { content: Array<{ text: string }>; isError?: boolean };

async function inspectModes(raw: unknown) {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false } }));
  try {
    vi.spyOn(service.http, 'send').mockResolvedValue({ raw } as never);
    let handler: ((args: Record<string, unknown>) => Promise<Reply>) | undefined;
    registerTools({ registerTool(name: string, _definition: unknown, callback: (args: Record<string, unknown>) => Promise<Reply>) {
      if (name === 'dcsc_settings_get') handler = callback;
      return { remove() {}, update() {} };
    } } as unknown as McpServer, service);
    const reply = await handler!({});
    expect(reply.isError).not.toBe(true);
    expect(Buffer.byteLength(reply.content[0]!.text)).toBeLessThan(8000);
    return JSON.parse(reply.content[0]!.text) as { solutionModes: Array<Record<string, unknown>> };
  } finally { await service.close(); }
}

describe('website mode capability discovery', () => {
  it('retains UI labels and the exact GP versus AI/HPC function differences', async () => {
    const result = await inspectModes(modes);
    expect(result.solutionModes).toEqual([
      expect.objectContaining({ mode: 'General Purpose', description: 'General Purpose',
        websiteFunctions: expect.objectContaining({ Preference: false, AutoConnection: false, AutoArrange: false }) }),
      expect.objectContaining({ mode: 'HPC and AI - Systems', description: 'AI & HPC – ThinkSystem Hardware',
        websiteFunctions: expect.objectContaining({ Preference: true, AutoConnection: true, AutoArrange: true }) }),
    ]);
  });

  it('does not invent capability values when the upstream response omits them', async () => {
    const result = await inspectModes([{ mode: 'General Purpose', masterSlices: ['GP'] }]);
    expect(result.solutionModes).toEqual([{ mode: 'General Purpose', masterSlices: ['GP'] }]);
  });
});

describe('mode-aware export defaults and cache coalescing', () => {
  const functions = (index: number) =>
    (modes[index] as { systemFunctionList: Record<string, boolean> }).systemFunctionList;

  it('offers Quote in General Purpose and the HPC-only reports in HPC, from the mode switches', () => {
    const gp = defaultExportTypes(functions(0));
    const hpc = defaultExportTypes(functions(1));
    expect(gp).toContain('QUOTE');
    expect(gp).not.toEqual(expect.arrayContaining(['QUOTE_REFERENCE']));
    expect(gp).not.toContain('P2P_BY_RACK');
    expect(gp).not.toContain('VLH');
    expect(hpc).toEqual(expect.arrayContaining(['QUOTE_REFERENCE', 'P2P_BY_RACK', 'VLH', 'P2P_REPORT']));
    expect(hpc).not.toContain('QUOTE');
    expect(hpc).not.toContain('QUOTE_CSV');
  });

  it('shares one in-flight solution_modes fetch between concurrent callers and keeps no failure', async () => {
    const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false } }));
    try {
      const send = vi.spyOn(service.http, 'send').mockRejectedValueOnce(new Error('upstream down'))
        .mockResolvedValue({ raw: modes } as never);
      const ctx = service.newCtx();
      const failed = await Promise.allSettled([service.solutionModes(ctx), service.solutionModes(ctx)]);
      expect(failed.map(entry => entry.status)).toEqual(['rejected', 'rejected']);
      expect(send).toHaveBeenCalledTimes(1);
      const [first, second] = await Promise.all([service.solutionModes(ctx), service.solutionModes(ctx)]);
      expect(second).toBe(first);
      expect(send).toHaveBeenCalledTimes(2);
      await expect(service.defaultExportTypes({ solutionMode: 'HPC and AI - Systems', masterSlices: [] }))
        .resolves.toContain('VLH');
    } finally { await service.close(); }
  });
});
