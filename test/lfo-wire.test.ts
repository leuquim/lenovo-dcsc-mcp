import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { buildLfoHardwareDeriveRequest } from '../src/domain/lfoWire.js';
import type { ReducedConfiguration } from '../src/domain/reduce.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { SessionStore } from '../src/session/SessionStore.js';

it('matches the complete captured LFO hardware derive envelope and physical context', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/lfo-hardware-derive.json', import.meta.url), 'utf8'));
  const input = fixture.inputConfiguration as ReducedConfiguration;
  const expected = fixture.expectedRequest;
  const store = new SessionStore();
  const raw = { id: input.id, code: input.lfoCode!, lfoCode: input.lfoCode!, quantity: 1, tabs: [] };
  const session = store.create({ locale: ConfigSchema.parse({}).locale,
    solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] }, mode: 'lfo', raw,
    configurationId: input.id, reduced: reduceConfiguration(raw, input.id, 'lfo'), primed: true });
  const workspace = store.getWorkspace(session.id)!;
  workspace.nonRackArea = structuredClone(expected.workspaceInformation.nonRackData);
  expect(buildLfoHardwareDeriveRequest(input, workspace)).toEqual(expected);
  expect(input).toEqual(fixture.inputConfiguration);
});
