import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import {
  mandatoryVerifyConfig,
  type VerifyMandatorySoftwareInput,
} from '../src/domain/mandatorySoftware.js';
import { DcscContractDriftError } from '../src/http/errors.js';

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

const sampleCtoInput: VerifyMandatorySoftwareInput = {
  mode: 'cto',
  configuration: {
    id: 'cfg-test-101',
    code: '7D73CTO1WW',
    sections: [
      {
        name: 'Operating System',
        features: [],
      },
    ],
    asMultiProd: false,
    workspaceId: 'ws-123',
  },
};

const sampleLfoInput: VerifyMandatorySoftwareInput = {
  mode: 'lfo',
  configuration: {
    id: 'cfg-lfo-202',
    code: '7D73A001NA',
    ctoCode: '7D73CTO1WW',
    lfoCode: '7D73A001NA',
    sections: [],
  },
};

describe('R3: Mandatory Software Selection Check (mandatoryVerifyConfig)', () => {
  it('posts CTO configuration to /cto/mandatory/sw/selection', async () => {
    const service = setupService();
    const mockResponse = {
      status: true,
      message: 'Select software swType Or subCategory is valid',
      tabs: [
        {
          description: 'Operating System',
          subTabs: [
            { description: 'Microsoft Windows Server' },
            { description: 'Red Hat Enterprise Linux' },
          ],
        },
        {
          description: 'Hypervisor',
          subTabs: [{ description: 'VMware vSphere' }],
        },
      ],
    };

    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: mockResponse,
      requestId: 'req-sw-1',
    } as never);

    const result = await mandatoryVerifyConfig(service.http, service.newCtx(), sampleCtoInput);

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'cto_mandatory_sw_selection',
        method: 'POST',
        path: '/cto/mandatory/sw/selection',
        body: expect.objectContaining({
          kind: 'json',
          value: expect.objectContaining({
            id: 'cfg-test-101',
            ctoCode: '7D73CTO1WW',
          }),
        }),
        timeoutClass: 'fast',
      }),
    );

    expect(result.showVerifyConfig).toBe(true);
    expect(result.status).toBe(true);
    expect(result.message).toBe('Select software swType Or subCategory is valid');
    expect(result.tabs).toHaveLength(2);

    // Verify OS tab and introductions
    const osTab = result.tabs.find((t) => t.description === 'Operating System');
    expect(osTab).toBeDefined();
    expect(osTab?.introduce).toBe('(An OS is needed to run applications on a server)');
    expect(osTab?.subTabs[0]?.label).toBe('Microsoft Windows Server');
    expect(osTab?.subTabs[0]?.value).toEqual({
      tabDescription: 'Operating System',
      subTabDescription: 'Microsoft Windows Server',
    });

    // Verify Hypervisor tab and introductions
    const hypTab = result.tabs.find((t) => t.description === 'Hypervisor');
    expect(hypTab).toBeDefined();
    expect(hypTab?.introduce).toBe('(A Hypervisor is needed to create virtual machines)');
    expect(hypTab?.subTabs[0]?.label).toBe('VMware vSphere');
    expect(hypTab?.subTabs[0]?.value).toEqual({
      tabDescription: 'Hypervisor',
      subTabDescription: 'VMware vSphere',
    });
  });

  it('posts LFO configuration to /lfo/mandatory/sw/selection with lfoCode set', async () => {
    const service = setupService();
    const mockResponse = {
      status: false,
      message: null,
      tabs: [],
    };

    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: mockResponse,
      requestId: 'req-sw-2',
    } as never);

    const result = await mandatoryVerifyConfig(service.http, service.newCtx(), sampleLfoInput);

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'lfo_mandatory_sw_selection',
        method: 'POST',
        path: '/lfo/mandatory/sw/selection',
        body: expect.objectContaining({
          kind: 'json',
          value: expect.objectContaining({
            lfoCode: '7D73A001NA',
            ctoCode: '7D73CTO1WW',
          }),
        }),
      }),
    );

    expect(result.showVerifyConfig).toBe(false);
    expect(result.status).toBe(false);
    expect(result.message).toBeNull();
    expect(result.tabs).toHaveLength(0);
  });

  it('handles null tabs returned by live upstream when status is false', async () => {
    const service = setupService();
    const liveNullTabsResponse = {
      status: false,
      message: 'function not work now',
      tabs: null,
    };

    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: liveNullTabsResponse,
      requestId: 'req-live-null',
    } as never);

    const result = await mandatoryVerifyConfig(service.http, service.newCtx(), sampleCtoInput);
    expect(result.status).toBe(false);
    expect(result.showVerifyConfig).toBe(false);
    expect(result.message).toBe('function not work now');
    expect(result.tabs).toEqual([]);
  });

  it('preserves existing tab introduction text if upstream provides one', async () => {
    const service = setupService();
    const mockResponse = {
      status: true,
      tabs: [
        {
          description: 'Operating System',
          introduce: 'Custom OS guidance from upstream',
          subTabs: [{ description: 'Ubuntu Server' }],
        },
      ],
    };

    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: mockResponse,
      requestId: 'req-sw-3',
    } as never);

    const result = await mandatoryVerifyConfig(service.http, service.newCtx(), sampleCtoInput);

    expect(result.showVerifyConfig).toBe(true);
    expect(result.tabs[0]?.introduce).toBe('Custom OS guidance from upstream');
    expect(result.tabs[0]?.subTabs[0]?.label).toBe('Ubuntu Server');
  });

  it('does not annotate subTabs when status is false (software satisfied)', async () => {
    const service = setupService();
    const mockResponse = {
      status: false,
      tabs: [
        {
          description: 'Operating System',
          subTabs: [{ description: 'Windows Server 2022' }],
        },
      ],
    };

    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: mockResponse,
      requestId: 'req-sw-4',
    } as never);

    const result = await mandatoryVerifyConfig(service.http, service.newCtx(), sampleCtoInput);

    expect(result.showVerifyConfig).toBe(false);
    expect(result.tabs[0]?.introduce).toBeUndefined();
    expect(result.tabs[0]?.subTabs[0]?.label).toBeUndefined();
    expect(result.tabs[0]?.subTabs[0]?.value).toBeUndefined();
  });

  it('rejects invalid configuration inputs missing mandatory fields', async () => {
    const service = setupService();

    const missingId = {
      mode: 'cto' as const,
      configuration: { id: '', code: '7D73CTO1WW', sections: [] },
    };
    await expect(mandatoryVerifyConfig(service.http, service.newCtx(), missingId)).rejects.toThrow();

    const missingCode = {
      mode: 'cto' as const,
      configuration: { id: 'cfg-1', code: '', sections: [] },
    };
    await expect(mandatoryVerifyConfig(service.http, service.newCtx(), missingCode)).rejects.toThrow();
  });

  it('throws DcscContractDriftError when upstream status is not a boolean or response is malformed', async () => {
    const service = setupService();
    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: {
        status: 'not-a-boolean',
        tabs: [],
      },
      requestId: 'req-sw-drift',
    } as never);

    await expect(
      mandatoryVerifyConfig(service.http, service.newCtx(), sampleCtoInput),
    ).rejects.toThrow(DcscContractDriftError);
  });
});
