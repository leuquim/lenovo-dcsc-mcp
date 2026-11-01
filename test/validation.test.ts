import { describe, expect, it } from 'vitest';

import {
  collectLocalDiagnostics,
  parseLmcValidationResult,
  summariseValidation,
  type LmcValidationStart,
} from '../src/domain/validate.js';

const invalidResult = [
  [
    'INFO - Slot Adapter Check Start=========================================',
    ...Array.from({ length: 21 }, (_, index) =>
      index === 0
        ? 'ERROR - Derive Table B923-7D73-VGA_FILLER: required filler should be found'
        : `ERROR - Captured manufacturing rule ${index + 1} failed`,
    ),
    'INFO - Order Completed COV and TOPOLOGY processing with 0 warnings, 21 errors.',
  ].join('\n'),
];

const descriptors = [
  {
    buildEntityNumber: 'B923143235420227',
    uuid: '28700f72-bc3c-4527-ae0c-590b84745901',
    lmcURL: 'https://example.invalid/lmc/',
  },
];

describe('manufacturing validation job', () => {
  it('parses the captured manufacturing report as 21 authoritative errors', () => {
    const result = parseLmcValidationResult(start(), invalidResult);
    const errors = result.messages.filter((message) => message.severity === 'error');

    expect(result.status).toBe('invalid');
    expect(result.terminal).toBe(true);
    expect(result.isValid).toBe(false);
    expect(errors).toHaveLength(21);
    expect(errors[0]?.message).toContain('VGA_FILLER');
    expect(result.resultRaw).toEqual(invalidResult);
  });

  it.each([
    [['No Data Found'], 'pending'],
    [['Time Out'], 'unavailable'],
    [[], 'pending'],
    [[{ unexpected: true }], 'unknown'],
    [['finish', { unexpected: true }], 'unknown'],
  ] as const)('never treats %j as a valid result', (raw, status) => {
    const result = parseLmcValidationResult(start(), raw);
    expect(result.status).toBe(status);
    expect(result.isValid).toBe(false);
  });
});

describe('local validation diagnostics', () => {
  it('collects top-level, section and storage-wizard messages with their source paths', () => {
    const diagnostics = collectLocalDiagnostics([
      {
        configurationId: 'cfg1',
        raw: {
          expansionMessages: [{ type: 'warn', message: 'top warning' }],
          tabs: [
            {
              subTabs: [
                {
                  sections: [
                    {
                      name: 'MEMORY',
                      errors: [{ code: 'E1', message: 'memory invalid' }],
                    },
                  ],
                },
              ],
            },
          ],
          storageWizard: {
            errors: [
              {
                errorType: 'STORAGE_WIZARD',
                messageKey: 'storage.wizard.rule.can.not.execute',
                message: 'Storage wizard rule execute condition invalid.',
              },
            ],
          },
        },
      },
    ]);

    expect(diagnostics).toHaveLength(3);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'warning', message: 'top warning' }),
        expect.objectContaining({
          severity: 'error',
          code: 'E1',
          message: 'memory invalid',
          section: 'MEMORY',
          sourcePath: '$.tabs[0].subTabs[0].sections[0].errors[0]',
        }),
        expect.objectContaining({
          severity: 'error',
          message: 'Storage wizard rule execute condition invalid.',
          sourcePath: '$.storageWizard.errors[0]',
        }),
      ]),
    );
  });

  it('keeps local diagnostics separate and never validates without a terminal result', () => {
    const local = [
      { severity: 'error' as const, message: 'local error', configurationId: 'cfg1' },
    ];
    const validServer = parseLmcValidationResult(start(), ['finish']);

    expect(summariseValidation(validServer, local)).toMatchObject({
      status: 'valid',
      isValid: false,
      errorCount: 0,
      localErrorCount: 1,
      messages: [],
      localDiagnostics: local,
    });
    expect(summariseValidation(undefined, [])).toMatchObject({
      status: 'unavailable',
      isValid: false,
    });
  });
});

function start(): LmcValidationStart {
  return {
    ...descriptors[0],
    raw: descriptors,
    descriptors,
  };
}
