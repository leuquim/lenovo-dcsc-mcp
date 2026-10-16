import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';
import type { RawConfiguration } from '../src/model/types.js';

describe('section-scoped configure acceptance', () => {
  it('does not confuse the same maintenance code selected in another software product', async () => {
    const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false } }));
    try {
      const section = (name: string, group: string, value: string) => ({
        name, productNumber: name, selectedItems: [group], multipleSelectable: false,
        groups: [{ code: group, description: group, hardMandatory: false,
          filters: [{ name: 'DURATION', productNumber: name, value, quantity: 1,
            items: [{ code: 'YEAR3', productNumber: name }, { code: 'YEAR5', productNumber: name }] }] }],
        results: [],
      });
      const raw: RawConfiguration = { id: 'cfg', sliceCtoCode: 'server', totalPrice: 100, quantity: 1,
        tabs: [{ title: 'Software', type: 'software', subTabs: [{ title: 'Licences',
          sections: [section('A', 'GROUP-A', 'YEAR3'), section('B', 'GROUP-B', 'YEAR5')] }] }] };
      const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };
      const session = service.sessions.create({ locale: service.locale, solution, mode: 'cto',
        raw, configurationId: 'cfg', reduced: reduceConfiguration(raw,'cfg'), primed: true });
      const returned = structuredClone(raw);
      const first = returned.tabs![0]!.subTabs![0]!.sections![0]!;
      (first.groups as Array<{filters:Array<{value:string}>}>)[0]!.filters[0]!.value = 'YEAR5';
      vi.spyOn(service.http,'send').mockResolvedValue({ raw: { configurations: [returned] } } as never);
      const handlers = new Map<string, (args: unknown) => Promise<{content:Array<{text:string}>;isError?:boolean}>>();
      registerTools({ registerTool(name: string,_config: unknown,handler: never) {
        handlers.set(name,handler); return {remove(){},update(){}};
      } } as unknown as McpServer, service);
      const target = session.index.sections.find(item=>item.name==='A/GROUP-A/DURATION')!;
      const reply = await handlers.get('dcsc_configure')!({ session:session.id,
        changes:[{section:target.id,code:'YEAR5',quantity:1}], expectedRevision:session.revision });
      expect(reply.isError).not.toBe(true);
      const body = JSON.parse(reply.content[0]!.text);
      expect(body.notApplied).toBeUndefined();
      expect(body.partiallyApplied).toBe(false);
      expect(body.applied).toBe(true);
    } finally { await service.close(); }
  });
});
