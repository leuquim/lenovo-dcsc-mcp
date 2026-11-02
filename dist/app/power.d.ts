import type { Runtime } from './runtime.js';
/** Power and heat figures per configuration, per rack and in total, for a configuration or a whole workspace. */
export declare function powerReport(rt: Runtime, handle: string): Record<string, unknown>;
