import { type ReducedConfiguration } from './reduce.js';
import type { WorkspaceSession } from '../session/SessionStore.js';
/** Captured LFO hardware DTO: the CTO-only configuration fields are rejected. */
export declare function buildLfoHardwareDeriveRequest(configuration: ReducedConfiguration, workspace?: WorkspaceSession): Record<string, unknown>;
