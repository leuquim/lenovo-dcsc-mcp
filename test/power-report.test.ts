import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractPowerReport } from '../src/domain/power.js';
import type { RawConfiguration } from '../src/model/types.js';

const captured = JSON.parse(readFileSync(new URL('./fixtures/parity/sr630-launch.json', import.meta.url), 'utf8')) as RawConfiguration;

describe('numeric power availability', () => {
  it('preserves the captured report instead of substituting estimates', () => {
    expect(extractPowerReport(captured)).toMatchObject({ inputPowerW: { loadFactor: 166.3 } });
  });

  it.each(['absent-band', 'missing', 'null', 'blank', 'nonfinite'])('rejects a %s metric instead of inventing a zero', kind => {
    const raw = structuredClone(captured);
    const report = (raw.powerReportResponse as { powerReport: Record<string, Record<string, unknown>> }).powerReport;
    if (kind === 'absent-band') delete report.heatGeneration;
    else if (kind === 'missing') delete report.inputPower!.loadFactorResult;
    else if (kind === 'null') report.inputPower!.loadFactorResult = null;
    else if (kind === 'blank') report.inputPower!.loadFactorResult = '  ';
    else report.inputPower!.loadFactorResult = Number.POSITIVE_INFINITY;
    expect(extractPowerReport(raw)).toBeUndefined();
  });

  it('retains genuine numeric zero and accepts nonempty numeric wire strings', () => {
    const raw = structuredClone(captured);
    const report = (raw.powerReportResponse as { powerReport: Record<string, Record<string, unknown>> }).powerReport;
    report.inputPower!.idle = 0;
    report.inputPower!.loadFactorResult = '166.3';
    expect(extractPowerReport(raw)).toMatchObject({ inputPowerW: { idle: 0, loadFactor: 166.3 } });
  });
});
