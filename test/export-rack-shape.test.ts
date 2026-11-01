import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { buildRackHierarchy, physicalRackData } from '../src/domain/workspaceWire.js';
import {
  collectLocalDiagnostics,
  summariseValidation,
} from '../src/domain/validate.js';
import { localeFromOption, type LocaleOption } from '../src/domain/locale.js';
import type { RawConfiguration } from '../src/model/types.js';

describe('rack export dual-shape transforms', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/rack-export.json', import.meta.url), 'utf8')) as {
    physical: Array<Record<string, unknown>>; hierarchy: Array<Record<string, unknown>>;
  };
  it('matches the captured slim hierarchy with manufacturing placement features', () => {
    expect(fixture.physical.map((rack, index) => buildRackHierarchy(rack, index))).toEqual(fixture.hierarchy);
  });
  it('preserves physical one-based positions independently of the hierarchy', () => {
    const before = structuredClone(fixture.physical[0]!);
    const physical = physicalRackData(before);
    expect(physical).toEqual(before);
    expect(physical).not.toBe(before);
    expect(physical.servers).toBeUndefined();
    expect((physical.rackItems as Array<Record<string, unknown>>)[0]?.position).toBe(1);
  });
  it('does not pretend an obsolete local servers shape is authoritative physical data', () => {
    expect(() => physicalRackData({ servers: [] })).toThrow('reconciliation');
  });
});

describe('validation reducers', () => {
  it('collects expansionMessages by severity from raw configs', () => {
    const msgs = collectLocalDiagnostics([
      {
        configurationId: 'cfg1',
        raw: {
          expansionMessages: [
            { type: 'error', text: 'bad', code: 'E1', sectionName: 'MEMORY' },
            { type: 'warn', text: 'careful', code: 'W1' },
            { type: 'info', message: 'ok' },
          ],
        },
      },
    ]);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toMatchObject({
      severity: 'error',
      message: 'bad',
      section: 'MEMORY',
      configurationId: 'cfg1',
    });
    expect(msgs[1]?.severity).toBe('warning');
    expect(msgs[2]?.severity).toBe('info');
  });

  it('does not treat an LMC handoff with no terminal result as valid', () => {
    const report = summariseValidation(
      {
        buildEntityNumber: 'B1', uuid: 'u', lmcURL: 'https://x', raw: [], descriptors: [],
        status: 'pending', terminal: false, isValid: false, messages: [],
      },
      [
        { severity: 'warning', message: 'w' },
        { severity: 'info', message: 'i' },
      ],
    );
    expect(report.isValid).toBe(false);
    expect(report.localWarningCount).toBe(1);
    expect(report.server?.buildEntityNumber).toBe('B1');
  });
});

describe('localeFromOption', () => {
  it('prefers defaulted language and builds cohesive Locale', () => {
    const opt: LocaleOption = {
      countryCode: 'DE',
      countryName: 'Germany',
      currency: 'EUR',
      region: 'EMEA',
      languages: [
        { languageCode: 'en', languageName: 'English', defaulted: false },
        { languageCode: 'de', languageName: 'German', defaulted: true },
      ],
      countryInvalid: false,
    };
    expect(localeFromOption(opt)).toEqual({
      country: 'DE',
      geo: 'EMEA',
      language: 'de',
      currency: 'EUR',
    });
    expect(localeFromOption(opt, 'en').language).toBe('en');
  });
});

describe('reduceConfiguration fabric fields', () => {
  it('reads selectedTopologies and nodeRole from raw instead of wiping them', () => {
    const raw = {
      tabs: [],
      code: '7DM9CTO1WW',
      selectedTopologies: { cfg1: 'IB_XDR' },
      nodeRole: 'Compute',
    } as unknown as RawConfiguration;
    const reduced = reduceConfiguration(raw, 'cfg1', 'cto', 'HPC and AI - Systems');
    expect(reduced.selectedTopologies).toEqual({ cfg1: 'IB_XDR' });
    expect(reduced.nodeRole).toBe('Compute');
  });

  it('defaults fabric fields when raw has none', () => {
    const raw = { tabs: [], code: 'X' } as unknown as RawConfiguration;
    const reduced = reduceConfiguration(raw, 'id', 'cto', 'General Purpose');
    expect(reduced.selectedTopologies).toEqual({});
    expect(reduced.nodeRole).toBe('');
  });
});
