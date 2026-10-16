import { describe, expect, it } from 'vitest';

import { hardwareEndpointFamily, hardwareModeFamily, usesCtoWire } from '../src/domain/modeFamily.js';
import { workspaceHardwareMode } from '../src/domain/workspaceWire.js';

describe('hardware mode family', () => {
  it.each([
    ['cto', 'cto', 'ctos', true],
    ['lfo-as-cto', 'cto', 'ctos', true],
    ['lfo', 'lfo', 'lfos', false],
    ['lfo-add-options', 'lfo', 'lfos', false],
  ] as const)('maps %s without changing the stored display mode', (mode, family, endpoint, ctoWire) => {
    expect(hardwareModeFamily(mode)).toBe(family);
    expect(hardwareEndpointFamily(mode)).toBe(endpoint);
    expect(usesCtoWire(mode)).toBe(ctoWire);
  });

  it('accepts CTO and as-CTO sessions in one CTO-family workspace', () => {
    expect(workspaceHardwareMode([{ mode: 'cto' }, { mode: 'lfo-as-cto' }])).toBe('cto');
  });

  it('still rejects a true CTO/LFO family mix', () => {
    expect(() => workspaceHardwareMode([{ mode: 'lfo-as-cto' }, { mode: 'lfo' }]))
      .toThrow(/Mixed CTO and LFO hardware/);
  });
});
