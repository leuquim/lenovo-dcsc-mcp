import { type ReducedConfiguration } from './reduce.js';
import type { WorkspaceSession } from '../model/session.js';
import type { RawConfiguration } from '../model/types.js';
/** The website appends the SW-scope "OS & Software" tab to the HW tree when the HW response asks for it. */
export declare function mergeLfoSoftwareTab(hardware: RawConfiguration, software: RawConfiguration): RawConfiguration;
/** Captured LFO hardware DTO: the CTO-only configuration fields are rejected. */
export declare function buildLfoHardwareDeriveRequest(configuration: ReducedConfiguration, workspace?: WorkspaceSession): Record<string, unknown>;
