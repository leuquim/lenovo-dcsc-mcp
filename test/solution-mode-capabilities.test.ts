import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';

// Anonymous headless GET /api/solution_modes, captured 2026-10-15.
const modes = JSON.parse(readFileSync(new URL('./fixtures/parity/solution-modes.json', import.meta.url), 'utf8')) as unknown[];
type Reply = { content: Array<{ text: string }>; isError?: boolean };

async function inspectModes(raw: unknown) {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false } }));
  try {
    vi.spyOn(service.http, 'send').mockResolvedValue({ raw } as never);
    let handler: (() => Promise<Reply>) | undefined;
    registerTools({ registerTool(name: string, _definition: unknown, callback: () => Promise<Reply>) {
      if (name === 'dcsc_solution_modes') handler = callback;
      return { remove() {}, update() {} };
    } } as unknown as McpServer, service);
    const reply = await handler!();
    expect(reply.isError).not.toBe(true);
    expect(Buffer.byteLength(reply.content[0]!.text)).toBeLessThan(8000);
    return JSON.parse(reply.content[0]!.text) as { modes: Array<Record<string, unknown>> };
  } finally { await service.close(); }
}

describe('website mode capability discovery', () => {
  it('retains UI labels and the exact GP versus AI/HPC function differences', async () => {
    const result = await inspectModes(modes);
    expect(result.modes).toEqual([
      expect.objectContaining({ mode: 'General Purpose', description: 'General Purpose',
        websiteFunctions: expect.objectContaining({ Preference: false, AutoConnection: false, AutoArrange: false }) }),
      expect.objectContaining({ mode: 'HPC and AI - Systems', description: 'AI & HPC – ThinkSystem Hardware',
        websiteFunctions: expect.objectContaining({ Preference: true, AutoConnection: true, AutoArrange: true }) }),
    ]);
  });

  it('does not invent capability values when the upstream response omits them', async () => {
    const result = await inspectModes([{ mode: 'General Purpose', masterSlices: ['GP'] }]);
    expect(result.modes).toEqual([{ mode: 'General Purpose', masterSlices: ['GP'] }]);
  });
});
