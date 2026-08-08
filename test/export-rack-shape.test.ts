import { describe, expect, it } from 'vitest';
import {
  rackToLocalExportShape,
  rackToServerExportShape,
  reduceConfiguration,
} from '../src/domain/reduce.js';
import {
  collectExpansionMessages,
  summariseValidation,
} from '../src/domain/validate.js';
import { localeFromOption, type LocaleOption } from '../src/domain/locale.js';
import type { RawConfiguration } from '../src/model/types.js';

describe('rack export dual-shape transforms', () => {
  it('converts customize (1-based rackItems) to SPA local (0-based servers)', () => {
    const serverForm = {
      id: 'rack1',
      code: '7D6DCTO1WW',
      rackItems: [{ id: 'n1', code: '7DM9CTO1WW', position: 3, size: 8 }],
      featureItems: [{ code: 'C0CS', position: 2 }],
      lockedSpace: [1, 5],
    };
    const local = rackToLocalExportShape(serverForm);
    expect(local['servers']).toEqual([
      expect.objectContaining({ id: 'n1', position: 2 }),
    ]);
    expect(local['rackItems']).toBeUndefined();
    expect((local['featureItems'] as Array<{ position: number }>)[0]?.position).toBe(1);
    expect(local['lockedSpace']).toEqual([0, 4]);
  });

  it('round-trips local servers back to 1-based rackItems', () => {
    const local = rackToLocalExportShape({
      id: 'rack1',
      rackItems: [{ id: 'n1', position: 3, size: 8 }],
      lockedSpace: [2],
    });
    const server = rackToServerExportShape(local);
    expect(server['rackItems']).toEqual([
      expect.objectContaining({ id: 'n1', position: 3 }),
    ]);
    expect(server['servers']).toBeUndefined();
    expect(server['lockedSpace']).toEqual([2]);
  });
});

describe('validation reducers', () => {
  it('collects expansionMessages by severity from raw configs', () => {
    const msgs = collectExpansionMessages([
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

  it('summariseValidation treats only errors as invalid', () => {
    const report = summariseValidation(
      { buildEntityNumber: 'B1', uuid: 'u', lmcURL: 'https://x', raw: [] },
      [
        { severity: 'warning', message: 'w' },
        { severity: 'info', message: 'i' },
      ],
    );
    expect(report.isValid).toBe(true);
    expect(report.warningCount).toBe(1);
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
